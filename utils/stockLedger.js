const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const { BUSINESS_TIMEZONE, businessDateEnd, businessDateStart } = require("./queryHelpers");
const { unitDimension } = require("./inventoryUnits");

// ---------------------------------------------------------------------------
// Movement classes — the single definition shared by the Dashboard and the
// fiche de stock.
//
//   closing = opening + baseline + entries + returns − piecesOut
//             + adjustmentsIn − adjustmentsOut
//
// Sale-linked movements are netted per (sale, product) inside the period, so
// a sale that is voided or deleted within the same period moves no pieces at
// all (it is never counted, rather than counted then subtracted), a sale
// edited within the period counts only its final quantity, and a void of an
// earlier sale is a return.
// ---------------------------------------------------------------------------
const SALE_MOVEMENT_TYPES = ["sale", "sale_edit", "sale_void", "sale_delete"];
const ENTRY_MOVEMENT_TYPES = ["initial", "restock"];
const ADJUSTMENT_MOVEMENT_TYPES = ["adjustment", "product_delete"];

const BASELINE_REASON = "Solde de reprise : stock existant au début du suivi";
const SERIES_DAY_LIMIT = 62;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_UTC_OFFSET_MS = 2 * 60 * 60 * 1000;

class StockChangeError extends Error {
  constructor(code, product = null) {
    super(code);
    this.name = "StockChangeError";
    // NOT_FOUND | INACTIVE | INSUFFICIENT
    this.code = code;
    this.product = product;
  }
}

function roundQuantity(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

function actorFields(user) {
  if (!user) return { user: null, userName: null };
  return { user: user._id || user.id || null, userName: user.username || null };
}

function snapshotFields(product, at) {
  return {
    product: product._id,
    productName: product.name || "",
    productCategory: product.category || "",
    productUnit: product.unit || "",
    productUnitKey: unitDimension(product.unit),
    occurredAt: at,
  };
}

function baselineMovement(product, at) {
  return {
    ...snapshotFields(product, at),
    type: "baseline",
    quantity: product.stock,
    stockBefore: 0,
    stockAfter: product.stock,
    reason: BASELINE_REASON,
  };
}

/**
 * Atomically changes one product's stock by `quantity` (signed) and appends
 * the matching ledger movement(s) in the caller's transaction.
 *
 * The conditional $inc is the concurrency guard: a decrement only matches
 * while enough pieces remain, so two concurrent sales can never oversell and
 * no read-modify-save window exists. `requireActive` additionally refuses to
 * consume stock of a product an administrator deactivated.
 *
 * A product that predates the ledger gets its baseline (its stock just before
 * this change) written first, in the same transaction.
 */
async function applyStockChange({
  productId,
  quantity,
  type,
  session,
  sale = null,
  user = null,
  reason = "",
  requireActive = false,
  at = new Date(),
}) {
  const delta = Number(quantity);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new TypeError("A stock change needs a non-zero finite quantity");
  }
  if (!session) throw new TypeError("Stock changes must run inside a transaction");

  const filter = { _id: productId };
  if (delta < 0) filter.stock = { $gte: -delta };
  if (requireActive) filter.status = "active";

  const before = await Product.findOneAndUpdate(
    filter,
    {
      $inc: { stock: delta },
      $set: { lastStockUpdatedAt: at },
      // Sets the field only when it is absent (legacy product).
      $min: { stockTrackedSince: at },
    },
    {
      new: false,
      session,
      projection: { name: 1, category: 1, unit: 1, stock: 1, status: 1, stockTrackedSince: 1 },
    }
  ).lean();

  if (!before) {
    const current = await Product.findById(productId)
      .select("name status stock")
      .session(session)
      .lean();
    const code = !current
      ? "NOT_FOUND"
      : requireActive && current.status !== "active"
        ? "INACTIVE"
        : "INSUFFICIENT";
    throw new StockChangeError(code, current);
  }

  const movements = [];
  if (!before.stockTrackedSince) movements.push(baselineMovement(before, at));
  movements.push({
    ...snapshotFields(before, at),
    ...actorFields(user),
    type,
    quantity: delta,
    stockBefore: before.stock,
    stockAfter: before.stock + delta,
    sale: sale?._id ?? null,
    saleNumber: sale?.saleNumber ?? null,
    reason,
  });
  await StockMovement.insertMany(movements, { session });

  return { ...before, stock: before.stock + delta, lastStockUpdatedAt: at };
}

