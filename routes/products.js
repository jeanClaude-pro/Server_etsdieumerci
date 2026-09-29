const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const authMiddleware = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");
const { SELLABLE_PRODUCT_FILTER } = require("../utils/productAvailability");
const {
  buildTimeframeFilter,
  paginationMetadata,
  parsePagination,
} = require("../utils/queryHelpers");
const {
  StockChangeError,
  activityCounts,
  applyStockChange,
  buildPeriodMovementPipeline,
  buildStockSeries,
  normalizeFlows,
  reconcileStock,
  recordInitialStock,
  recordProductDeletion,
  roundQuantity,
  seriesGranularity,
} = require("../utils/stockLedger");
const { isTransactionUnsupported, runTransaction } = require("../utils/transaction");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendProductMutationError(res, error, fallbackMessage) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof StockChangeError) {
    const messages = {
      NOT_FOUND: [404, "Product not found"],
      INSUFFICIENT: [409, "Stock insuffisant : le stock ne peut pas devenir négatif."],
      INACTIVE: [409, "Article inactif."],
    };
    const [status, message] = messages[error.code] || [409, "Stock modifié entre-temps ; actualisez puis réessayez."];
    return res.status(status).json({ error: message });
  }
  if (isTransactionUnsupported(error)) {
    return res.status(503).json({
      error: "Les opérations de stock exigent MongoDB en replica set pour garantir l'intégrité du stock.",
    });
  }
  if (error.name === "CastError") {
    return res.status(400).json({ error: "Invalid product ID" });
  }
  if (error.name === "ValidationError") {
    const errors = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ error: errors.join(", ") });
  }
  return res.status(500).json({ error: fallbackMessage });
}

// A stock quantity typed by an administrator: finite and never negative.
function parseStockQuantity(value, fieldName = "stock") {
  const quantity = Number(value);
  if (value === "" || value === null || !Number.isFinite(quantity) || quantity < 0) {
    throw new HttpError(400, `${fieldName} must be a number greater than or equal to 0`);
  }
  return quantity;
}

