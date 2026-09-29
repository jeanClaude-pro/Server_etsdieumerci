const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { once } = require("node:events");
const { Aggregator } = require("mingo");
const User = require("../models/User");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const Sale = require("../models/Sale");

// Real Express routes, authentication and admin middleware. Collections are
// in-memory arrays; every aggregation pipeline the routes build is executed
// unchanged by mingo. Every write method is booby-trapped.

const ROLES = ["admin", "manager", "inventory_manager", "cashier_supervisor", "staff"];
const WRITE_METHODS = [
  "create", "insertMany", "updateOne", "updateMany", "replaceOne", "bulkWrite",
  "findOneAndUpdate", "findByIdAndUpdate", "findOneAndReplace",
  "deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndDelete",
];

const at = (iso) => new Date(iso);
const tracked = at("2025-01-01T06:00:00Z");
const baseProduct = (id, name, stock, minStock, status = "active") => ({
  _id: id, name, category: "Sacs", brand: "", unit: "pcs", price: 12.5, stock, minStock, status,
  stockTrackedSince: tracked, lastStockUpdatedAt: tracked,
});

function fixtures() {
  const products = [
    baseProduct("P1", "Sac noir", 0, 5),
    baseProduct("P2", "Sac bleu", 3, 10),
    baseProduct("P3", "Sac rouge", 10, 10),
    baseProduct("P4", "Valise", 50, 0),
    baseProduct("P5", "Retiré vide", 0, 0, "inactive"),
    baseProduct("P6", "Retiré stock", 8, 10, "inactive"),
  ];
  let n = 0;
  const move = (product, type, quantity, iso, stockAfter, sale = null) => ({
    _id: `M${++n}`, product, productName: product, productCategory: "Sacs", type, quantity,
    productUnit: "pcs", productUnitKey: "piece",
    stockBefore: stockAfter - quantity, stockAfter, occurredAt: at(iso), sale, saleNumber: sale, reason: "",
  });
  const movements = [
    move("P1", "baseline", 5, "2025-01-01T06:00:00Z", 5),
    move("P2", "baseline", 3, "2025-01-01T06:00:00Z", 3),
    move("P3", "baseline", 10, "2025-01-01T06:00:00Z", 10),
    move("P4", "baseline", 40, "2025-01-01T06:00:00Z", 40),
    move("P5", "baseline", 0, "2025-01-01T06:00:00Z", 0),
    move("P6", "baseline", 8, "2025-01-01T06:00:00Z", 8),
    // Business day 2025-03-10 (Lubumbashi, UTC+2).
    move("P1", "sale", -5, "2025-03-10T08:00:00Z", 0, "S1"),
    move("P4", "restock", 20, "2025-03-10T09:00:00Z", 60),
    move("P4", "sale", -12, "2025-03-10T10:00:00Z", 48, "S2"),
    move("P4", "sale", -4, "2025-03-10T11:00:00Z", 44, "S3"),
    move("P4", "sale_void", 4, "2025-03-10T12:00:00Z", 48, "S3"),
    move("P4", "adjustment", -1, "2025-03-10T13:00:00Z", 47),
    // Next business day: after the period.
    move("P4", "restock", 3, "2025-03-11T08:00:00Z", 50),
  ];
  // A historical FC sale: the dashboard must never read or rewrite it.
  const sales = [{
    _id: "S2", status: "completed", type: "sale", total: 7.017543859649122, exchangeRate: 2850,
    items: [{ productId: "P4", quantity: 12, enteredPrice: 20000, enteredCurrency: "FC", priceFC: 20000,
      priceUSD: 20000 / 2850, price: 20000 / 2850, exchangeRate: 2850 }],
  }];
  return { products, movements, sales };
}

function aggregateResult(promise) {
  return { allowDiskUse: () => promise, then: (resolve, reject) => promise.then(resolve, reject) };
}

