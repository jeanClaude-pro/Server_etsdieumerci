const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAmountSnapshot,
  normalizeSaleItemPricing,
} = require("../utils/salePricing");

test("preserves 12000 FC exactly and derives USD without rounding", () => {
  const price = normalizeSaleItemPricing(
    {
      price: 4.21,
      enteredPrice: 12000,
      enteredCurrency: "FC",
      priceUSD: 4.21,
      priceFC: 11999,
    },
    2850
  );

  assert.equal(price.enteredPrice, 12000);
  assert.equal(price.priceFC, 12000);
  assert.equal(price.priceUSD, 12000 / 2850);
  assert.equal(price.exchangeRate, 2850);
  assert.equal(price.enteredPrice * 3, 36000);
  assert.equal(price.priceUSD.toFixed(2), "4.21");

  // Reprinting never consults a later rate; it uses the stored USD snapshot.
  const tomorrowRate = 2900;
  assert.notEqual(price.priceUSD, price.enteredPrice / tomorrowRate);
  assert.equal(price.priceUSD.toFixed(2), "4.21");
});

test("preserves an irregular 12347 FC price exactly", () => {
  const price = normalizeSaleItemPricing(
    { enteredPrice: 12347, enteredCurrency: "FC" },
    2850
  );

  assert.equal(price.priceFC, 12347);
  assert.equal(price.enteredPrice * 3, 37041);
});

test("preserves integer and decimal USD prices exactly", () => {
  const integerPrice = normalizeSaleItemPricing(
    { enteredPrice: 10, enteredCurrency: "USD" },
    2850
  );
  const decimalPrice = normalizeSaleItemPricing(
    { enteredPrice: 10.5, enteredCurrency: "USD" },
    2850
  );

  assert.equal(integerPrice.priceUSD, 10);
  assert.equal(integerPrice.priceFC, 28500);
  assert.equal(decimalPrice.priceUSD, 10.5);
  assert.equal(decimalPrice.priceFC, 29925);
});

test("keeps legacy USD-only items backward compatible", () => {
  assert.deepEqual(normalizeSaleItemPricing({ price: 7.25 }), { price: 7.25 });
});

test("entry and expense snapshots preserve an exact FC amount", () => {
  const snapshot = normalizeAmountSnapshot({
    enteredAmount: 36000,
    enteredCurrency: "FC",
    exchangeRate: 2850,
  });

  assert.equal(snapshot.amountFC, 36000);
  assert.equal(snapshot.enteredAmount, 36000);
  assert.equal(snapshot.amountUSD, 36000 / 2850);
  assert.equal(snapshot.amount, 36000 / 2850);
});
