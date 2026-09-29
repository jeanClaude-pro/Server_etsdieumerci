const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { once } = require("node:events");
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");

const Product = require("../../models/Product");
const StockMovement = require("../../models/StockMovement");
const Sale = require("../../models/Sale");
const User = require("../../models/User");
const Customer = require("../../models/Customer");
const { applyStockChange, ensureStockBaselines } = require("../../utils/stockLedger");
const { runTransaction } = require("../../utils/transaction");
const { currentBusinessDate } = require("../../utils/queryHelpers");

// End-to-end on a real single-node MongoDB replica set (transactions, real
// aggregation engine, real indexes) through the real Express routes.
// Run with: npm run test:integration (downloads mongod once, then cached).

let replSet;
let server;
let base;
const tokens = {};

test.before(async () => {
  process.env.JWT_SECRET = "integration-test-secret-0123456789abcdef";
  process.env.RECEIPT_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri(), { dbName: "inventory-it" });
  await Promise.all([Product, StockMovement, Sale, User, Customer].map((Model) => Model.init()));

  for (const role of ["admin", "manager"]) {
    const user = await User.create({ username: `${role}-it`, email: `${role}@it.test`, password: "x", role });
    tokens[role] = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: "1h" });
  }

  const app = express();
  app.use(express.json());
  app.use("/api/products", require("../../routes/products"));
  app.use("/api/sales", require("../../routes/sales"));
  app.use("/api/dashboard", require("../../routes/dashboard"));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

async function api(method, path, body, role = "admin") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[role]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const sell = (productId, quantity, pricing = { price: 10 }) =>
  api("POST", "/sales", {
    isWalkIn: true,
    paymentMethod: "cash",
    salesPerson: "admin-it",
    exchangeRate: pricing.exchangeRate,
    items: [{ productId, quantity, ...pricing }],
  });

const movementsOf = (productId) =>
  StockMovement.find({ product: productId }).sort({ occurredAt: 1, _id: 1 }).lean();

async function assertLedgerMatchesStock() {
  const products = await Product.find().select("stock name").lean();
  const sums = await StockMovement.aggregate([{ $group: { _id: "$product", total: { $sum: "$quantity" } } }]);
  const byProduct = new Map(sums.map((row) => [String(row._id), row.total]));
  for (const product of products) {
    assert.equal(byProduct.get(String(product._id)), product.stock, `ledger of ${product.name}`);
  }
  const total = sums.reduce((sum, row) => sum + row.total, 0);
  const stock = products.reduce((sum, product) => sum + product.stock, 0);
  assert.equal(total, stock, "Σ ledger (incl. deleted products) = Σ current stock");
}

test("a product created during the selected Dashboard period contributes 0 opening, +100 entries and 100 closing", async () => {
  const created = await api("POST", "/products", {
    name: "Créé pendant la période", category: "Test", price: 1, stock: 100, unit: "pcs",
  });
  assert.equal(created.status, 201);
  const today = currentBusinessDate();
  const dashboard = await api("GET", `/dashboard/summary?date=${today}`);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.stock.opening, 0);
  assert.equal(dashboard.body.stock.flows.entries, 100);
  assert.equal(dashboard.body.stock.flows.newProducts, 100);
  assert.equal(dashboard.body.stock.closing, 100);

  // Test isolation only: remove the complete product+ledger fixture directly.
  await StockMovement.deleteMany({ product: created.body._id });
  await Product.deleteOne({ _id: created.body._id });
});

