const test = require("node:test");
const assert = require("node:assert/strict");
const { Query } = require("mingo");
const {
  LOW_STOCK_FILTER,
  OUT_OF_STOCK_FILTER,
  SELLABLE_PRODUCT_FILTER,
  isProductSellable,
  stockHealth,
} = require("../utils/productAvailability");

const product = (stock, minStock = 0, status = "active") => ({ stock, minStock, status });
const matches = (filter, doc) => new Query(filter).test(doc);

test("a product is sellable only when active with at least one piece", () => {
  assert.equal(isProductSellable(product(1)), true);
  assert.equal(isProductSellable(product(0)), false);
  assert.equal(isProductSellable(product(-1)), false);
  assert.equal(isProductSellable(product(25, 0, "inactive")), false, "manual deactivation wins over stock");
  assert.equal(isProductSellable(null), false);
});

test("stock health: 0 is out, 1..minimum is low (inclusive), no minimum is never low", () => {
  assert.equal(stockHealth(product(0, 10)), "out");
  assert.equal(stockHealth(product(-3, 10)), "out");
  assert.equal(stockHealth(product(1, 10)), "low");
  assert.equal(stockHealth(product(10, 10)), "low");
  assert.equal(stockHealth(product(11, 10)), "ok");
  assert.equal(stockHealth(product(1, 0)), "ok");
  assert.equal(stockHealth(product(1)), "ok");
});

test("MongoDB filters agree with the JavaScript rules on every edge case", () => {
  const cases = [];
  for (const status of ["active", "inactive"]) {
    for (const stock of [-1, 0, 1, 9, 10, 11]) {
      for (const minStock of [0, 10]) cases.push(product(stock, minStock, status));
    }
  }
  for (const doc of cases) {
    const label = JSON.stringify(doc);
    assert.equal(matches(SELLABLE_PRODUCT_FILTER, doc), isProductSellable(doc), label);
    const active = doc.status === "active";
    assert.equal(matches(OUT_OF_STOCK_FILTER, doc), active && stockHealth(doc) === "out", label);
    assert.equal(matches(LOW_STOCK_FILTER, doc), active && stockHealth(doc) === "low", label);
    assert.ok(!(matches(OUT_OF_STOCK_FILTER, doc) && matches(LOW_STOCK_FILTER, doc)), `disjoint ${label}`);
  }
});
