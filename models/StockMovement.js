const mongoose = require("mongoose");

// Append-only inventory ledger. Every change to Product.stock is written here
// in the same MongoDB transaction as the $inc, so for any product
//   Product.stock === Σ quantity of its movements
// and the stock at any past instant is the sum of the movements up to it.
// Movements are never updated or deleted by the application.
const STOCK_MOVEMENT_TYPES = [
  // Opening balance recorded when tracking starts for a product that already
  // existed (its earlier history is unknown). Not a physical movement.
  "baseline",
  // Quantity entered when the product was created.
  "initial",
  // Replenishment (entrée de stock).
  "restock",
  // Pieces leaving with a sale.
  "sale",
  // Stock delta caused by editing a sale (either sign).
  "sale_edit",
  // Stock returned when a sale is voided.
  "sale_void",
  // Stock returned when a non-voided sale is deleted.
  "sale_delete",
  // Manual correction (inventory count, loss, breakage…), either sign.
  "adjustment",
  // Remaining stock written off when a product is deleted.
  "product_delete",
];

const stockMovementSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    // Snapshots so the ledger stays readable after a rename or deletion.
    productName: { type: String, default: "" },
    productCategory: { type: String, default: "" },
    productUnit: { type: String, default: "" },
    // Stable dimension used by aggregate KPIs. The original label above is
    // retained so reports show the actual unit used by the product.
    productUnitKey: { type: String, default: "unspecified" },
    type: { type: String, enum: STOCK_MOVEMENT_TYPES, required: true },
    // Signed change applied to Product.stock.
    quantity: { type: Number, required: true },
    stockBefore: { type: Number, required: true },
    stockAfter: { type: Number, required: true, min: 0 },
    occurredAt: { type: Date, required: true, default: Date.now },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: "Sale", default: null },
    saleNumber: { type: String, default: null },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    userName: { type: String, default: null },
    reason: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Fiche de stock: one product's movements in a period, chronologically, and
// its net change after an instant (opening/closing reconstruction).
stockMovementSchema.index({ product: 1, occurredAt: 1 });
// Dashboard: every movement from the period start onward.
stockMovementSchema.index({ occurredAt: 1 });
stockMovementSchema.index({ productUnitKey: 1, occurredAt: 1 });
stockMovementSchema.index({ type: 1, productUnitKey: 1, occurredAt: 1 });
// At most one tracking baseline per product, even under concurrent writers.
stockMovementSchema.index(
  { product: 1 },
  { unique: true, partialFilterExpression: { type: "baseline" }, name: "unique_baseline_per_product" }
);

const StockMovement =
  mongoose.models.StockMovement || mongoose.model("StockMovement", stockMovementSchema);

module.exports = StockMovement;
module.exports.STOCK_MOVEMENT_TYPES = STOCK_MOVEMENT_TYPES;
