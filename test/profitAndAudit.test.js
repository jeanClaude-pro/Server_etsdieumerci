const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { once } = require("node:events");
const { Aggregator } = require("mingo");
const User = require("../models/User");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const Loan = require("../models/Loan");
const Creditor = require("../models/Creditor");
const AuditLog = require("../models/AuditLog");
const { VALID_SALE_MATCH, saleLineStages, lineAccumulators } = require("../utils/profitPipeline");
const { canAccessPage } = require("../utils/accessPolicy");
const { evaluateAuditFlags, isOffHours } = require("../utils/auditRules");
const { describeRequest } = require("../utils/auditActions");
const { sanitize } = require("../middleware/auditTrail");

const products = [
  { _id: "P1", name: "Sac", price: 10, stock: 5, unit: "pcs", status: "active" },
  { _id: "P2", name: "Valise", price: 7, stock: 5, unit: "pcs", status: "active" },
];
// Business day 2026-10-05 (Lubumbashi = UTC+2) and 2026-10-06.
const sales = [
  {
    _id: "S1", type: "sale", status: "completed", createdAt: new Date("2026-10-05T08:00:00Z"), total: 37,
    items: [
      { productId: "P1", name: "Sac", quantity: 2, price: 10, total: 20 },
      { productId: "P1", name: "Sac", quantity: 1, price: 10, total: 10 },
      { productId: "P2", name: "Valise", quantity: 1, price: 7, total: 7 },
    ],
  },
  {
    _id: "S2", type: "sale", status: "voided", createdAt: new Date("2026-10-05T09:00:00Z"), total: 100,
    items: [{ productId: "P1", name: "Sac", quantity: 10, price: 10, total: 100 }],
  },
  {
    _id: "S3", type: "sale", status: "completed", createdAt: new Date("2026-10-06T09:00:00Z"), total: 8,
    items: [{ productId: "P1", name: "Sac", quantity: 1, price: 8, total: 8 }],
  },
];
const expenses = [
  { _id: "E1", status: "validated", expenseType: "normal", amount: 6, createdAt: new Date("2026-10-05T10:00:00Z") },
  { _id: "E2", status: "validated", expenseType: "repayment", amount: 50, createdAt: new Date("2026-10-05T11:00:00Z") },
  { _id: "E3", status: "pending", expenseType: "normal", amount: 99, createdAt: new Date("2026-10-05T11:00:00Z") },
];
const entries = [{ _id: "N1", status: "active", amount: 3, createdAt: new Date("2026-10-06T10:00:00Z") }];

const collections = { [Product.collection.name]: products, [Sale.collection.name]: sales };
const aggregate = (pipeline, rows) =>
  new Aggregator(pipeline, { collectionResolver: (name) => collections[name] || [] }).run(rows);

test("sold lines give the revenue and the pieces sold (no purchase price)", () => {
  const [row] = aggregate([{ $match: { ...VALID_SALE_MATCH, _id: "S1" } }, ...saleLineStages(), { $group: { _id: null, ...lineAccumulators() } }], sales);
  assert.equal(row.lineRevenue, 37);
  assert.equal(row.unitsSold, 4);
});

test("page access policy mirrors the navigation rules on the server", () => {
  const manager = { role: "manager", permissions: [] };
  const cashier = { role: "cashier_supervisor", permissions: [] };
  const staffWithEntry = { role: "staff", permissions: ["/entry"] };
  assert.equal(canAccessPage(manager, "/rate"), true, "managers may manage the exchange rate");
  assert.equal(canAccessPage(manager, "/reports"), false);
  assert.equal(canAccessPage(manager, "/audit"), false);
  assert.equal(canAccessPage(cashier, "/payment-approval"), true);
  assert.equal(canAccessPage({ ...cashier, permissions: ["/dashboard"] }, "/dashboard"), false, "fixed-role pages ignore custom permissions");
  assert.equal(canAccessPage({ ...manager, permissions: ["/customers"] }, "/customers"), false, "admin-only pages stay admin-only");
  assert.equal(canAccessPage(staffWithEntry, "/entry"), true);
  assert.equal(canAccessPage(staffWithEntry, "/sales"), false);
  assert.equal(canAccessPage({ role: "admin", permissions: [] }, "/audit"), true);
  assert.equal(canAccessPage({ role: "admin", isActive: false }, "/audit"), false);
});