test("legacy products get exactly one baseline, without touching stock or updatedAt", async () => {
  const legacyUpdatedAt = new Date("2025-06-01T10:00:00Z");
  await Product.collection.insertOne({
    name: "Legacy bag", category: "Sacs", stock: 5, minStock: 2, unit: "pcs", status: "active",
    price: 9, createdAt: legacyUpdatedAt, updatedAt: legacyUpdatedAt,
  });
  const quiet = { error: () => {} };
  const [first, second] = await Promise.all([
    ensureStockBaselines({ runTransaction, logger: quiet }),
    ensureStockBaselines({ runTransaction, logger: quiet }),
  ]);
  assert.equal(first.created + second.created, 1, "concurrent runs record one baseline");
  assert.deepEqual(await ensureStockBaselines({ runTransaction }), { created: 0, failed: 0 });

  const legacy = await Product.findOne({ name: "Legacy bag" }).lean();
  assert.equal(legacy.stock, 5);
  assert.equal(legacy.updatedAt.getTime(), legacyUpdatedAt.getTime());
  assert.ok(legacy.stockTrackedSince);
  assert.equal(legacy.lastStockUpdatedAt, undefined, "a baseline is not a stock update");
  const [baseline] = await movementsOf(legacy._id);
  assert.equal(baseline.type, "baseline");
  assert.equal(baseline.quantity, 5);
  await assertLedgerMatchesStock();
});

