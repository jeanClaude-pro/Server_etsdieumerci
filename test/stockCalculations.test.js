const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStockAdjustments } = require("../utils/stockCalculations");

test("sale edit aggregates duplicate product lines before changing stock", () => {
  const adjustments = buildStockAdjustments(
    [{ productId: "A", quantity: 3 }],
    [
      { productId: "A", quantity: 5 },
      { productId: "A", quantity: 3 },
    ]
  );
  assert.deepEqual(adjustments, [{ productId: "A", adjustment: -5 }]);
});

test("removed items return stock and new items consume stock", () => {
  const adjustments = buildStockAdjustments(
    [{ productId: "A", quantity: 2 }],
    [{ productId: "B", quantity: 4 }]
  );
  assert.deepEqual(adjustments, [
    { productId: "A", adjustment: 2 },
    { productId: "B", adjustment: -4 },
  ]);
});