test("audit rules flag off-hours deletions, brute force and self-promotion", () => {
  const day = new Date("2026-10-05T10:00:00Z"); // 12:00 in Lubumbashi
  const night = new Date("2026-10-05T21:30:00Z"); // 23:30 in Lubumbashi
  assert.equal(isOffHours(day), false);
  assert.equal(isOffHours(night), true);

  const normal = evaluateAuditFlags({ at: day, method: "POST", action: "sale.create", outcome: "success", statusCode: 201, user: "U1" }, {});
  assert.equal(normal.suspicious, false);

  const nightDelete = evaluateAuditFlags({ at: night, method: "PATCH", action: "sale.void", outcome: "success", statusCode: 200, user: "U1" }, {});
  assert.ok(nightDelete.flags.includes("DESTRUCTIVE_OFF_HOURS"));
  assert.equal(nightDelete.severity, "critical");

  const brute = evaluateAuditFlags({ at: day, method: "POST", action: "auth.login", outcome: "denied", statusCode: 401 }, { recentLoginFailures: 2 });
  assert.ok(brute.flags.includes("BRUTE_FORCE"));

  const selfPromotion = evaluateAuditFlags(
    { at: day, method: "PUT", action: "user.role_change", outcome: "success", statusCode: 200, user: "abc", resourceId: "abc" },
    {}
  );
  assert.ok(selfPromotion.flags.includes("SELF_PRIVILEGE_CHANGE"));

  const denied = evaluateAuditFlags({ at: day, method: "GET", action: "report.view", outcome: "denied", statusCode: 403, user: "U2" }, { recentDenials: 2 });
  assert.deepEqual(denied.flags.sort(), ["ACCESS_DENIED", "REPEATED_DENIALS"]);

  const bigRemoval = evaluateAuditFlags(
    { at: day, method: "POST", action: "stock.movement", outcome: "success", statusCode: 201, user: "U1" },
    { hints: { stockRemoved: 30, stockBefore: 40 } }
  );
  assert.ok(bigRemoval.flags.includes("LARGE_STOCK_REMOVAL"));

  const rateJump = evaluateAuditFlags(
    { at: day, method: "POST", action: "rate.create", outcome: "success", statusCode: 201, user: "U1" },
    { hints: { previousRate: 2800, newRate: 3200 } }
  );
  assert.ok(rateJump.flags.includes("RATE_JUMP"));
});

test("audit catalogue names actions and the journal masks secrets", () => {
  assert.deepEqual(
    (({ action, category, route }) => ({ action, category, route }))(describeRequest("PATCH", "/api/sales/507f1f77bcf86cd799439011/void?x=1")),
    { action: "sale.void", category: "sales", route: "/api/sales/:id/void" }
  );
  assert.equal(describeRequest("POST", "/api/unknown/thing").category, "other");
  const clean = sanitize({ email: "a@b.c", password: "secret", nested: { token: "t", name: "x".repeat(300) } });
  assert.equal(clean.password, "[masqué]");
  assert.equal(clean.nested.token, "[masqué]");
  assert.ok(clean.nested.name.length <= 201);
});

