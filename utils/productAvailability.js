// Single definition of "can this product be sold" and of the stock-health
// classes. Routes, aggregations and tests import these instead of restating
// the conditions. The client mirrors isProductSellable in
// jean-client/src/utils/productAvailability.ts for display only; the server
// filters below remain authoritative.

// Sellable = manually active AND at least one piece in stock. Product.status
// is never changed automatically, so a sold-out product becomes sellable
// again when restocked unless an administrator deactivated it.
const SELLABLE_PRODUCT_FILTER = Object.freeze({ status: "active", stock: { $gt: 0 } });

// Health classes only consider the active catalogue: a product an
// administrator withdrew is not an operational alert. The two classes are
// disjoint: "out" is exactly 0 pieces, "low" is 1..minStock pieces. A product
// with no minimum (minStock 0) is never "low".
const OUT_OF_STOCK_FILTER = Object.freeze({ status: "active", stock: { $lte: 0 } });
const LOW_STOCK_FILTER = Object.freeze({
  status: "active",
  stock: { $gt: 0 },
  minStock: { $gt: 0 },
  $expr: { $lte: ["$stock", "$minStock"] },
});

function isProductSellable(product) {
  return product?.status === "active" && Number(product?.stock) > 0;
}

function stockHealth(product) {
  const stock = Number(product?.stock) || 0;
  const minStock = Number(product?.minStock) || 0;
  if (stock <= 0) return "out";
  if (minStock > 0 && stock <= minStock) return "low";
  return "ok";
}

module.exports = {
  LOW_STOCK_FILTER,
  OUT_OF_STOCK_FILTER,
  SELLABLE_PRODUCT_FILTER,
  isProductSellable,
  stockHealth,
};