// GET /api/products - Get all products with optional filtering
router.get("/", authMiddleware, async (req, res) => {
  console.log("Fetching products with filters:", req.query);
  try {
    const { search, category, status, availability } = req.query;

    // Build filter object
    const filter = {};

    if (search) {
      filter.$text = { $search: search };
    }

    if (category) {
      filter.category = category;
    }

    if (status) {
      filter.status = status;
    }

    // NewSale asks only for products that can be sold right now.
    if (availability === "sellable") {
      Object.assign(filter, SELLABLE_PRODUCT_FILTER);
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET /api/products/:id/stock-card - Fiche de stock (inventory movements only)
router.get("/:id/stock-card", authMiddleware, isAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid product ID" });
    }
    let range;
    try {
      range = buildTimeframeFilter(req.query, "occurredAt").occurredAt;
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const now = new Date();
    if (range.$gte > now) {
      return res.status(400).json({ error: "La période commence dans le futur" });
    }
    const { page, limit, skip } = parsePagination(req.query, 25, 100);
    const productId = new mongoose.Types.ObjectId(req.params.id);

    let product = await Product.findById(productId)
      .select("name category brand unit stock minStock status lastStockUpdatedAt stockTrackedSince createdAt")
      .lean();
    if (!product) {
      // Product deletion is append-only in the ledger. Rebuild enough
      // metadata from its snapshots for the historical stock card.
      const [latest, earliest] = await Promise.all([
        StockMovement.findOne({ product: productId }).sort({ occurredAt: -1, _id: -1 }).lean(),
        StockMovement.findOne({ product: productId }).sort({ occurredAt: 1, _id: 1 }).lean(),
      ]);
      if (!latest) return res.status(404).json({ error: "Product not found" });
      product = {
        _id: productId,
        name: latest.productName || "Article supprimé",
        category: latest.productCategory || "",
        brand: "",
        unit: latest.productUnit || "",
        stock: 0,
        minStock: 0,
        status: "inactive",
        lastStockUpdatedAt: latest.occurredAt,
        stockTrackedSince: earliest?.occurredAt || latest.occurredAt,
        createdAt: earliest?.occurredAt || latest.occurredAt,
        deleted: true,
      };
    }

    const granularity = seriesGranularity(range.$gte, range.$lte);
    const [periodResult, ledgerResult] = await Promise.all([
      StockMovement.aggregate(buildPeriodMovementPipeline({
        start: range.$gte,
        end: range.$lte,
        match: { product: productId },
        granularity,
        extraFacets: {
          movements: [
            { $match: { occurredAt: { $lte: range.$lte } } },
            { $sort: { occurredAt: 1, _id: 1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                type: 1, quantity: 1, stockBefore: 1, stockAfter: 1, occurredAt: 1,
                saleNumber: 1, sale: 1, userName: 1, reason: 1,
              },
            },
          ],
          movementCount: [
            { $match: { occurredAt: { $lte: range.$lte } } },
            { $count: "total" },
          ],
        },
      })),
      // Whole-ledger check for this product: Σ movements must equal its stock.
      StockMovement.aggregate([
        { $match: { product: productId } },
        {
          $group: {
            _id: null,
            total: { $sum: "$quantity" },
            baselineAt: { $max: { $cond: [{ $eq: ["$type", "baseline"] }, "$occurredAt", null] } },
          },
        },
      ]),
    ]);

    const facet = periodResult[0] || {};
    const ledger = ledgerResult[0] || null;
    const tracked = Boolean(product.stockTrackedSince);
    const baselineAt = ledger?.baselineAt || null;
    const coveredAt = (instant) => tracked && (!baselineAt || instant >= baselineAt);
    const coverage = {
      trackingStartedAt: product.stockTrackedSince || null,
      baselineAt,
      openingKnown: coveredAt(range.$gte),
      closingKnown: range.$lte >= now || coveredAt(range.$lte),
    };
    coverage.flowsComplete = coverage.openingKnown;
    coverage.flowsAvailable = coverage.openingKnown || coverage.closingKnown;

    const flows = normalizeFlows(facet.flows?.[0]);
    const { opening, closing } = reconcileStock({
      currentStock: product.stock,
      netAfterEnd: facet.afterEnd?.[0]?.net,
      flows,
    });
    const totalMovements = facet.movementCount?.[0]?.total || 0;

    res.json({
      success: true,
      source: "mongodb-aggregation",
      period: { start: range.$gte, end: range.$lte, granularity },
      product,
      summary: {
        opening: coverage.openingKnown ? opening : null,
        closing: coverage.closingKnown ? closing : null,
        flows: coverage.flowsAvailable ? flows : null,
        currentStock: product.stock,
        lastStockUpdatedAt: product.lastStockUpdatedAt || null,
      },
      coverage,
      integrity: {
        ledgerStock: ledger ? roundQuantity(ledger.total) : null,
        consistent: tracked && ledger ? roundQuantity(ledger.total) === roundQuantity(product.stock) : null,
      },
      activity: activityCounts(facet.activity),
      series: buildStockSeries({
        start: range.$gte,
        end: range.$lte,
        now,
        granularity,
        rows: facet.series || [],
        closing: coverage.closingKnown ? closing : null,
        coverage,
      }),
      movements: facet.movements || [],
      pagination: paginationMetadata(page, limit, totalMovements),
    });
  } catch (error) {
    console.error("Error building stock card:", error);
    res.status(500).json({ error: "Impossible de charger la fiche de stock" });
  }
});

// GET /api/products/:id - Get a single product by ID
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(product);
  } catch (error) {
    console.error("Error fetching product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// POST /api/products - Create a new product
router.post("/", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      price,
      stock,
      minStock,
      unit,
      weight,
      status,
    } = req.body;

    // Validate required fields
    if (!name || !category) {
      return res.status(400).json({
        error: "Name and category are required fields",
      });
    }

    const savedProduct = await runTransaction(async (session) => {
      const at = new Date();
      const product = new Product({
        name,
        description: description || "",
        category,
        brand: brand || "",
        price: Number(price) || 0,
        stock: parseStockQuantity(stock ?? 0),
        minStock: Number(minStock) || 0,
        unit: unit || "pcs",
        weight: Number(weight) || 0,
        status: status || "active",
        stockTrackedSince: at,
        lastStockUpdatedAt: at,
      });
      const saved = await product.save({ session });
      await recordInitialStock(saved, { session, user: req.user, at });
      return saved;
    });
    res.status(201).json(savedProduct);
  } catch (error) {
    console.error("Error creating product:", error);
    return sendProductMutationError(res, error, "Failed to create product");
  }
});

