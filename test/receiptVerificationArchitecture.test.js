const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Sale = require("../models/Sale");
const receiptCrypto = require("../utils/receiptTokenCrypto");

const salesRoutes = fs.readFileSync(path.join(__dirname, "../routes/sales.js"), "utf8");
const printRoutes = fs.readFileSync(path.join(__dirname, "../routes/print.js"), "utf8");
const newSalePage = fs.readFileSync(
  path.join(__dirname, "../../client/src/pages/NewSale.tsx"),
  "utf8"
);
const scannerPage = fs.readFileSync(
  path.join(__dirname, "../../client/src/components/ReceiptScannerPage.tsx"),
  "utf8"
);

test("receipt secrets are excluded from ordinary Sale queries", () => {
  for (const field of [
    "receiptVerification.tokenHash",
    "receiptVerification.tokenCiphertext",
    "receiptVerification.invalidatedTokenHashes",
    "receiptVerification.approvedBy",
    "receiptVerification.exitVerification.verifiedBy",
  ]) {
    assert.equal(Sale.schema.path(field).options.select, false);
  }
});

test("approval and verification enforce distinct operational roles", () => {
  const approvalStart = salesRoutes.indexOf('"/receipt/approve"');
  const verificationStart = salesRoutes.indexOf('"/receipt/verify"');
  const receiptTokenStart = salesRoutes.indexOf('"/:id/receipt-token"');
  const approvalBlock = salesRoutes.slice(approvalStart, verificationStart);
  const verificationBlock = salesRoutes.slice(verificationStart, receiptTokenStart);

  assert.match(
    approvalBlock,
    /authMiddleware,[\s\S]*?receiptScanLimiter,[\s\S]*?requireReceiptRole\(\["cashier_supervisor", "admin"\]\),[\s\S]*?receiptPayloadGuard/
  );
  assert.match(
    verificationBlock,
    /authMiddleware,[\s\S]*?receiptScanLimiter,[\s\S]*?requireReceiptRole\(\["inventory_manager", "admin"\]\),[\s\S]*?receiptPayloadGuard/
  );
});

test("camera scanning remains active between receipt reads", () => {
  const callbackStart = scannerPage.indexOf("(decoded) => {");
  const callbackEnd = scannerPage.indexOf("setCameraActive(true)", callbackStart);
  const decodeCallback = scannerPage.slice(callbackStart, callbackEnd);

  assert.match(decodeCallback, /submitToken\(decoded\.getText\(\)\)/);
  assert.doesNotMatch(decodeCallback, /controlsRef\.current\?\.stop\(\)/);
  assert.doesNotMatch(decodeCallback, /setCameraActive\(false\)/);
});

