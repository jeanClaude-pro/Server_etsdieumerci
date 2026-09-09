const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const salesRoutes = fs.readFileSync(path.join(__dirname, "../routes/sales.js"), "utf8");
const saleModel = fs.readFileSync(path.join(__dirname, "../models/Sale.js"), "utf8");
const salesHistoryPage = fs.readFileSync(
  path.join(__dirname, "../../jean-client/src/pages/history/SalesHistory.tsx"),
  "utf8"
);

const routeStart = salesRoutes.indexOf('"/receipt-control/admin-mark-complete"');
const routeEnd = salesRoutes.indexOf('router.get("/:id"', routeStart);
const overrideRoute = salesRoutes.slice(routeStart, routeEnd);

test("admin override route exists and is scoped to admin only", () => {
  assert.ok(routeStart > -1, "admin-mark-complete route not found");
  assert.match(overrideRoute, /authMiddleware/);
  assert.match(overrideRoute, /requireReceiptRole\(\["admin"\]\)/);
});

test("admin override independently validates ObjectIds instead of trusting the client", () => {
  assert.match(overrideRoute, /mongoose\.Types\.ObjectId\.isValid\(id\)/);
  assert.match(overrideRoute, /reason: "invalid_id"/);
  assert.match(overrideRoute, /reason: "not_found"/);
});

test("admin override excludes non-sale, ineligible-status, and obsolete records", () => {
  assert.match(overrideRoute, /sale\.type !== "sale"/);
  assert.match(overrideRoute, /"ineligible_status"/);
  assert.match(overrideRoute, /sale\.receiptVerification\.invalidatedAt/);
  assert.match(overrideRoute, /"obsolete_receipt"/);
});

test("legacy pre-rollout sales are treated as already complete, not silently rewritten", () => {
  assert.match(overrideRoute, /RECEIPT_SCANNER_CUTOFF/);
  assert.match(overrideRoute, /alreadyComplete \+= 1/);
});

test("admin override uses a single bulkWrite instead of one request per sale", () => {
  assert.match(overrideRoute, /Sale\.bulkWrite\(bulkOps/);
  assert.doesNotMatch(overrideRoute, /for\s*\([^)]*\)\s*\{\s*await Sale\.findByIdAndUpdate/);
});

test("admin override only completes missing pieces and preserves existing approval/control metadata", () => {
  assert.match(overrideRoute, /needsPaymentApproval = sale\.receiptVerification\.paymentStatus !== "approved"/);
  assert.match(overrideRoute, /needsExitControl = sale\.receiptVerification\.exitVerification\?\.verified !== true/);
  assert.match(overrideRoute, /if \(needsPaymentApproval\) \{/);
  assert.match(overrideRoute, /if \(needsExitControl\) \{/);
});

test("admin override guards each bulk write with the same conditional-update pattern as live scans", () => {
  assert.match(overrideRoute, /"receiptVerification\.paymentStatus"\] = \{ \$ne: "approved" \}/);
  assert.match(overrideRoute, /"receiptVerification\.exitVerification\.verified"\] = \{ \$ne: true \}/);
});

test("admin override response never overstates success", () => {
  assert.match(overrideRoute, /modifiedCount = bulkResult\.modifiedCount/);
  assert.match(overrideRoute, /"concurrent_state_change"/);
  assert.match(overrideRoute, /selected: uniqueIds\.length/);
  assert.match(overrideRoute, /updated: modifiedCount/);
  assert.match(overrideRoute, /alreadyComplete,/);
  assert.match(overrideRoute, /rejected: rejected\.length/);
});

test("admin override records manual-override audit metadata distinct from scanner metadata", () => {
  assert.match(overrideRoute, /"receiptVerification\.manualOverride\.overridden": true/);
  assert.match(overrideRoute, /"receiptVerification\.manualOverride\.overriddenBy": req\.user\._id/);
  assert.match(overrideRoute, /"receiptVerification\.manualOverride\.overriddenAt": now/);
});

test("Sale schema defines a manual-override audit field distinct from scanner approval/verification fields", () => {
  assert.match(saleModel, /manualOverrideSchema/);
  assert.match(saleModel, /overridden: \{ type: Boolean, default: false \}/);
  assert.match(saleModel, /overriddenBy: \{[\s\S]*?ref: "User",[\s\S]*?select: false/);
});

test("manual-override user reference is excluded from ordinary responses like other audit refs", () => {
  assert.match(salesRoutes, /delete value\.receiptVerification\.manualOverride\.overriddenBy/);
  assert.match(salesRoutes, /"receiptVerification\.manualOverride\.overriddenBy": 0/);
});

test("SalesHistory exposes an admin-only bulk override control wired to the new endpoint", () => {
  assert.match(salesHistoryPage, /receipt-control\/admin-mark-complete/);
  assert.match(salesHistoryPage, /isAdmin/);
});