// POST /api/products/:id/stock-movements - Replenishment or correction.
// Relative and atomic: never overwrites a concurrent sale.
router.post("/:id/stock-movements", authMiddleware, isAdmin, async (req, res) => {
  try {
    const type = String(req.body?.type || "");
    const quantity = Number(req.body?.quantity);
    const reason = String(req.body?.reason || "").trim().slice(0, 300);

    if (!["restock", "adjustment"].includes(type)) {
      return res.status(400).json({ error: "type must be restock or adjustment" });
    }
    if (!Number.isFinite(quantity) || quantity === 0) {
      return res.status(400).json({ error: "quantity must be a non-zero number" });
    }
    if (type === "restock" && quantity < 0) {
      return res.status(400).json({ error: "Une entrée de stock doit être positive" });
    }
    if (type === "adjustment" && reason.length < 3) {
      return res.status(400).json({ error: "La raison de la correction est obligatoire" });
    }

    const product = await runTransaction(async (session) => {
      await applyStockChange({
        productId: req.params.id,
        quantity,
        type,
        session,
        user: req.user,
        reason: reason || (type === "restock" ? "Réapprovisionnement" : ""),
      });
      return Product.findById(req.params.id).session(session);
    });
    res.status(201).json(product);
  } catch (error) {
    console.error("Error recording stock movement:", error);
    return sendProductMutationError(res, error, "Failed to record stock movement");
  }
});

// PUT /api/products/:id - Update a product
router.put("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      price,
      stock,
      expectedStock,
      stockReason,
      minStock,
      unit,
      weight,
      status,
    } = req.body;

    // Build update object with only provided fields
    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (brand !== undefined) updateData.brand = brand;
    if (price !== undefined) updateData.price = Number(price);
    if (minStock !== undefined) updateData.minStock = Number(minStock);
    if (unit !== undefined) updateData.unit = unit;
    if (weight !== undefined) updateData.weight = Number(weight);
    if (status !== undefined) updateData.status = status;

    const nextStock = stock === undefined ? undefined : parseStockQuantity(stock);

    const updatedProduct = await runTransaction(async (session) => {
      const current = await Product.findById(req.params.id).session(session).lean();
      if (!current) throw new HttpError(404, "Product not found");

      if (Object.keys(updateData).length > 0) {
        if (unit !== undefined && String(unit) !== String(current.unit)) {
          throw new HttpError(409, "L'unité d'un article suivi ne peut pas être modifiée ; créez un nouvel article avec la bonne unité.");
        }
        await Product.findOneAndUpdate({ _id: current._id }, updateData, {
          runValidators: true,
          session,
        });
      }

      // The form sends an absolute quantity. It becomes a signed ledger
      // correction; `expectedStock` (the value shown when the form opened)
      // rejects the edit if a sale changed the stock meanwhile, instead of
      // silently overwriting it.
      if (nextStock !== undefined && nextStock !== current.stock) {
        if (expectedStock === undefined || !Number.isFinite(Number(expectedStock))) {
          throw new HttpError(409, "Le stock doit être modifié avec sa valeur attendue. Actualisez puis réessayez.");
        }
        if (Number(expectedStock) !== current.stock) {
          throw new HttpError(
            409,
            `Le stock a changé pendant la modification (actuel : ${current.stock}). Actualisez puis réessayez.`
          );
        }
        await applyStockChange({
          productId: current._id,
          quantity: nextStock - current.stock,
          type: "adjustment",
          session,
          user: req.user,
          reason: String(stockReason || "").trim().slice(0, 300) || "Correction depuis la fiche article",
        });
      }

      return Product.findById(current._id).session(session);
    });

    res.json(updatedProduct);
  } catch (error) {
    console.error("Error updating product:", error);
    return sendProductMutationError(res, error, "Failed to update product");
  }
});

// DELETE /api/products/:id - Delete a product
router.delete("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const deletedProduct = await runTransaction(async (session) => {
      const deleted = await Product.findOneAndDelete({ _id: req.params.id }, { session }).lean();
      if (!deleted) return null;
      // The ledger keeps the product's history and removes its pieces from
      // the inventory total at the moment of deletion.
      await recordProductDeletion(deleted, { session, user: req.user, at: new Date() });
      return deleted;
    });

    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting product:", error);
    return sendProductMutationError(res, error, "Failed to delete product");
  }
});

module.exports = router;
