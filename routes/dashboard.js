const express = require("express");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const authMiddleware = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");
const {
  LOW_STOCK_FILTER,
  OUT_OF_STOCK_FILTER,
} = require("../utils/productAvailability");
const {
  buildTimeframeFilter,
  paginationMetadata,
  parsePagination,
} = require("../utils/queryHelpers");
const {
  activityCounts,
  buildPeriodMovementPipeline,
  buildStockSeries,
  ledgerCoverage,
  normalizeFlows,
  reconcileStock,
  roundQuantity,
  seriesGranularity,
} = require("../utils/stockLedger");
const { isPieceUnitExpression, unitDimension } = require("../utils/inventoryUnits");

// Operational inventory control for administrators. Read-only: no handler in
// this file writes to any collection. Monetary reporting stays in Analytics.
const router = express.Router();
router.use(authMiddleware, isAdmin);

const CATEGORY_LIMIT = 8;
const ATTENTION_LIMIT = 6;

// Products needing action: active and at or below their minimum (0 included).
const ATTENTION_FILTER = {
  status: "active",
  $expr: {
    $or: [
      { $lte: ["$stock", 0] },
      { $and: [{ $gt: ["$minStock", 0] }, { $lte: ["$stock", "$minStock"] }] },
    ],
  },
};

const ALERT_PROJECTION = {
  name: 1,
  category: 1,
  brand: 1,
  unit: 1,
  stock: 1,
  minStock: 1,
  status: 1,
  lastStockUpdatedAt: 1,
  gap: 1,
};

// Shared stages: reorder gap, then most urgent first (ruptures, then the
// lowest stock relative to its minimum).
const ALERT_RANKING = [
  {
    $addFields: {
      gap: { $max: [{ $subtract: ["$minStock", "$stock"] }, 0] },
      coverageRatio: {
        $cond: [{ $gt: ["$minStock", 0] }, { $divide: ["$stock", "$minStock"] }, 0],
      },
    },
  },
  { $sort: { coverageRatio: 1, gap: -1, name: 1, _id: 1 } },
];

function parsePeriod(query) {
  const range = buildTimeframeFilter(query, "occurredAt").occurredAt;
  if (range.$gte > new Date()) throw new Error("La période commence dans le futur");
  return { start: range.$gte, end: range.$lte };
}

