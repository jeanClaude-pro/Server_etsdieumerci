const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const routeFiles = fs.readdirSync(path.join(__dirname, "..", "routes")).map((file) => `routes/${file}`);

test("no route changes Product.stock directly: every change goes through the ledger helper", () => {
  for (const file of routeFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /\$inc:\s*\{\s*stock/, `${file} increments stock directly`);
    assert.doesNotMatch(source, /updateData\.stock\s*=/, `${file} sets an absolute stock`);
  }
  const ledger = read("utils/stockLedger.js");
  assert.match(ledger, /\$inc: \{ stock: delta \}/);
  assert.match(ledger, /StockMovement\.insertMany\(movements, \{ session \}\)/);
});

test("seeded stock is created with its initial ledger movement in one transaction", () => {
  const seed = read("utils/seed.js");
  assert.match(seed, /runTransaction\(async \(session\)/);
  assert.match(seed, /Product\.insertMany\(seeded, \{ ordered: false, session \}\)/);
  assert.match(seed, /recordInitialStock\(product, \{ session, at \}\)/);
});

test("stock movements expose no mutation route and carry immutable unit snapshots", () => {
  const movement = read("models/StockMovement.js");
  assert.match(movement, /productUnit:/);
  assert.match(movement, /productUnitKey:/);
  for (const file of routeFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /StockMovement\.(update|findOneAndUpdate|delete|findOneAndDelete)/, file);
  }
});

test("every sale path records its own movement type inside the sale transaction", () => {
  const sales = read("routes/sales.js");
  for (const type of ["sale", "sale_edit", "sale_void", "sale_delete"]) {
    assert.match(sales, new RegExp(`type: "${type}",\\s*session,`), type);
  }
  assert.match(sales, /requireActive: quantity < 0/);
  assert.match(sales, /if \(product\.status !== "active"\)/);
});

test("the dashboard route is admin-only and read-only", () => {
  const dashboard = read("routes/dashboard.js");
  assert.match(dashboard, /router\.use\(authMiddleware, isAdmin\)/);
  assert.doesNotMatch(dashboard, /router\.(post|put|patch|delete)\(/);
  assert.doesNotMatch(dashboard, /\.(save|create|insertMany|updateOne|updateMany|findOneAndUpdate|bulkWrite|deleteOne|deleteMany)\(/);
  assert.doesNotMatch(dashboard, /require\("\.\.\/models\/(Sale|ExchangeRate)"\)/, "no monetary or rate data is read");
  const index = read("index.js");
  assert.match(index, /app\.use\("\/api\/dashboard", require\("\.\/routes\/dashboard"\)\)/);
});

test("the fiche de stock endpoint is admin-only like exact stock figures elsewhere", () => {
  assert.match(read("routes/products.js"), /router\.get\("\/:id\/stock-card", authMiddleware, isAdmin,/);
  assert.match(read("routes/products.js"), /router\.post\("\/:id\/stock-movements", authMiddleware, isAdmin,/);
});