/** Ledger entry for a product created (in `session`) with its opening stock. */
async function recordInitialStock(product, { session, user = null, at }) {
  await StockMovement.insertMany([{
    ...snapshotFields(product, at),
    ...actorFields(user),
    type: "initial",
    quantity: product.stock,
    stockBefore: 0,
    stockAfter: product.stock,
    reason: "Stock saisi à la création de l'article",
  }], { session });
}

/** Ledger entry writing off the remaining stock of a deleted product. */
async function recordProductDeletion(product, { session, user = null, at }) {
  const movements = [];
  if (!product.stockTrackedSince) movements.push(baselineMovement(product, at));
  movements.push({
    ...snapshotFields(product, at),
    ...actorFields(user),
    type: "product_delete",
    quantity: product.stock ? -product.stock : 0,
    stockBefore: product.stock,
    stockAfter: 0,
    reason: "Article supprimé : stock restant retiré",
  });
  await StockMovement.insertMany(movements, { session });
}

/**
 * Records the baseline of every product the ledger does not cover yet
 * (products created before the ledger existed, or inserted directly into the
 * database). Idempotent: the conditional update and the unique partial index
 * guarantee one baseline per product even if it runs twice concurrently.
 * Never changes a stock value.
 */
async function ensureStockBaselines({ runTransaction, logger = console } = {}) {
  let created = 0;
  let failed = 0;
  const cursor = Product.find({ stockTrackedSince: null }).select("_id").lean().cursor();
  for await (const { _id } of cursor) {
    try {
      const recorded = await runTransaction(async (session) => {
        const at = new Date();
        const product = await Product.findOneAndUpdate(
          { _id, stockTrackedSince: null },
          { $set: { stockTrackedSince: at } },
          { new: false, session, timestamps: false, projection: { name: 1, category: 1, unit: 1, stock: 1 } }
        ).lean();
        if (!product) return false;
        await StockMovement.insertMany([baselineMovement(product, at)], { session });
        return true;
      });
      if (recorded) created += 1;
    } catch (error) {
      failed += 1;
      logger.error(`Stock baseline failed for product ${_id}: ${error.message}`);
    }
  }
  return { created, failed };
}

// ---------------------------------------------------------------------------
// Read side: aggregation stages and reconciliation.
// ---------------------------------------------------------------------------

const isSaleMovement = { $in: ["$type", SALE_MOVEMENT_TYPES] };
const positivePart = (expression) => ({ $cond: [{ $gt: [expression, 0] }, expression, 0] });
const negativePart = (expression) => ({ $cond: [{ $lt: [expression, 0] }, { $multiply: [expression, -1] }, 0] });

/** Stages reducing movements (already limited to the period) to one flows row. */
function periodFlowStages() {
  return [
    {
      $group: {
        _id: {
          $cond: [
            isSaleMovement,
            { sale: "$sale", product: "$product" },
            { type: "$type", sign: { $cmp: ["$quantity", 0] } },
          ],
        },
        saleLinked: { $first: isSaleMovement },
        type: { $first: "$type" },
        net: { $sum: "$quantity" },
      },
    },
    {
      $group: {
        _id: null,
        baseline: { $sum: { $cond: [{ $eq: ["$type", "baseline"] }, "$net", 0] } },
        entries: { $sum: { $cond: [{ $in: ["$type", ENTRY_MOVEMENT_TYPES] }, "$net", 0] } },
        newProducts: { $sum: { $cond: [{ $eq: ["$type", "initial"] }, "$net", 0] } },
        piecesOut: { $sum: { $cond: ["$saleLinked", negativePart("$net"), 0] } },
        returns: { $sum: { $cond: ["$saleLinked", positivePart("$net"), 0] } },
        adjustmentsIn: {
          $sum: { $cond: [{ $in: ["$type", ADJUSTMENT_MOVEMENT_TYPES] }, positivePart("$net"), 0] },
        },
        adjustmentsOut: {
          $sum: { $cond: [{ $in: ["$type", ADJUSTMENT_MOVEMENT_TYPES] }, negativePart("$net"), 0] },
        },
        net: { $sum: "$net" },
      },
    },
  ];
}

