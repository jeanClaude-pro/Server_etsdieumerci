const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { once } = require("node:events");
const Entry = require("../models/Entry");
const User = require("../models/User");
const Sale = require("../models/Sale");
const Expense = require("../models/Expense");

// Real HTTP routes, authentication and Mongoose validation; persistence is
// replaced with an in-memory collection so no production database is touched.
test("authenticated entry is saved, searchable, and included in analytics", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "entry-flow-test-only";
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
  const userId = "507f1f77bcf86cd799439011";
  t.mock.method(User, "findById", async () => ({ _id: userId, username: "Cashier", role: "manager", isActive: true }));
  t.mock.method(User, "find", () => ({ select: () => ({ lean: async () => [] }) }));
  const rows = [];
  t.mock.method(Entry.prototype, "save", async function () {
    await this.validate();
    this.createdAt = new Date("2026-09-27T22:30:00Z");
    rows.push(this.toObject());
    return this;
  });
  const matches = (filter) => rows.filter(row => row.status === filter.status &&
    row.createdAt >= filter.createdAt.$gte && row.createdAt <= filter.createdAt.$lte &&
    (!filter.$or || filter.$or.some(condition => {
      const [field, rule] = Object.entries(condition)[0];
      if (!rule.$regex) return false;
      const value = field.split(".").reduce((v, key) => v?.[key], row);
      return new RegExp(rule.$regex, rule.$options).test(value || "");
    })));
  t.mock.method(Entry, "find", (filter) => {
    const query = { populate: () => query, select: () => query, sort: () => query, skip: () => query, limit: () => query, lean: async () => matches(filter) };
    return query;
  });
  t.mock.method(Entry, "countDocuments", async filter => matches(filter).length);
  t.mock.method(Entry, "aggregate", async pipeline => {
    const selected = matches(pipeline[0].$match);
    const amount = selected.reduce((sum, row) => sum + row.amount, 0);
    if (pipeline[1].$facet) return [{ totals: [{ totalAmount: amount, activeAmount: amount, activeCount: selected.length }], categories: [], sources: [], paymentMethods: [] }];
    assert.equal(pipeline[1].$group.amount.$sum, "$amount");
    return [{ count: selected.length, amount }];
  });
  t.mock.method(Sale, "aggregate", () => ({ allowDiskUse: async () => [] }));
  t.mock.method(Expense, "aggregate", async () => []);
  const app = express();
  app.use(express.json());
  app.use("/api/entries", require("../routes/entries"));
  app.use("/api/analytics", require("../routes/analytics"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
  const body = { amount: 4.21, enteredAmount: 12000, enteredCurrency: "FC", exchangeRate: 2850, source: "Transfert Mobile", category: "Investissement", paymentMethod: "transfer", receivedFrom: { name: "Alice (shop)", phone: "+243123" } };
  const denied = await fetch(`${base}/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(denied.status, 401);
  const created = await fetch(`${base}/entries`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.equal(saved.createdBy, userId);
  assert.equal(saved.status, "active");
  assert.equal(saved.paymentMethod, "transfer");
  assert.equal(saved.amount, 12000 / 2850);
  assert.equal(saved.enteredAmount, 12000);
  for (const search of [saved.entryId, "Alice (shop)", "+243123", "Investissement"]) {
    const response = await fetch(`${base}/entries?date=2026-09-28&search=${encodeURIComponent(search)}`, { headers });
    assert.equal(response.status, 200);
    const history = await response.json();
    assert.equal(history.data[0].entryId, saved.entryId);
    assert.equal(history.summary.totalAmount, saved.amount);
  }
  const analytics = await (await fetch(`${base}/analytics/summary?date=2026-09-28`, { headers })).json();
  assert.equal(analytics.data.totalEntries, saved.amount);
  assert.equal(analytics.data.entryCount, 1);
  assert.equal(analytics.data.netCash, saved.amount);
  assert.equal(analytics.data.totalRevenue, 0);
  rows[0].status = "deleted";
  const afterDeletion = await (await fetch(`${base}/analytics/summary?date=2026-09-28`, { headers })).json();
  assert.equal(afterDeletion.data.totalEntries, 0);
  assert.equal(afterDeletion.data.entryCount, 0);
  for (const invalid of [{ source: {} }, { category: " " }, { enteredAmount: -1 }, { exchangeRate: 0 }, { receivedFrom: { name: " ", phone: "+243123" } }, { receivedFrom: undefined }]) {
    const response = await fetch(`${base}/entries`, { method: "POST", headers, body: JSON.stringify({ ...body, ...invalid }) });
    assert.equal(response.status, 400);
  }
  assert.equal(rows.length, 1);
});