test("sales, voids, edits, deletes and corrections all go through the ledger atomically", async (t) => {
  const created = await api("POST", "/products", { name: "Sac cabas", category: "Sacs", price: 12.5, stock: 3, minStock: 2 });
  assert.equal(created.status, 201);
  const productId = created.body._id;
  assert.ok(created.body.stockTrackedSince);

  await t.test("FC-priced sale keeps the typed FC value and records one movement", async () => {
    const response = await sell(productId, 2, {
      price: 20000 / 2850, enteredPrice: 20000, enteredCurrency: "FC", exchangeRate: 2850,
    });
    assert.equal(response.status, 201);
    const sale = await Sale.findById(response.body._id).lean();
    assert.equal(sale.items[0].enteredPrice, 20000);
    assert.equal(sale.items[0].enteredCurrency, "FC");
    assert.equal(sale.items[0].priceFC, 20000);
    assert.equal(sale.items[0].exchangeRate, 2850);
    const product = await Product.findById(productId).lean();
    assert.equal(product.stock, 1);
    assert.equal(product.price, 12.5, "selling never rewrites the catalogue price");
    const saleMovement = (await movementsOf(productId)).at(-1);
    assert.equal(saleMovement.type, "sale");
    assert.equal(saleMovement.quantity, -2);
    assert.equal(saleMovement.stockBefore, 3);
    assert.equal(saleMovement.stockAfter, 1);
    assert.equal(String(saleMovement.sale), response.body._id);
    assert.equal(product.lastStockUpdatedAt.getTime(), saleMovement.occurredAt.getTime());
  });

  await t.test("two concurrent sales of the last piece: exactly one succeeds, stock never negative", async () => {
    const results = await Promise.all([sell(productId, 1), sell(productId, 1)]);
    const statuses = results.map((result) => result.status).sort();
    assert.equal(statuses.filter((status) => status === 201).length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.ok([400, 409].includes(statuses.find((status) => status !== 201)));
    const product = await Product.findById(productId).lean();
    assert.equal(product.stock, 0);
    assert.equal(await Sale.countDocuments({ "items.productId": product._id }), 2);
  });

  await t.test("a product at 0 is hidden from NewSale and refused by the server", async () => {
    const sellable = await api("GET", "/products?availability=sellable");
    assert.ok(!sellable.body.some((product) => product._id === productId));
    const all = await api("GET", "/products");
    assert.ok(all.body.some((product) => product._id === productId), "history screens still see it");
    const refused = await sell(productId, 1);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Insufficient stock/);
    const product = await Product.findById(productId).lean();
    assert.equal(product.status, "active", "stock 0 never flips the manual status");
  });

  await t.test("voiding returns the pieces and makes the product sellable again", async () => {
    const [firstSale] = await Sale.find({ "items.productId": new mongoose.Types.ObjectId(productId) }).sort({ createdAt: 1 }).lean();
    const voided = await api("PATCH", `/sales/${firstSale._id}/void`, { reason: "erreur" });
    assert.equal(voided.status, 200);
    assert.equal((await Product.findById(productId).lean()).stock, 2);
    const sellable = await api("GET", "/products?availability=sellable");
    assert.ok(sellable.body.some((product) => product._id === productId));
    const voidMovement = (await movementsOf(productId)).at(-1);
    assert.equal(voidMovement.type, "sale_void");
    assert.equal(voidMovement.quantity, 2);
  });

  await t.test("editing then deleting a sale moves stock through the ledger", async () => {
    const sale = await sell(productId, 1);
    assert.equal(sale.status, 201);
    const edited = await api("PUT", `/sales/${sale.body._id}`, {
      isWalkIn: true, paymentMethod: "cash", reason: "quantité",
      items: [{ productId, quantity: 2, price: 10 }],
    });
    assert.equal(edited.status, 200);
    assert.equal((await Product.findById(productId).lean()).stock, 0);
    const deleted = await api("DELETE", `/sales/${sale.body._id}`);
    assert.equal(deleted.status, 200);
    assert.equal((await Product.findById(productId).lean()).stock, 2);
    const types = (await movementsOf(productId)).slice(-3).map((movement) => [movement.type, movement.quantity]);
    assert.deepEqual(types, [["sale", -1], ["sale_edit", -1], ["sale_delete", 2]]);
  });

  await t.test("product edits: non-stock fields never touch the ledger; stale stock edits are refused", async () => {
    const before = await Product.findById(productId).lean();
    const count = (await movementsOf(productId)).length;
    const renamed = await api("PUT", `/products/${productId}`, { name: "Sac cabas XL", price: 14, stock: 2, expectedStock: 2 });
    assert.equal(renamed.status, 200);
    const after = await Product.findById(productId).lean();
    assert.equal(after.lastStockUpdatedAt.getTime(), before.lastStockUpdatedAt.getTime());
    assert.equal((await movementsOf(productId)).length, count);

    const stale = await api("PUT", `/products/${productId}`, { stock: 10, expectedStock: 7 });
    assert.equal(stale.status, 409);
    assert.equal((await Product.findById(productId).lean()).stock, 2);

    const staleLegacyClient = await api("PUT", `/products/${productId}`, { name: "Ne doit pas passer", stock: 10 });
    assert.equal(staleLegacyClient.status, 409, "an absolute stock write requires expectedStock");
    assert.equal((await Product.findById(productId).lean()).name, "Sac cabas XL", "metadata rolls back with the rejected stock edit");

    const changedUnit = await api("PUT", `/products/${productId}`, { unit: "kg" });
    assert.equal(changedUnit.status, 409, "unit is immutable once inventory history exists");

    const negative = await api("PUT", `/products/${productId}`, { stock: -1 });
    assert.equal(negative.status, 400);

    const corrected = await api("PUT", `/products/${productId}`, { stock: 6, expectedStock: 2, stockReason: "inventaire" });
    assert.equal(corrected.status, 200);
    const correction = (await movementsOf(productId)).at(-1);
    assert.deepEqual([correction.type, correction.quantity, correction.stockBefore, correction.stockAfter, correction.reason],
      ["adjustment", 4, 2, 6, "inventaire"]);
  });

  await t.test("stock-movement endpoint validates and never lets stock go negative", async () => {
    assert.equal((await api("POST", `/products/${productId}/stock-movements`, { type: "restock", quantity: -3 })).status, 400);
    assert.equal((await api("POST", `/products/${productId}/stock-movements`, { type: "adjustment", quantity: -1 })).status, 400);
    const tooMany = await api("POST", `/products/${productId}/stock-movements`, { type: "adjustment", quantity: -7, reason: "casse" });
    assert.equal(tooMany.status, 409);
    const restock = await api("POST", `/products/${productId}/stock-movements`, { type: "restock", quantity: 10 });
    assert.equal(restock.status, 201);
    assert.equal(restock.body.stock, 16);
    assert.equal((await api("POST", `/products/${productId}/stock-movements`, { type: "restock", quantity: 1 }, "manager")).status, 403);
  });

  await assertLedgerMatchesStock();
});