/**
 * Reduces the period ledger to one row per product that had a net sale.
 * Sale edits, voids and deletions are netted per (sale, product), exactly as
 * in periodFlowStages. Quantities stay separated by product, so products
 * measured in packs, kg, lbs, etc. are never added to piece totals.
 */
function soldProductFlowStages() {
  return [
    { $sort: { occurredAt: 1, _id: 1 } },
    {
      $group: {
        _id: {
          $cond: [
            isSaleMovement,
            { sale: "$sale", product: "$product" },
            { movement: "$_id", product: "$product" },
          ],
        },
        product: { $first: "$product" },
        productName: { $last: "$productName" },
        productCategory: { $last: "$productCategory" },
        productUnit: { $last: "$productUnit" },
        productUnitKey: { $last: "$productUnitKey" },
        saleLinked: { $first: isSaleMovement },
        type: { $first: "$type" },
        net: { $sum: "$quantity" },
        lastOccurredAt: { $max: "$occurredAt" },
      },
    },
    { $sort: { product: 1, lastOccurredAt: 1 } },
    {
      $group: {
        _id: "$product",
        name: { $last: "$productName" },
        category: { $last: "$productCategory" },
        unit: { $last: "$productUnit" },
        unitKey: { $last: "$productUnitKey" },
        baseline: { $sum: { $cond: [{ $eq: ["$type", "baseline"] }, "$net", 0] } },
        entries: { $sum: { $cond: [{ $in: ["$type", ENTRY_MOVEMENT_TYPES] }, "$net", 0] } },
        newProducts: { $sum: { $cond: [{ $eq: ["$type", "initial"] }, "$net", 0] } },
        piecesOut: { $sum: { $cond: ["$saleLinked", negativePart("$net"), 0] } },
        returns: { $sum: { $cond: ["$saleLinked", positivePart("$net"), 0] } },
        adjustmentsIn: {
          $sum: { $cond: [{ $in: ["$type", ADJUSTMENT_MOVEMENT_TYPES] }, positivePart("$net"), 0] },
        },
        adjustmentsOut: {
          $sum: { $cond: [{ $in: ["$type", ADJUSTMENT_MOVEMENT_TYPES] }, negativePart("$net"), 0] },
        },
        net: { $sum: "$net" },
      },
    },
    { $match: { piecesOut: { $gt: 0 } } },
    {
      $lookup: {
        from: Product.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "currentProduct",
      },
    },
    { $set: { currentStock: { $arrayElemAt: ["$currentProduct.stock", 0] } } },
    { $project: { currentProduct: 0 } },
    { $sort: { piecesOut: -1, name: 1, _id: 1 } },
  ];
}

const EMPTY_FLOWS = Object.freeze({
  baseline: 0,
  entries: 0,
  newProducts: 0,
  piecesOut: 0,
  returns: 0,
  adjustmentsIn: 0,
  adjustmentsOut: 0,
  net: 0,
});

function normalizeFlows(row) {
  const flows = {};
  for (const key of Object.keys(EMPTY_FLOWS)) flows[key] = roundQuantity(row?.[key]);
  return flows;
}

function businessKey(date, granularity) {
  const shifted = new Date(date.getTime() + BUSINESS_UTC_OFFSET_MS).toISOString();
  return granularity === "month" ? shifted.slice(0, 7) : shifted.slice(0, 10);
}

function seriesGranularity(start, end) {
  return end.getTime() - start.getTime() < SERIES_DAY_LIMIT * DAY_MS ? "day" : "month";
}

function bucketEnd(key, granularity) {
  if (granularity === "day") return businessDateEnd(key);
  const [year, month] = key.split("-").map(Number);
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return new Date(businessDateStart(next).getTime() - 1);
}

/** Every bucket key from the period start to its end (or now, if earlier). */
function seriesKeys(start, end, now, granularity) {
  const last = businessKey(end < now ? end : now, granularity);
  const keys = [];
  let cursor = new Date(start.getTime());
  let key = businessKey(cursor, granularity);
  while (key <= last) {
    keys.push(key);
    cursor = new Date(bucketEnd(key, granularity).getTime() + 1);
    key = businessKey(cursor, granularity);
  }
  return keys;
}

