const test = require("node:test");
const assert = require("node:assert/strict");
const { Aggregator } = require("mingo");
const { buildTimeframeFilter } = require("../utils/queryHelpers");
const {
  buildPeriodMovementPipeline,
  buildStockSeries,
  ledgerCoverage,
  normalizeFlows,
  reconcileStock,
  seriesGranularity,
  seriesKeys,
} = require("../utils/stockLedger");

// The pipelines built by utils/stockLedger.js are executed as-is by mingo, a
// JavaScript implementation of the MongoDB aggregation language. The
// replica-set integration suite (npm run test:integration) runs the same
// pipelines on a real mongod.

const period = (query) => {
  const range = buildTimeframeFilter(query, "occurredAt").occurredAt;
  return { start: range.$gte, end: range.$lte };
};

let sequence = 0;
function movement(type, quantity, occurredAt, extra = {}) {
  sequence += 1;
  return { _id: `m${sequence}`, product: "A", type, quantity, occurredAt: new Date(occurredAt), stockAfter: 1, sale: null, ...extra };
}

function summarize(movements, { start, end, currentStock, now = new Date("2026-12-31T00:00:00Z") }) {
  const granularity = seriesGranularity(start, end);
  const [facet] = new Aggregator(buildPeriodMovementPipeline({ start, end, granularity })).run(movements);
  const flows = normalizeFlows(facet.flows[0]);
  const { opening, closing } = reconcileStock({ currentStock, netAfterEnd: facet.afterEnd[0]?.net, flows });
  return { facet, flows, opening, closing, granularity, now };
}

function assertBalanced({ opening, closing, flows }) {
  const rebuilt = opening + flows.baseline + flows.entries + flows.returns - flows.piecesOut +
    flows.adjustmentsIn - flows.adjustmentsOut;
  assert.equal(Math.round(rebuilt * 1e6) / 1e6, closing, "closing = opening + in − out ± adjustments");
}

test("opening 100, +20 entries, 8 sold, 2 removed by correction → closing 110", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("baseline", 100, "2026-09-01T08:00:00Z"),
    movement("restock", 20, "2026-09-28T07:00:00Z"),
    movement("sale", -8, "2026-09-28T09:00:00Z", { sale: "S1" }),
    movement("adjustment", -2, "2026-09-28T15:00:00Z"),
  ];
  const result = summarize(ledger, { ...day, currentStock: 110 });
  assert.equal(result.opening, 100);
  assert.equal(result.closing, 110);
  assert.equal(result.flows.entries, 20);
  assert.equal(result.flows.piecesOut, 8);
  assert.equal(result.flows.adjustmentsOut, 2);
  assert.equal(result.flows.returns, 0);
  assertBalanced(result);
});

test("a sale voided inside the period is never counted as pieces out", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("baseline", 50, "2026-09-01T08:00:00Z"),
    movement("sale", -5, "2026-09-28T08:00:00Z", { sale: "S2" }),
    movement("sale_void", 5, "2026-09-28T10:00:00Z", { sale: "S2" }),
    movement("sale", -3, "2026-09-28T11:00:00Z", { sale: "S3" }),
    movement("sale_delete", 3, "2026-09-28T12:00:00Z", { sale: "S3" }),
  ];
  const result = summarize(ledger, { ...day, currentStock: 50 });
  assert.equal(result.flows.piecesOut, 0);
  assert.equal(result.flows.returns, 0);
  assert.equal(result.opening, 50);
  assert.equal(result.closing, 50);
  assertBalanced(result);
});

test("voiding an earlier sale is a return; editing a sale counts its final quantity", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("baseline", 40, "2026-09-01T08:00:00Z"),
    movement("sale", -4, "2026-09-27T09:00:00Z", { sale: "OLD" }),
    movement("sale_void", 4, "2026-09-28T09:00:00Z", { sale: "OLD" }),
    movement("sale", -3, "2026-09-28T10:00:00Z", { sale: "UP" }),
    movement("sale_edit", -2, "2026-09-28T11:00:00Z", { sale: "UP" }),
    movement("sale", -6, "2026-09-28T12:00:00Z", { sale: "DOWN" }),
    movement("sale_edit", 2, "2026-09-28T13:00:00Z", { sale: "DOWN" }),
  ];
  const result = summarize(ledger, { ...day, currentStock: 40 - 4 + 4 - 5 - 4 });
  assert.equal(result.flows.returns, 4);
  assert.equal(result.flows.piecesOut, 5 + 4);
  assert.equal(result.opening, 36);
  assert.equal(result.closing, 31);
  assertBalanced(result);
});