async function startApp(t, data) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "dashboard-api-test-secret-0123456789abcdef";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  t.mock.method(User, "findById", (id) => {
    const user = ROLES.includes(id) ? { _id: id, username: id, role: id, isActive: true } : null;
    const promise = Promise.resolve(user);
    return { select: () => promise, then: (resolve, reject) => promise.then(resolve, reject) };
  });

  const collections = { [Product.collection.name]: data.products, [StockMovement.collection.name]: data.movements };
  const run = (pipeline, rows) =>
    aggregateResult(Promise.resolve(new Aggregator(pipeline, { collectionResolver: (name) => collections[name] || [] }).run(rows)));
  t.mock.method(Product, "aggregate", (pipeline) => run(pipeline, data.products));
  t.mock.method(StockMovement, "aggregate", (pipeline) => run(pipeline, data.movements));

  const writes = [];
  for (const Model of [Product, StockMovement, Sale]) {
    for (const method of WRITE_METHODS) {
      t.mock.method(Model, method, () => {
        writes.push(`${Model.modelName}.${method}`);
        throw new Error("write attempted");
      });
    }
    for (const method of ["aggregate", "find", "findOne", "findById"]) {
      if (Model === Sale) t.mock.method(Model, method, () => { writes.push(`Sale.${method}`); throw new Error("sale read"); });
    }
  }
  t.mock.method(Product.prototype, "save", () => { writes.push("Product.save"); throw new Error("write attempted"); });

  const app = express();
  app.use(express.json());
  app.use("/api/dashboard", require("../routes/dashboard"));
  app.use("/api/products", require("../routes/products"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokenFor = (role) => jwt.sign({ id: role }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const get = async (path, role = "admin") => {
    const response = await fetch(`${base}${path}`, role ? { headers: { Authorization: `Bearer ${tokenFor(role)}` } } : {});
    return { status: response.status, body: await response.json() };
  };
  return { get, writes };
}

const PROTECTED = [
  "/dashboard/summary?date=2025-03-10",
  "/dashboard/stock-alerts?kind=low",
  "/products/507f1f77bcf86cd799439011/stock-card?date=2025-03-10",
];

test("dashboard and fiche de stock endpoints reject anonymous and non-admin users", async (t) => {
  const { get } = await startApp(t, fixtures());
  for (const path of PROTECTED) {
    assert.equal((await get(path, null)).status, 401, `anonymous ${path}`);
    for (const role of ROLES.filter((role) => role !== "admin")) {
      const response = await get(path, role);
      assert.equal(response.status, 403, `${role} ${path}`);
      assert.equal(response.body.message, "Access denied: Admins only");
    }
  }
});

test("admin summary reconstructs the day from the ledger and never writes", async (t) => {
  const data = fixtures();
  const before = structuredClone(data);
  const { get, writes } = await startApp(t, data);

  const { status, body } = await get("/dashboard/summary?date=2025-03-10");
  assert.equal(status, 200);
  assert.equal(body.period.start, "2025-03-09T22:00:00.000Z");
  assert.equal(body.period.end, "2025-03-10T21:59:59.999Z");
  assert.equal(body.coverage.openingKnown, true);
  assert.equal(body.coverage.closingKnown, true);
  assert.deepEqual(body.stock, {
    unit: "piece",
    opening: 66,
    closing: 68,
    current: 71,
    flows: {
      baseline: 0, entries: 20, newProducts: 0,
      piecesOut: 17, // 5 + 12; the 4 pieces sold then voided the same day never count
      returns: 0, adjustmentsIn: 0, adjustmentsOut: 1, net: 2,
    },
  });
  assert.deepEqual(body.health, {
    products: 6, pieceProducts: 6, active: 4, inactive: 2, sellable: 3, outOfStock: 1, lowStock: 2, becameOutOfStock: 1,
  });
  assert.deepEqual(body.activity, { sale: 3, restock: 1, sale_void: 1, adjustment: 1 });
  assert.deepEqual(body.attention.map((row) => [row.name, row.stock, row.minStock, row.gap]), [
    ["Sac noir", 0, 5, 5],
    ["Sac bleu", 3, 10, 7],
    ["Sac rouge", 10, 10, 0],
  ]);
  assert.deepEqual(body.series, [{ key: "2025-03-10", net: 2, level: 68 }]);

  assert.deepEqual(writes, []);
  assert.deepEqual(data, before, "products, ledger and FC sale snapshot are byte-for-byte unchanged");
  assert.equal(data.sales[0].items[0].enteredPrice, 20000);
  assert.equal(data.sales[0].items[0].enteredCurrency, "FC");
  assert.equal(data.products[3].price, 12.5);
});

test("mixed kg/lbs quantities are reported separately and excluded from pieces", async (t) => {
  const data = fixtures();
  data.products.push(
    { ...baseProduct("KG", "Farine", 50, 5), unit: "kg" },
    { ...baseProduct("LB", "Coton", 20, 5), unit: "lbs" },
  );
  data.movements.push(
    { _id: "MKG", product: "KG", productName: "Farine", productCategory: "Vrac", productUnit: "kg", productUnitKey: "kg", type: "baseline", quantity: 50, stockBefore: 0, stockAfter: 50, occurredAt: tracked },
    { _id: "MLB", product: "LB", productName: "Coton", productCategory: "Vrac", productUnit: "lbs", productUnitKey: "lbs", type: "baseline", quantity: 20, stockBefore: 0, stockAfter: 20, occurredAt: tracked },
  );
  const { get } = await startApp(t, data);
  const { status, body } = await get("/dashboard/summary?date=2025-03-10");
  assert.equal(status, 200);
  assert.equal(body.stock.current, 71, "50 kg and 20 lbs are not added to pieces");
  assert.equal(body.stock.closing, 68);
  assert.deepEqual(
    body.units.map(({ unit, quantity }) => [unit, quantity]).sort(),
    [["kg", 50], ["lbs", 20], ["pcs", 71]],
  );
  assert.equal(body.categories.reduce((sum, row) => sum + row.pieces, 0), 71);
});

test("a period older than the ledger baseline is reported as not reconstructible", async (t) => {
  const { get } = await startApp(t, fixtures());
  const { status, body } = await get("/dashboard/summary?date=2024-12-31");
  assert.equal(status, 200);
  assert.equal(body.coverage.openingKnown, false);
  assert.equal(body.coverage.closingKnown, false);
  assert.equal(body.stock.opening, null);
  assert.equal(body.stock.closing, null);
  assert.equal(body.stock.flows, null);
  assert.equal(body.stock.current, 71);
});

test("stock alerts are paginated on the server and ranked by urgency", async (t) => {
  const data = fixtures();
  for (let index = 0; index < 45; index += 1) {
    data.products.push(baseProduct(`L${index}`, `Article ${String(index).padStart(2, "0")}`, 1, 100));
  }
  const { get, writes } = await startApp(t, data);

  const low = await get("/dashboard/stock-alerts?kind=low&page=3&limit=20");
  assert.equal(low.status, 200);
  assert.deepEqual(low.body.pagination, {
    page: 3, limit: 20, totalRecords: 47, totalPages: 3, hasNextPage: false, hasPreviousPage: true,
  });
  assert.deepEqual(low.body.data.map((row) => row.name), ["Article 40", "Article 41", "Article 42", "Article 43", "Article 44", "Sac bleu", "Sac rouge"]);
  assert.equal(low.body.data[5].gap, 7);

  const out = await get("/dashboard/stock-alerts?kind=out");
  assert.deepEqual(out.body.data.map((row) => row.name), ["Sac noir"], "manually inactive products are not stock alerts");

  const search = await get("/dashboard/stock-alerts?kind=low&search=bleu");
  assert.deepEqual(search.body.data.map((row) => row.name), ["Sac bleu"]);

  const becameOut = await get("/dashboard/stock-alerts?kind=became_out&date=2025-03-10");
  assert.equal(becameOut.body.pagination.totalRecords, 1);
  assert.equal(becameOut.body.data[0].name, "P1");
  assert.equal(becameOut.body.data[0].stock, 0);
  assert.equal(becameOut.body.data[0].deleted, false);

  assert.equal((await get("/dashboard/stock-alerts?kind=everything")).status, 400);
  assert.equal((await get("/dashboard/summary?date=2999-01-01")).status, 400);
  assert.equal((await get("/dashboard/summary?date=2025-02-30")).status, 400);
  assert.deepEqual(writes, []);
});
