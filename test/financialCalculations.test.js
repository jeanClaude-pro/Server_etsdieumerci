const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateNetCash,
  calculateValidationRate,
  percentChange,
} = require("../utils/financialCalculations");

test("net cash subtracts validated expenses only", () => {
  const salesRevenue = 10 + 20;
  const activeEntries = 5;
  const expenses = [
    { amount: 9, status: "pending" },
    { amount: 4, status: "validated" },
    { amount: 7, status: "rejected" },
  ];
  const validatedExpenses = expenses
    .filter((expense) => expense.status === "validated")
    .reduce((sum, expense) => sum + expense.amount, 0);

  assert.equal(calculateNetCash(salesRevenue, activeEntries, validatedExpenses), 31);
});

test("validation rate is validated count divided by all matching expenses", () => {
  assert.ok(Math.abs(calculateValidationRate(1, 3) - 100 / 3) < 1e-12);
  assert.equal(calculateValidationRate(0, 0), 0);
});

test("growth is unavailable without a non-zero comparison period", () => {
  assert.equal(percentChange(10, 0), null);
  assert.equal(percentChange(15, 10), 50);
});