function productHealthPipeline() {
  const isPiece = isPieceUnitExpression();
  return [
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              pieces: { $sum: { $cond: [isPiece, "$stock", 0] } },
              products: { $sum: 1 },
              pieceProducts: { $sum: { $cond: [isPiece, 1, 0] } },
              untracked: {
                $sum: {
                  $cond: [
                    { $and: [isPiece, { $not: [{ $ifNull: ["$stockTrackedSince", false] }] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        catalogue: [
          {
            $group: {
              _id: null,
              active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
              inactive: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 0, 1] } },
            },
          },
        ],
        sellable: [{ $match: { status: "active", stock: { $gt: 0 } } }, { $count: "count" }],
        outOfStock: [{ $match: OUT_OF_STOCK_FILTER }, { $count: "count" }],
        lowStock: [{ $match: LOW_STOCK_FILTER }, { $count: "count" }],
        categories: [
          { $match: { $expr: isPiece } },
          { $group: { _id: "$category", pieces: { $sum: "$stock" }, products: { $sum: 1 } } },
          { $sort: { pieces: -1, _id: 1 } },
        ],
        units: [
          { $group: { _id: "$unit", products: { $sum: 1 }, quantity: { $sum: "$stock" } } },
          { $sort: { quantity: -1 } },
        ],
        attention: [
          { $match: ATTENTION_FILTER },
          ...ALERT_RANKING,
          { $limit: ATTENTION_LIMIT },
          { $project: ALERT_PROJECTION },
        ],
      },
    },
  ];
}

function countOf(facetRows) {
  return facetRows?.[0]?.count || 0;
}

function topCategories(rows = []) {
  const top = rows.slice(0, CATEGORY_LIMIT).map((row) => ({
    category: row._id || "Sans catégorie",
    pieces: roundQuantity(row.pieces),
    products: row.products,
  }));
  const rest = rows.slice(CATEGORY_LIMIT);
  if (rest.length) {
    top.push({
      category: `Autres (${rest.length})`,
      pieces: roundQuantity(rest.reduce((sum, row) => sum + row.pieces, 0)),
      products: rest.reduce((sum, row) => sum + row.products, 0),
      grouped: true,
    });
  }
  return top;
}

// GET /api/dashboard/summary?date=|from=&to=|year=&month= (default: today)
router.get("/summary", async (req, res) => {
  let period;
  try {
    period = parsePeriod(req.query);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }

  try {
    const now = new Date();
    const { start, end } = period;
    const granularity = seriesGranularity(start, end);

    const [productResult, movementResult, baselineResult] = await Promise.all([
      Product.aggregate(productHealthPipeline()),
      StockMovement.aggregate(buildPeriodMovementPipeline({
        start,
        end,
        granularity,
        metricMatch: { productUnitKey: "piece" },
      })).allowDiskUse(true),
      StockMovement.aggregate([
        { $match: { type: "baseline", productUnitKey: "piece" } },
        { $group: { _id: null, latest: { $max: "$occurredAt" } } },
      ]),
    ]);

    const products = productResult[0] || {};
    const movements = movementResult[0] || {};
    const totals = products.totals?.[0] || { pieces: 0, products: 0, pieceProducts: 0, untracked: 0 };
    const catalogue = products.catalogue?.[0] || { active: 0, inactive: 0 };

    const coverage = ledgerCoverage({
      start,
      end,
      now,
      latestBaselineAt: baselineResult[0]?.latest || null,
      untrackedProducts: totals.untracked,
    });
    const flows = normalizeFlows(movements.flows?.[0]);
    const { opening, closing } = reconcileStock({
      currentStock: totals.pieces,
      netAfterEnd: movements.afterEnd?.[0]?.net,
      flows,
    });

    res.json({
      success: true,
      source: "mongodb-aggregation",
      generatedAt: now,
      period: { start, end, granularity, endIsNow: end >= now },
      coverage,
      stock: {
        unit: "piece",
        opening: coverage.openingKnown ? opening : null,
        closing: coverage.closingKnown ? closing : null,
        current: roundQuantity(totals.pieces),
        flows: coverage.flowsAvailable ? flows : null,
      },
      // Current state of the catalogue (as of generatedAt, not the period).
      health: {
        products: totals.products,
        pieceProducts: totals.pieceProducts,
        active: catalogue.active,
        inactive: catalogue.inactive,
        sellable: countOf(products.sellable),
        outOfStock: countOf(products.outOfStock),
        lowStock: countOf(products.lowStock),
        becameOutOfStock: countOf(movements.becameOutOfStock),
      },
      activity: activityCounts(movements.activity),
      series: buildStockSeries({
        start,
        end,
        now,
        granularity,
        rows: movements.series || [],
        closing: coverage.closingKnown ? closing : null,
        coverage,
      }),
      categories: topCategories(products.categories),
      units: (products.units || []).map((row) => ({
        unit: row._id || "non renseignée",
        dimension: unitDimension(row._id),
        products: row.products,
        quantity: roundQuantity(row.quantity),
      })),
      attention: products.attention || [],
    });
  } catch (error) {
    console.error("Dashboard summary error:", error);
    res.status(500).json({ success: false, message: "Impossible de charger le tableau de bord" });
  }
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/dashboard/stock-alerts?kind=low|out|became_out&page=&limit=&search=
router.get("/stock-alerts", async (req, res) => {
  const kind = String(req.query.kind || "low");
  if (!["low", "out", "became_out"].includes(kind)) {
    return res.status(400).json({ success: false, message: "kind must be low, out or became_out" });
  }
  const { page, limit, skip } = parsePagination(req.query, 20, 100);
  const search = String(req.query.search || "").trim().slice(0, 80);

  try {
    let result;
    if (kind === "became_out") {
      // Products whose stock reached 0 during the period (from the ledger),
      // with their current state looked up for the returned page only.
      let period;
      try {
        period = parsePeriod(req.query);
      } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
      }
      result = await StockMovement.aggregate([
        {
          $match: {
            occurredAt: { $gte: period.start, $lte: period.end },
            quantity: { $lt: 0 },
            stockAfter: { $lte: 0 },
            ...(search ? { productName: { $regex: escapeRegex(search), $options: "i" } } : {}),
          },
        },
        { $sort: { occurredAt: 1, _id: 1 } },
        {
          $group: {
            _id: "$product",
            name: { $last: "$productName" },
            category: { $last: "$productCategory" },
            reachedZeroAt: { $max: "$occurredAt" },
          },
        },
        { $sort: { reachedZeroAt: -1, _id: 1 } },
        {
          $facet: {
            rows: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: Product.collection.name,
                  localField: "_id",
                  foreignField: "_id",
                  as: "current",
                },
              },
              { $addFields: { current: { $arrayElemAt: ["$current", 0] } } },
              {
                $project: {
                  name: 1,
                  category: 1,
                  reachedZeroAt: 1,
                  brand: "$current.brand",
                  unit: "$current.unit",
                  stock: "$current.stock",
                  minStock: "$current.minStock",
                  status: "$current.status",
                  deleted: { $cond: [{ $ifNull: ["$current", false] }, false, true] },
                },
              },
            ],
            total: [{ $count: "count" }],
          },
        },
      ]).allowDiskUse(true);
    } else {
      const filter = kind === "out" ? { ...OUT_OF_STOCK_FILTER } : { ...LOW_STOCK_FILTER };
      if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
      result = await Product.aggregate([
        { $match: filter },
        ...ALERT_RANKING,
        {
          $facet: {
            rows: [{ $skip: skip }, { $limit: limit }, { $project: ALERT_PROJECTION }],
            total: [{ $count: "count" }],
          },
        },
      ]);
    }

    const facet = result[0] || {};
    const total = countOf(facet.total);
    res.json({
      success: true,
      source: "mongodb-aggregation",
      kind,
      data: facet.rows || [],
      pagination: paginationMetadata(page, limit, total),
    });
  } catch (error) {
    console.error("Dashboard stock alerts error:", error);
    res.status(500).json({ success: false, message: "Impossible de charger les alertes de stock" });
  }
});

module.exports = router;
module.exports.ATTENTION_FILTER = ATTENTION_FILTER;
module.exports.productHealthPipeline = productHealthPipeline;
