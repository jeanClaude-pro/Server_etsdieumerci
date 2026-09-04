const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  RECEIPT_SCANNER_CUTOFF,
  buildScanStatsPipeline,
  scanBusinessStatus,
} = require("../utils/scanStats");

const sale = (createdAt, paymentStatus = "pending", verified = false) => ({
  createdAt,
  receiptVerification: { paymentStatus, exitVerification: { verified } },
});

test("scanner rollout starts at Lubumbashi midnight, not UTC midnight", () => {
  assert.equal(RECEIPT_SCANNER_CUTOFF.toISOString(), "2026-09-03T22:00:00.000Z");
  assert.deepEqual(scanBusinessStatus(sale("2026-09-03T21:59:59.999Z")), {
    paymentApproved: true,
    exitControlled: true,
  });
  assert.deepEqual(scanBusinessStatus(sale("2026-09-03T22:00:00.000Z")), {
    paymentApproved: false,
    exitControlled: false,
  });
});

test("post-rollout payment and exit remain independent persisted states", () => {
  assert.deepEqual(scanBusinessStatus(sale("2026-09-04T08:00:00Z", "approved", false)), {
    paymentApproved: true,
    exitControlled: false,
  });
  assert.deepEqual(scanBusinessStatus(sale("2026-09-04T08:00:00Z", "approved", true)), {
    paymentApproved: true,
    exitControlled: true,
  });
});

test("scan statistics use one aggregate pipeline and exclude voided/corrected sales", () => {
  const pipeline = buildScanStatsPipeline({ createdAt: { $gte: new Date(0), $lte: new Date() } });
  assert.equal(pipeline.length, 3);
  assert.deepEqual(pipeline[0].$match.status, { $in: ["completed", "pending"] });
  assert.equal(pipeline[0].$match.type, "sale");
  assert.ok(pipeline[1].$group.paymentApproved.$sum.$cond);
  assert.ok(pipeline[1].$group.exitControlled.$sum.$cond);
  assert.equal(JSON.stringify(pipeline).includes("tokenHash"), false);
  assert.equal(JSON.stringify(pipeline).includes("tokenCiphertext"), false);
});

test("scan endpoint is authenticated, pagination-independent, and aggregate-only", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/sales.js"), "utf8");
  const route = source.slice(source.indexOf('router.get("/scan-stats"'), source.indexOf("// ==================== ALL OTHER ROUTES", source.indexOf('router.get("/scan-stats"')));
  assert.match(route, /authMiddleware/);
  assert.match(route, /Sale\.aggregate\(buildScanStatsPipeline\(match\)\)/);
  assert.doesNotMatch(route, /parsePagination|\.find\(|tokenHash|tokenCiphertext/);
});

test("duplicate scanner attempts cannot alter aggregate counts", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/sales.js"), "utf8");
  assert.match(source, /"receiptVerification\.paymentStatus": "pending"/);
  assert.match(source, /"receiptVerification\.exitVerification\.verified": \{ \$ne: true \}/);
  assert.match(source, /"receiptVerification\.paymentStatus": "approved"/);
});

test("all receipt paths render compact USD and exact historical FC snapshots", () => {
  const serverPrint = fs.readFileSync(path.join(__dirname, "../routes/print.js"), "utf8");
  const newSale = fs.readFileSync(path.join(__dirname, "../../client/src/pages/NewSale.tsx"), "utf8");
  const history = fs.readFileSync(path.join(__dirname, "../../client/src/pages/history/SalesHistory.tsx"), "utf8");
  const reservation = fs.readFileSync(path.join(__dirname, "../../client/src/pages/Reservation.tsx"), "utf8");
  assert.match(serverPrint, /enteredCurrency === 'FC'.*enteredPrice/);
  assert.match(serverPrint, /item\.exchangeRate \?\? saleRate/);
  assert.match(serverPrint, /dualSaleTotal\(receiptData\)/);
  assert.match(newSale, /compactDualUnit\(item, receiptData\.exchangeRate\)/);
  assert.match(newSale, /compactDualSaleTotal\(receiptData\.total, receiptData\.items, receiptData\.exchangeRate\)/);
  assert.match(history, /compactDualUnit\(item, sale\.exchangeRate\)/);
  assert.match(history, /compactDualSaleTotal\(sale\.total, sale\.items, sale\.exchangeRate\)/);
  assert.match(reservation, /compactReservationUnit\(item, receiptData\.exchangeRate\)/);
  assert.match(reservation, /compactReservationTotal\(receiptData\.total, receiptData\.items, receiptData\.exchangeRate\)/);
});