test("a Monday sale remains in Monday history and its Tuesday void is a Tuesday return", () => {
  const ledger = [
    movement("baseline", 100, "2026-09-01T08:00:00Z"),
    movement("sale", -10, "2026-09-28T09:00:00Z", { sale: "MONDAY" }),
    movement("sale_void", 10, "2026-09-29T09:00:00Z", { sale: "MONDAY" }),
  ];
  const monday = summarize(ledger, { ...period({ date: "2026-09-28" }), currentStock: 100 });
  assert.equal(monday.opening, 100);
  assert.equal(monday.closing, 90);
  assert.equal(monday.flows.piecesOut, 10);
  assert.equal(monday.flows.returns, 0);

  const tuesday = summarize(ledger, { ...period({ date: "2026-09-29" }), currentStock: 100 });
  assert.equal(tuesday.opening, 90);
  assert.equal(tuesday.closing, 100);
  assert.equal(tuesday.flows.piecesOut, 0);
  assert.equal(tuesday.flows.returns, 10);

  const both = summarize(ledger, { ...period({ from: "2026-09-28", to: "2026-09-29" }), currentStock: 100 });
  assert.equal(both.opening, 100);
  assert.equal(both.closing, 100);
  assert.equal(both.flows.piecesOut, 0);
  assert.equal(both.flows.returns, 0);
});

test("a sale edit moving pieces between products nets per product, not per sale", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("sale", -5, "2026-09-28T08:00:00Z", { sale: "S", product: "A" }),
    movement("sale_edit", 5, "2026-09-28T09:00:00Z", { sale: "S", product: "A" }),
    movement("sale_edit", -5, "2026-09-28T09:00:00Z", { sale: "S", product: "B" }),
  ];
  const result = summarize(ledger, { ...day, currentStock: 0 });
  assert.equal(result.flows.piecesOut, 5);
  assert.equal(result.flows.returns, 0);
});

test("a product created during the period enters stock and is absent from the opening", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("baseline", 10, "2026-09-01T08:00:00Z", { product: "OLD" }),
    movement("initial", 50, "2026-09-28T08:00:00Z", { product: "NEW" }),
    movement("sale", -1, "2026-09-28T09:00:00Z", { product: "NEW", sale: "S" }),
  ];
  const result = summarize(ledger, { ...day, currentStock: 59 });
  assert.equal(result.opening, 10);
  assert.equal(result.flows.entries, 50);
  assert.equal(result.flows.newProducts, 50);
  assert.equal(result.closing, 59);
  assertBalanced(result);
});

test("deleting a product removes its remaining pieces as an adjustment", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("initial", 7, "2026-09-20T08:00:00Z"),
    movement("product_delete", -7, "2026-09-28T08:00:00Z"),
  ];
  const result = summarize(ledger, { ...day, currentStock: 0 });
  assert.equal(result.opening, 7);
  assert.equal(result.flows.adjustmentsOut, 7);
  assert.equal(result.closing, 0);
});

test("movements after the period give the closing stock without entering the flows", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("initial", 10, "2026-09-20T08:00:00Z"),
    movement("sale", -2, "2026-09-28T09:00:00Z", { sale: "S" }),
    movement("restock", 30, "2026-09-29T09:00:00Z"),
  ];
  const result = summarize(ledger, { ...day, currentStock: 38 });
  assert.equal(result.closing, 8);
  assert.equal(result.opening, 10);
  assert.equal(result.flows.entries, 0);
});

test("business-day boundaries follow Lubumbashi time (UTC+2), not UTC", () => {
  const day = period({ date: "2026-09-28" });
  assert.equal(day.start.toISOString(), "2026-09-27T22:00:00.000Z");
  assert.equal(day.end.toISOString(), "2026-09-28T21:59:59.999Z");
  const ledger = [
    movement("restock", 1, "2026-09-27T21:59:59.999Z"), // 27th, 23:59:59.999 local
    movement("restock", 2, "2026-09-27T22:00:00.000Z"), // 28th, 00:00 local
    movement("restock", 4, "2026-09-28T21:59:59.999Z"), // 28th, 23:59:59.999 local
    movement("restock", 8, "2026-09-28T22:00:00.000Z"), // 29th, 00:00 local
  ];
  const result = summarize(ledger, { ...day, currentStock: 15 });
  assert.equal(result.flows.entries, 6);
  assert.equal(result.opening, 1);
  assert.equal(result.closing, 7);
  assert.deepEqual(result.facet.series.map((row) => row._id), ["2026-09-28"]);
});