test("a failed ledger insert rolls back the Product increment", async () => {
  const created = await api("POST", "/products", { name: "Rollback", category: "Test", price: 1, stock: 5 });
  const beforeMovements = await StockMovement.countDocuments({ product: created.body._id });
  await assert.rejects(
    runTransaction((session) => applyStockChange({
      productId: created.body._id,
      quantity: 2,
      type: "not-a-real-movement",
      session,
    })),
    /validation/i,
  );
  assert.equal((await Product.findById(created.body._id).lean()).stock, 5);
  assert.equal(await StockMovement.countDocuments({ product: created.body._id }), beforeMovements);
});

test("multiple-item sales and manager-approved edits keep every product ledger transactional", async () => {
  const first = await api("POST", "/products", { name: "Multi A", category: "Test", price: 10, stock: 5 });
  const second = await api("POST", "/products", { name: "Multi B", category: "Test", price: 10, stock: 5 });
  const sale = await api("POST", "/sales", {
    isWalkIn: true,
    paymentMethod: "cash",
    salesPerson: "admin-it",
    items: [
      { productId: first.body._id, quantity: 2, price: 10 },
      { productId: second.body._id, quantity: 3, price: 10 },
    ],
  });
  assert.equal(sale.status, 201);
  assert.equal((await Product.findById(first.body._id).lean()).stock, 3);
  assert.equal((await Product.findById(second.body._id).lean()).stock, 2);

  const proposed = await api("PUT", `/sales/${sale.body._id}`, {
    isWalkIn: true,
    paymentMethod: "cash",
    reason: "quantité corrigée",
    items: [
      { productId: first.body._id, quantity: 1, price: 10 },
      { productId: second.body._id, quantity: 4, price: 10 },
    ],
  }, "manager");
  assert.equal(proposed.status, 202);
  assert.equal((await Product.findById(first.body._id).lean()).stock, 3, "proposal does not change stock");
  assert.equal((await Product.findById(second.body._id).lean()).stock, 2);

  const approved = await api("POST", `/sales/edit-approvals/${sale.body._id}/decision`, { decision: "approved" });
  assert.equal(approved.status, 200);
  assert.equal((await Product.findById(first.body._id).lean()).stock, 4);
  assert.equal((await Product.findById(second.body._id).lean()).stock, 1);
  assert.equal((await movementsOf(first.body._id)).at(-1).type, "sale_edit");
  assert.equal((await movementsOf(second.body._id)).at(-1).type, "sale_edit");

  const voided = await api("PATCH", `/sales/${sale.body._id}/void`, { reason: "test terminé" });
  assert.equal(voided.status, 200);
  assert.equal((await Product.findById(first.body._id).lean()).stock, 5);
  assert.equal((await Product.findById(second.body._id).lean()).stock, 5);
  await assertLedgerMatchesStock();
});

test("a manually inactive product stays inactive and unsellable through zero and replenishment", async () => {
  const created = await api("POST", "/products", { name: "Modèle retiré", category: "Sacs", price: 5, stock: 4, status: "inactive" });
  const productId = created.body._id;
  const refused = await sell(productId, 1);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /inactif/);

  await api("POST", `/products/${productId}/stock-movements`, { type: "adjustment", quantity: -4, reason: "retour fournisseur" });
  const restocked = await api("POST", `/products/${productId}/stock-movements`, { type: "restock", quantity: 10 });
  assert.equal(restocked.body.stock, 10);
  assert.equal(restocked.body.status, "inactive");
  const sellable = await api("GET", "/products?availability=sellable");
  assert.ok(!sellable.body.some((product) => product._id === productId));
  assert.equal((await sell(productId, 1)).status, 400);
  await assertLedgerMatchesStock();
});