async function startApp(t) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "profit-audit-test-secret-0123456789abcdef";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const ROLES = ["admin", "manager", "cashier_supervisor"];
  t.mock.method(User, "findById", (id) => {
    const user = ROLES.includes(id) ? { _id: id, username: id, role: id, isActive: true, permissions: [] } : null;
    const promise = Promise.resolve(user);
    return { select: () => promise, then: (resolve, reject) => promise.then(resolve, reject) };
  });
  const result = (rows) => ({ allowDiskUse: async () => rows, then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) });
  t.mock.method(Sale, "aggregate", (pipeline) => result(aggregate(pipeline, sales)));
  t.mock.method(Expense, "aggregate", (pipeline) => result(aggregate(pipeline, expenses)));
  t.mock.method(Entry, "aggregate", (pipeline) => result(aggregate(pipeline, entries)));
  t.mock.method(Loan, "aggregate", () => result([]));
  t.mock.method(Creditor, "aggregate", () => result([]));
  t.mock.method(AuditLog, "aggregate", () => result([{ rows: [], total: [] }]));
  t.mock.method(Product, "find", () => {
    const query = { sort: () => query, lean: async () => products.map((product) => ({ ...product })) };
    return query;
  });

  const app = express();
  app.use(express.json());
  app.use("/api/analytics", require("../routes/analytics"));
  app.use("/api/audit", require("../routes/audit"));
  app.use("/api/products", require("../routes/products"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return async (path, role = "admin") => {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${jwt.sign({ id: role }, process.env.JWT_SECRET, { expiresIn: "1h" })}` } });
    return { status: response.status, body: await response.json() };
  };
}

test("analytics summary reports sales and net cash from aggregation and refuses non-administrators", async (t) => {
  const get = await startApp(t);
  assert.equal((await get("/analytics/summary?date=2026-10-05", "manager")).status, 403);
  assert.equal((await get("/analytics/timeseries?from=2026-10-05&to=2026-10-06", "manager")).status, 403);
  assert.equal((await get("/audit?date=2026-10-05", "manager")).status, 403);

  const { status, body } = await get("/analytics/summary?date=2026-10-05");
  assert.equal(status, 200);
  assert.equal(body.data.totalRevenue, 37, "the voided sale is not revenue");
  assert.equal(body.data.netCash, -19, "trésorerie nette = (ventes 37 + entrées 0) − dépenses validées 56");
  assert.equal(body.data.unitsSold, 4);
  assert.ok(!("profit" in body.data), "no profit figure: the business follows the net cash logic");
  assert.equal(body.data.totalValidatedExpenses, 56);
  const sac = body.data.topProducts.find((row) => row.name === "Sac");
  assert.deepEqual([sac.quantity, sac.revenue], [3, 30]);
  assert.ok(!("cogs" in sac) && !("grossProfit" in sac), "no cost is ever reported: the shop records no purchase price");
});

test("analytics time series returns every bucket with exact daily figures", async (t) => {
  const get = await startApp(t);
  const { status, body } = await get("/analytics/timeseries?from=2026-10-04&to=2026-10-06");
  assert.equal(status, 200);
  assert.equal(body.period.granularity, "day");
  assert.deepEqual(body.points.map((point) => point.key), ["2026-10-04", "2026-10-05", "2026-10-06"]);
  assert.deepEqual(body.points.map((point) => point.revenue), [0, 37, 8], "an empty day is a real zero; values are never smoothed");
  assert.deepEqual(body.points.map((point) => point.validatedExpenses), [0, 56, 0]);
  assert.deepEqual(body.points.map((point) => point.netCash), [0, -19, 11]);
  assert.deepEqual(body.points.map((point) => point.entries), [0, 0, 3]);
});

test("a single day is charted hour by hour in Lubumbashi time", async (t) => {
  const get = await startApp(t);
  const { status, body } = await get("/analytics/timeseries?from=2026-10-05&to=2026-10-05");
  assert.equal(status, 200);
  assert.equal(body.period.granularity, "hour");
  assert.equal(body.points.length, 24, "a past day has its 24 hours");
  assert.equal(body.points[0].key, "2026-10-05T00");
  const at = (hour) => body.points.find((point) => point.key === `2026-10-05T${hour}`);
  assert.equal(at("10").revenue, 37, "08:00 UTC is 10:00 in Lubumbashi");
  assert.equal(at("12").validatedExpenses, 6);
  assert.equal(at("13").validatedExpenses, 50);
  assert.equal(body.points.reduce((sum, point) => sum + point.revenue, 0), 37, "hours add up to the day");
});

test("audit middleware journals mutations and refusals after the response, without secrets", async (t) => {
  const written = [];
  t.mock.method(AuditLog, "create", async (entry) => { written.push(entry); return entry; });
  t.mock.method(AuditLog, "countDocuments", async () => 0);
  const auditTrail = require("../middleware/auditTrail");
  const app = express();
  app.use(express.json());
  app.use("/api", auditTrail);
  app.use((req, _res, next) => { req.user = { _id: "U1", username: "caisse", role: "cashier_supervisor", email: "c@x.cd" }; next(); });
  app.get("/api/analytics/summary", (_req, res) => res.status(403).json({}));
  app.get("/api/products", (_req, res) => res.json([]));
  app.post("/api/users", (_req, res) => res.status(201).json({}));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/analytics/summary`);
  await fetch(`${base}/api/products`);
  await fetch(`${base}/api/users`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "n@x.cd", password: "TopSecret1", role: "admin" }) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(written.map((entry) => entry.action), ["report.view", "user.create"], "ordinary reads are not journaled");
  assert.equal(written[0].outcome, "denied");
  assert.equal(written[0].suspicious, true);
  assert.equal(written[1].details.body.password, "[masqué]");
  assert.ok(written[1].flags.includes("PRIVILEGE_CHANGE"));
});