/**
 * Pipeline over the ledger for the period [start, end]. One index range scan
 * from `start` feeds every facet; the movements after `end` are only summed
 * (closing = current stock − net change after the period).
 */
function buildPeriodMovementPipeline({ start, end, match = {}, metricMatch = {}, granularity, extraFacets = {} }) {
  const inPeriod = { $match: { ...metricMatch, occurredAt: { $lte: end } } };
  return [
    { $match: { ...match, occurredAt: { $gte: start } } },
    {
      $facet: {
        afterEnd: [
          { $match: { ...metricMatch, occurredAt: { $gt: end } } },
          { $group: { _id: null, net: { $sum: "$quantity" } } },
        ],
        flows: [inPeriod, ...periodFlowStages()],
        series: [
          inPeriod,
          {
            $group: {
              _id: {
                $dateToString: {
                  format: granularity === "month" ? "%Y-%m" : "%Y-%m-%d",
                  date: "$occurredAt",
                  timezone: BUSINESS_TIMEZONE,
                },
              },
              net: { $sum: "$quantity" },
            },
          },
          { $sort: { _id: 1 } },
        ],
        activity: [
          inPeriod,
          { $match: { type: { $ne: "baseline" } } },
          { $group: { _id: "$type", count: { $sum: 1 } } },
        ],
        becameOutOfStock: [
          inPeriod,
          { $match: { quantity: { $lt: 0 }, stockAfter: { $lte: 0 } } },
          { $group: { _id: "$product" } },
          { $count: "count" },
        ],
        ...extraFacets,
      },
    },
  ];
}

/**
 * Opening/closing from the current stock and the ledger. Every stock write
 * commits its movement in the same transaction, so
 *   stock(t) = Σ movements ≤ t = current stock − Σ movements > t,
 * and the second form only reads movements from the period start onward.
 */
function reconcileStock({ currentStock, netAfterEnd, flows }) {
  const closing = roundQuantity(currentStock - (netAfterEnd || 0));
  const opening = roundQuantity(closing - flows.net);
  return { opening, closing };
}

/**
 * What the ledger can prove for [start, end]. Before a baseline the history of
 * that product is unknown, so a period starting earlier has no exact opening.
 */
function ledgerCoverage({ start, end, now, latestBaselineAt, untrackedProducts = 0 }) {
  const trackedAt = (instant) =>
    untrackedProducts === 0 && (!latestBaselineAt || instant >= latestBaselineAt);
  const openingKnown = trackedAt(start);
  const closingKnown = end >= now || trackedAt(end);
  return {
    trackingStartedAt: latestBaselineAt || null,
    untrackedProducts,
    openingKnown,
    closingKnown,
    // Movements in the period are complete only if the period starts after
    // tracking began; otherwise they only cover the tracked part.
    flowsComplete: openingKnown,
    flowsAvailable: openingKnown || closingKnown,
  };
}

/** End-of-bucket stock levels, walked backwards from the closing stock. */
function buildStockSeries({ start, end, now, granularity, rows, closing, coverage }) {
  const netByKey = new Map(rows.map((row) => [row._id, row.net]));
  const keys = seriesKeys(start, end, now, granularity);
  const series = keys.map((key) => ({ key, net: roundQuantity(netByKey.get(key)), level: null }));
  if (closing === null) return series;
  let level = closing;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const bucket = series[index];
    const known =
      coverage.openingKnown ||
      (coverage.trackingStartedAt && bucketEnd(bucket.key, granularity) >= coverage.trackingStartedAt);
    bucket.level = known ? roundQuantity(level) : null;
    level -= bucket.net;
  }
  return series;
}

function activityCounts(rows = []) {
  const counts = {};
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

module.exports = {
  ADJUSTMENT_MOVEMENT_TYPES,
  BASELINE_REASON,
  EMPTY_FLOWS,
  ENTRY_MOVEMENT_TYPES,
  SALE_MOVEMENT_TYPES,
  StockChangeError,
  activityCounts,
  applyStockChange,
  buildPeriodMovementPipeline,
  buildStockSeries,
  ensureStockBaselines,
  ledgerCoverage,
  normalizeFlows,
  periodFlowStages,
  reconcileStock,
  recordInitialStock,
  recordProductDeletion,
  roundQuantity,
  seriesGranularity,
  seriesKeys,
  soldProductFlowStages,
};