test("a period with no movement has equal opening and closing and zero flows", () => {
  const day = period({ date: "2026-09-28" });
  const result = summarize([movement("initial", 12, "2026-09-01T08:00:00Z")], { ...day, currentStock: 12 });
  assert.deepEqual(result.flows, normalizeFlows(null));
  assert.equal(result.opening, 12);
  assert.equal(result.closing, 12);
});

test("products that reached zero during the period are counted once each", () => {
  const day = period({ date: "2026-09-28" });
  const ledger = [
    movement("sale", -1, "2026-09-28T08:00:00Z", { sale: "S1", stockAfter: 0, product: "A" }),
    movement("restock", 5, "2026-09-28T09:00:00Z", { stockAfter: 5, product: "A" }),
    movement("sale", -5, "2026-09-28T10:00:00Z", { sale: "S2", stockAfter: 0, product: "A" }),
    movement("adjustment", -2, "2026-09-28T10:00:00Z", { stockAfter: 0, product: "B" }),
    movement("sale", -1, "2026-09-28T10:00:00Z", { sale: "S3", stockAfter: 4, product: "C" }),
  ];
  const result = summarize(ledger, { ...day, currentStock: 4 });
  assert.equal(result.facet.becameOutOfStock[0].count, 2);
});

test("history before the ledger baseline is reported as unknown, never as a number", () => {
  const baselineAt = new Date("2026-09-28T10:00:00Z");
  const now = new Date("2026-09-28T12:00:00Z");
  const day = period({ date: "2026-09-28" });
  const today = ledgerCoverage({ ...day, now, latestBaselineAt: baselineAt });
  assert.equal(today.openingKnown, false);
  assert.equal(today.closingKnown, true); // the end of today is "now"
  assert.equal(today.flowsComplete, false);

  const yesterday = ledgerCoverage({ ...period({ date: "2026-09-27" }), now, latestBaselineAt: baselineAt });
  assert.equal(yesterday.openingKnown, false);
  assert.equal(yesterday.closingKnown, false);
  assert.equal(yesterday.flowsAvailable, false);

  const tomorrow = ledgerCoverage({ ...period({ date: "2026-09-29" }), now: new Date("2026-09-29T12:00:00Z"), latestBaselineAt: baselineAt });
  assert.equal(tomorrow.openingKnown, true);

  const untracked = ledgerCoverage({ ...period({ date: "2026-09-29" }), now, latestBaselineAt: null, untrackedProducts: 1 });
  assert.equal(untracked.openingKnown, false);
});

test("the stock series ends on the closing stock and walks back through each day", () => {
  const range = period({ from: "2026-09-26", to: "2026-09-28" });
  const now = new Date("2026-09-30T00:00:00Z");
  const ledger = [
    movement("initial", 10, "2026-09-20T08:00:00Z"),
    movement("restock", 5, "2026-09-26T08:00:00Z"),
    movement("sale", -3, "2026-09-28T08:00:00Z", { sale: "S" }),
  ];
  const result = summarize(ledger, { ...range, currentStock: 12 });
  const series = buildStockSeries({
    ...range,
    now,
    granularity: "day",
    rows: result.facet.series,
    closing: result.closing,
    coverage: ledgerCoverage({ ...range, now, latestBaselineAt: null }),
  });
  assert.deepEqual(series, [
    { key: "2026-09-26", net: 5, level: 15 },
    { key: "2026-09-27", net: 0, level: 15 },
    { key: "2026-09-28", net: -3, level: 12 },
  ]);
});

test("long periods are charted by month and today stops at the current day", () => {
  const year = period({ from: "2026-01-01", to: "2026-09-28" });
  assert.equal(seriesGranularity(year.start, year.end), "month");
  assert.deepEqual(seriesKeys(year.start, year.end, new Date("2026-12-01T00:00:00Z"), "month").slice(-2), ["2026-08", "2026-09"]);
  const week = period({ from: "2026-09-21", to: "2026-09-27" });
  assert.equal(seriesGranularity(week.start, week.end), "day");
  assert.equal(seriesKeys(week.start, week.end, new Date("2026-09-23T10:00:00Z"), "day").length, 3);
});