test("approval and exit verification are atomic and remain independent", () => {
  const approvalStart = salesRoutes.indexOf('"/receipt/approve"');
  const verificationStart = salesRoutes.indexOf('"/receipt/verify"');
  const receiptTokenStart = salesRoutes.indexOf('"/:id/receipt-token"');
  const approvalBlock = salesRoutes.slice(approvalStart, verificationStart);
  const verificationBlock = salesRoutes.slice(verificationStart, receiptTokenStart);

  assert.match(approvalBlock, /Sale\.findOneAndUpdate\(/);
  assert.match(approvalBlock, /"receiptVerification\.paymentStatus": "pending"/);
  assert.match(verificationBlock, /Sale\.findOneAndUpdate\(/);
  assert.match(verificationBlock, /"receiptVerification\.paymentStatus": "approved"/);
  assert.match(verificationBlock, /"receiptVerification\.exitVerification\.verified": \{ \$ne: true \}/);
  assert.match(verificationBlock, /"receiptVerification\.exitVerification\.verified": true/);
  assert.doesNotMatch(verificationBlock, /"receiptVerification\.paymentStatus"\s*:\s*"approved"[\s\S]*?\$set\s*:\s*\{[\s\S]*?"receiptVerification\.paymentStatus"/);
  assert.match(verificationBlock, /"PENDING"/);
});

test("receipt QR uses a random opaque token and SHA-256 lookup hash", () => {
  const previousKey = process.env.RECEIPT_TOKEN_ENCRYPTION_KEY;
  process.env.RECEIPT_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const token = receiptCrypto.createReceiptToken();
    assert.match(token, /^EDM1:[A-Za-z0-9_-]{43}$/);
    assert.equal(token.length, 48);
    assert.equal(receiptCrypto.normalizeReceiptToken(token), token);
    assert.equal(receiptCrypto.hashReceiptToken(token).length, 64);
    assert.equal(receiptCrypto.decryptReceiptToken(receiptCrypto.encryptReceiptToken(token)), token);
    assert.doesNotMatch(token, /https?:|login|localhost/i);
  } finally {
    if (previousKey === undefined) delete process.env.RECEIPT_TOKEN_ENCRYPTION_KEY;
    else process.env.RECEIPT_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});

test("malformed and oversized scanner values are rejected before lookup", () => {
  assert.equal(receiptCrypto.normalizeReceiptToken(""), null);
  assert.equal(receiptCrypto.normalizeReceiptToken(" EDM1:" + "A".repeat(43)), null);
  assert.equal(receiptCrypto.normalizeReceiptToken("https://example.com"), null);
  assert.equal(receiptCrypto.normalizeReceiptToken("EDM1:" + "A".repeat(5000)), null);
  assert.match(salesRoutes, /receiptPayloadGuard/);
});

test("receipt encryption requires a dedicated canonical 32-byte base64 key", () => {
  const previousKey = process.env.RECEIPT_TOKEN_ENCRYPTION_KEY;
  try {
    delete process.env.RECEIPT_TOKEN_ENCRYPTION_KEY;
    assert.throws(receiptCrypto.validateReceiptTokenConfiguration, /is required/);
    process.env.RECEIPT_TOKEN_ENCRYPTION_KEY = "too-short";
    assert.throws(receiptCrypto.validateReceiptTokenConfiguration, /32-byte key/);
    process.env.RECEIPT_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    assert.doesNotThrow(receiptCrypto.validateReceiptTokenConfiguration);
  } finally {
    if (previousKey === undefined) delete process.env.RECEIPT_TOKEN_ENCRYPTION_KEY;
    else process.env.RECEIPT_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});

test("normal sale aggregations and direct responses remove security internals", () => {
  assert.match(salesRoutes, /"receiptVerification\.tokenHash": 0/);
  assert.match(salesRoutes, /"receiptVerification\.tokenCiphertext": 0/);
  assert.match(salesRoutes, /"receiptVerification\.invalidatedTokenHashes": 0/);
  assert.match(salesRoutes, /safeSaleResponse\(savedSale, receiptToken\)/);
});

test("raw-token retrieval is permission protected and rate limited", () => {
  const tokenRoute = salesRoutes.slice(salesRoutes.indexOf('"/:id/receipt-token"'));
  assert.match(tokenRoute, /authMiddleware,[\s\S]*?receiptTokenLimiter,[\s\S]*?requireReceiptReprintPermission/);
  assert.match(salesRoutes, /actionPermissions\?\.includes\("reprint_receipts"\)/);
});

test("obsolete hashes are bounded and edits reset approval", () => {
  assert.match(salesRoutes, /invalidatedTokenHashes:[\s\S]*?\.slice\(-20\)/);
  assert.match(salesRoutes, /paymentStatus: "pending",[\s\S]*?approvedBy: null,[\s\S]*?approvedAt: null/);
  assert.match(salesRoutes, /exitVerification: \{ verified: false, verifiedBy: null, verifiedAt: null \}/);
});

test("customer receipt and sale stub print the same opaque token", () => {
  assert.ok((printRoutes.match(/\.qrcode\(receiptData\.qrToken/g) || []).length >= 2);
  assert.ok((newSalePage.match(/receiptData\.qrDataUrl/g) || []).length >= 2);
  assert.match(newSalePage, /qrToken: data\.receiptToken/);
  assert.doesNotMatch(newSalePage, /QRCode\.toDataURL\([^)]*(?:https?:|\/login)/);
  assert.match(printRoutes, /authorizePrintedReceipt/);
  assert.match(printRoutes, /timingSafeEqual/);
});
