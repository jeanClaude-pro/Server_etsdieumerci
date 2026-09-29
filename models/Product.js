const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },

    category: {
      type: String,
      required: true,
    },
    brand: {
      type: String,
      default: "",
    },
    price: {
      type: Number,
      min: 0,
      default: 0,
    },
    stock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    minStock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    unit: {
      type: String,
      required: true,
      default: "pcs",
    },
    weight: {
      type: Number,
      default: 0,
    },
    // Manual catalogue status set by an administrator. It is never changed
    // automatically: a product is sellable only when it is "active" AND has
    // stock > 0 (see utils/productAvailability.js), so a sold-out product is
    // unavailable without losing the administrator's own decision.
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    // Time of the last actual quantity change (updatedAt also moves when the
    // name, price, category… are edited). Maintained by utils/stockLedger.js.
    lastStockUpdatedAt: {
      type: Date,
    },
    // When the stock ledger started covering this product. Absent on products
    // created before the ledger existed until their baseline is recorded.
    stockTrackedSince: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Create index for better search performance
productSchema.index({ name: "text", description: "text", brand: "text" });
productSchema.index({ category: 1 });
productSchema.index({ status: 1, createdAt: -1 });

// Reuse if it already exists (prevents OverwriteModelError)
const Product =
  mongoose.models.Product || mongoose.model("Product", productSchema);

module.exports = Product;
