const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routes = fs.readFileSync(path.join(__dirname, "../routes/sales.js"), "utf8");
const model = fs.readFileSync(path.join(__dirname, "../models/Sale.js"), "utf8");
const print = fs.readFileSync(path.join(__dirname, "../routes/print.js"), "utf8");

test("manager sale edits are queued without mutating authoritative stock or totals", () => {
  const managerBranch = routes.slice(routes.indexOf('if (req.user.role === "manager"'), routes.indexOf('const updatedSale = await runTransaction'));
  assert.match(managerBranch, /status: "pending"/);
  assert.match(managerBranch, /original: editableSaleSnapshot\(originalSale\)/);
  assert.match(managerBranch, /proposed:/);
  assert.doesNotMatch(managerBranch, /buildStockAdjustments/);
  assert.doesNotMatch(managerBranch, /recalculateCustomerStats/);
});

test("only admin can decide and approval applies stock atomically", () => {
  assert.match(routes, /"\/edit-approvals\/:id\/decision"[\s\S]*requireReceiptRole\(\["admin"\]\)/);
  assert.match(routes, /const approvedSale = await runTransaction/);
  assert.match(routes, /buildStockAdjustments\(current\.items, proposal\.items\)/);
  assert.match(routes, /saleEditApprovalHistory: reviewed/);
  assert.match(model, /enum: \["pending", "approved", "rejected"\]/);
});

test("pending modifications are blocked by receipt confirmation and print paths", () => {
  const guards = routes.match(/"saleEditApproval\.status": \{ \$ne: "pending" \}/g) || [];
  assert.ok(guards.length >= 4, "approval, verification, token and override paths must guard pending edits");
  assert.match(routes, /MODIFICATION EN ATTENTE D'APPROBATION/);
  assert.match(print, /'saleEditApproval\.status': \{ \$ne: 'pending' \}/);
});

test("rejection preserves authoritative sale and records audit history", () => {
  const rejection = routes.slice(routes.indexOf('if (decision === "rejected")'), routes.indexOf('const approvedSale ='));
  assert.match(rejection, /status: "rejected"/);
  assert.match(rejection, /\$set: \{ saleEditApproval: reviewed \}/);
  assert.doesNotMatch(rejection, /\$set: \{[^}]*items:/);
  assert.match(rejection, /saleEditApprovalHistory: reviewed/);
});
