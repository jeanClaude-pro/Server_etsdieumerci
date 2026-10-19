// Catalogue translating an API request into a stable business action key.
// Keys are language-neutral; the client translates them (audit.actions.*).

const OBJECT_ID = /^[a-f0-9]{24}$/i;

// [method, normalized route, action, category]
const CATALOGUE = [
  ["POST", "/api/auth/login", "auth.login", "auth"],
  ["POST", "/api/auth/register", "auth.register", "auth"],
  ["POST", "/api/auth/verify-password", "auth.verify_password", "auth"],

  ["POST", "/api/sales", "sale.create", "sales"],
  ["PUT", "/api/sales/:id", "sale.update", "sales"],
  ["PATCH", "/api/sales/:id/void", "sale.void", "sales"],
  ["PATCH", "/api/sales/:id/complete", "sale.complete", "sales"],
  ["PATCH", "/api/sales/:id/pending", "sale.pending", "sales"],
  ["DELETE", "/api/sales/:id", "sale.delete", "sales"],
  ["POST", "/api/sales/edit-approvals/:id/decision", "sale.edit_decision", "sales"],
  ["POST", "/api/sales/receipt/approve", "receipt.approve_payment", "receipts"],
  ["POST", "/api/sales/receipt/verify", "receipt.verify_exit", "receipts"],
  ["POST", "/api/sales/receipt-control/admin-mark-complete", "receipt.admin_override", "receipts"],
  ["GET", "/api/sales/:id/receipt-token", "receipt.token_read", "receipts"],
  ["POST", "/api/print/receipt", "receipt.print", "receipts"],
  ["POST", "/api/print/stub", "receipt.print_stub", "receipts"],

  ["POST", "/api/products", "product.create", "stock"],
  ["PUT", "/api/products/:id", "product.update", "stock"],
  ["DELETE", "/api/products/:id", "product.delete", "stock"],
  ["POST", "/api/products/:id/stock-movements", "stock.movement", "stock"],
  ["POST", "/api/categories", "category.create", "stock"],

  ["POST", "/api/entries", "entry.create", "cash"],
  ["PUT", "/api/entries/:id", "entry.update", "cash"],
  ["DELETE", "/api/entries/:id", "entry.delete", "cash"],
  ["PATCH", "/api/entries/:id/restore", "entry.restore", "cash"],

  ["POST", "/api/expenses", "expense.create", "expenses"],
  ["PUT", "/api/expenses/:id", "expense.update", "expenses"],
  ["PATCH", "/api/expenses/:id/validate", "expense.validate", "expenses"],
  ["PATCH", "/api/expenses/:id/reject", "expense.reject", "expenses"],
  ["DELETE", "/api/expenses/:id", "expense.delete", "expenses"],
  ["DELETE", "/api/expenses/:id/admin", "expense.admin_delete", "expenses"],

  ["POST", "/api/exchange-rates", "rate.create", "rates"],
  ["PUT", "/api/exchange-rates/:id", "rate.update", "rates"],
  ["PATCH", "/api/exchange-rates/:id/deactivate", "rate.deactivate", "rates"],

  ["POST", "/api/creditors", "creditor.create", "debts"],
  ["PUT", "/api/creditors/:id", "creditor.update", "debts"],
  ["PATCH", "/api/creditors/:id/archive", "creditor.archive", "debts"],
  ["POST", "/api/creditors/:id/loans", "loan.create", "debts"],

  ["PUT", "/api/customers/:id", "customer.update", "customers"],
  ["POST", "/api/customers/:id/recalculate", "customer.recalculate", "customers"],

  ["POST", "/api/users", "user.create", "users"],
  ["PUT", "/api/users/:id/username", "user.rename", "users"],
  ["PUT", "/api/users/:id/role", "user.role_change", "users"],
  ["PUT", "/api/users/:id/status", "user.status_change", "users"],
  ["DELETE", "/api/users/:id", "user.delete", "users"],
  ["PUT", "/api/users/:id/permissions", "user.permissions_change", "users"],
  ["PUT", "/api/users/:id/actions", "user.actions_change", "users"],
  ["PUT", "/api/users/:id/profile", "user.profile_change", "users"],

  ["PUT", "/api/settings/receipt", "settings.receipt_update", "settings"],

  ["GET", "/api/analytics/summary", "report.view", "reports"],
  ["GET", "/api/analytics/timeseries", "report.view_trend", "reports"],
  ["GET", "/api/audit", "audit.view", "security"],
  ["PATCH", "/api/audit/:id/review", "audit.review", "security"],
];

// Reads worth journaling even when they succeed.
const SENSITIVE_READS = new Set([
  "receipt.token_read",
  "report.view",
  "audit.view",
]);

// Actions that destroy, cancel or bypass a control.
const DESTRUCTIVE_ACTIONS = new Set([
  "sale.void",
  "sale.delete",
  "entry.delete",
  "expense.delete",
  "expense.admin_delete",
  "product.delete",
  "receipt.admin_override",
  "rate.deactivate",
  "creditor.archive",
  "user.delete",
]);

const PRIVILEGE_ACTIONS = new Set([
  "user.create",
  "user.role_change",
  "user.status_change",
  "user.delete",
  "user.permissions_change",
  "user.actions_change",
]);

function normalizeRoute(originalUrl = "") {
  const pathOnly = String(originalUrl).split("?")[0].replace(/\/+$/, "") || "/";
  return pathOnly
    .split("/")
    .map((segment) => (OBJECT_ID.test(segment) ? ":id" : segment))
    .join("/");
}

function resourceIdOf(originalUrl = "") {
  const match = String(originalUrl).split("?")[0].match(/[a-f0-9]{24}/i);
  return match ? match[0] : null;
}

const INDEX = new Map(CATALOGUE.map(([method, route, action, category]) => [`${method} ${route}`, { action, category }]));

function describeRequest(method, originalUrl) {
  const route = normalizeRoute(originalUrl);
  const known = INDEX.get(`${method} ${route}`);
  if (known) return { route, ...known, known: true };
  const area = route.split("/")[2] || "api";
  return { route, action: `${area}.${method.toLowerCase()}`, category: "other", known: false };
}

module.exports = {
  CATALOGUE,
  DESTRUCTIVE_ACTIONS,
  PRIVILEGE_ACTIONS,
  SENSITIVE_READS,
  describeRequest,
  normalizeRoute,
  resourceIdOf,
};