test("fiche de stock and dashboard read the same ledger and change nothing", async () => {
  const product = await Product.findOne({ name: "Sac cabas XL" }).lean();
  const fcSale = await Sale.findOne({ "items.enteredCurrency": "FC" }).lean();
  const productsBefore = await Product.find().lean();
  const movementCount = await StockMovement.countDocuments();
  const today = currentBusinessDate();

  const card = await api("GET", `/products/${product._id}/stock-card?date=${today}&limit=4`);
  assert.equal(card.status, 200);
  const { summary, coverage } = card.body;
  assert.equal(coverage.openingKnown, true, "created through the API: tracked from creation");
  assert.equal(summary.opening, 0);
  assert.equal(summary.closing, product.stock);
  assert.equal(summary.currentStock, product.stock);
  assert.deepEqual(summary.flows, {
    baseline: 0,
    entries: 3 + 10, // initial stock + restock
    newProducts: 3,
    // FC sale of 2 was voided the same day and the edited sale was deleted
    // the same day: neither counts. Only the last-piece sale remains.
    piecesOut: 1,
    returns: 0,
    adjustmentsIn: 4,
    adjustmentsOut: 0,
    net: 16,
  });
  assert.equal(summary.opening + summary.flows.entries + summary.flows.returns - summary.flows.piecesOut +
    summary.flows.adjustmentsIn - summary.flows.adjustmentsOut + summary.flows.baseline, summary.closing);
  assert.equal(card.body.integrity.consistent, true);
  assert.equal(new Date(summary.lastStockUpdatedAt).getTime(), product.lastStockUpdatedAt.getTime());
  assert.equal(card.body.movements.length, 4);
  assert.equal(card.body.pagination.totalPages, Math.ceil(card.body.pagination.totalRecords / 4));
  const allRows = [];
  for (let page = 1; page <= card.body.pagination.totalPages; page += 1) {
    allRows.push(...(await api("GET", `/products/${product._id}/stock-card?date=${today}&limit=4&page=${page}`)).body.movements);
  }
  for (let index = 1; index < allRows.length; index += 1) {
    assert.equal(allRows[index].stockBefore, allRows[index - 1].stockAfter, "running balance is continuous");
  }
  assert.equal(allRows.at(-1).stockAfter, product.stock);

  const dashboard = await api("GET", `/dashboard/summary?date=${today}`);
  assert.equal(dashboard.status, 200);
  const stocks = await Product.find().lean();
  assert.equal(dashboard.body.stock.current, stocks.reduce((sum, row) => sum + row.stock, 0));
  assert.equal(dashboard.body.stock.closing, dashboard.body.stock.current);
  // The legacy product's baseline was recorded today: today's opening is not provable.
  assert.equal(dashboard.body.coverage.openingKnown, false);
  assert.equal(dashboard.body.stock.opening, null);
  assert.equal(dashboard.body.stock.flows.baseline, 5);
  assert.ok(dashboard.body.health.becameOutOfStock >= 1);

  const alerts = await api("GET", `/dashboard/stock-alerts?kind=became_out&date=${today}`);
  assert.equal(alerts.status, 200);
  assert.ok(alerts.body.data.some((row) => row.name === "Sac cabas" || row.name === "Sac cabas XL"));
  assert.equal((await api("GET", `/dashboard/summary?date=${today}`, undefined, "manager")).status, 403);

  assert.deepEqual(await Sale.findById(fcSale._id).lean(), fcSale, "historical FC snapshot untouched");
  assert.deepEqual(await Product.find().lean(), productsBefore, "reading never mutates products");
  assert.equal(await StockMovement.countDocuments(), movementCount, "reading never writes the ledger");
});

test("deleting a product writes off its stock and keeps the ledger balanced", async () => {
  const created = await api("POST", "/products", { name: "À supprimer", category: "Sacs", price: 1, stock: 7 });
  const deleted = await api("DELETE", `/products/${created.body._id}`);
  assert.equal(deleted.status, 200);
  const movements = await movementsOf(created.body._id);
  assert.deepEqual(movements.map((movement) => [movement.type, movement.quantity]), [["initial", 7], ["product_delete", -7]]);
  const card = await api("GET", `/products/${created.body._id}/stock-card?date=${currentBusinessDate()}`);
  assert.equal(card.status, 200);
  assert.equal(card.body.product.deleted, true);
  assert.equal(card.body.product.name, "À supprimer");
  assert.equal(card.body.summary.opening, 0);
  assert.equal(card.body.summary.closing, 0);
  assert.equal(card.body.summary.flows.entries, 7);
  assert.equal(card.body.summary.flows.adjustmentsOut, 7);
  assert.equal(card.body.integrity.consistent, true);
  await assertLedgerMatchesStock();
});
