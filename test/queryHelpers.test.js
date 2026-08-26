const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTimeframeFilter,
  businessDateEnd,
  businessDateStart,
  paginationMetadata,
  parsePagination,
} = require("../utils/queryHelpers");

test("125 records paginate as 50, 50, 25 with complete metadata", () => {
  assert.deepEqual(paginationMetadata(1, 50, 125), {
    page: 1,
    limit: 50,
    totalRecords: 125,
    totalPages: 3,
    hasNextPage: true,
    hasPreviousPage: false,
  });
  assert.equal(parsePagination({ page: "2", limit: "50" }).skip, 50);
  assert.equal(parsePagination({ page: "3", limit: "50" }).skip, 100);
  assert.equal(125 - parsePagination({ page: "3", limit: "50" }).skip, 25);
});

test("pagination caps unsafe limits", () => {
  assert.equal(parsePagination({ limit: "1000000" }).limit, 100);
  assert.equal(parsePagination({ page: "-3" }).page, 1);
});

test("a 100-record payment-method match produces four 25-row pages", () => {
  const metadata = paginationMetadata(1, 25, 100);
  assert.equal(metadata.totalRecords, 100);
  assert.equal(metadata.totalPages, 4);
  assert.equal(metadata.hasNextPage, true);
});

test("Lubumbashi day boundaries are independent of server timezone", () => {
  assert.equal(businessDateStart("2026-08-26").toISOString(), "2026-08-25T22:00:00.000Z");
  assert.equal(businessDateEnd("2026-08-26").toISOString(), "2026-08-26T21:59:59.999Z");

  const transactionAtLocalMidnight = new Date("2026-08-25T22:05:00.000Z");
  const range = buildTimeframeFilter({ date: "2026-08-26" }).createdAt;
  assert.equal(transactionAtLocalMidnight >= range.$gte, true);
  assert.equal(transactionAtLocalMidnight <= range.$lte, true);
});

test("invalid calendar dates and inverted ranges are rejected", () => {
  assert.throws(() => businessDateStart("2026-02-30"), /Invalid date/);
  assert.throws(
    () => buildTimeframeFilter({ from: "2026-08-27", to: "2026-08-26" }),
    /Start date/
  );
});
