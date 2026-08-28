const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { preventNoSqlInjection, requireRole } = require("../middleware/security");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("protected business routers enforce server-side authentication", () => {
  assert.match(read("routes/categories.js"), /router\.use\(authMiddleware\)/);
  assert.match(read("routes/customers.js"), /router\.use\(authMiddleware\)/);
  assert.match(read("routes/products.js"), /router\.get\("\/", authMiddleware/);
  assert.match(read("routes/exchangeRates.js"), /router\.get\("\/current", authMiddleware/);
});

test("login is rate limited and password hashes are excluded by default", () => {
  assert.match(read("routes/auth.js"), /router\.post\("\/login", loginLimiter/);
  assert.match(read("models/User.js"), /password:[\s\S]*?select: false/);
  assert.match(read("routes/auth.js"), /\.select\("\+password"\)/);
});

test("NoSQL operators are rejected before reaching routes", () => {
  let status;
  let payload;
  preventNoSqlInjection(
    { body: { email: { $ne: null } }, query: {} },
    { status(code) { status = code; return this; }, json(value) { payload = value; } },
    () => assert.fail("operator payload must not continue")
  );
  assert.equal(status, 400);
  assert.deepEqual(payload, { message: "Invalid request" });
});

test("role middleware rejects staff and allows admin", () => {
  const guard = requireRole("admin");
  let status;
  guard({ user: { role: "staff" } }, { status(code) { status = code; return this; }, json() {} }, () => assert.fail());
  assert.equal(status, 403);
  let allowed = false;
  guard({ user: { role: "admin" } }, {}, () => { allowed = true; });
  assert.equal(allowed, true);
});

test("sensitive mutation protections are present", () => {
  assert.match(read("routes/categories.js"), /Category\.create\(\{ name, description \}\)/);
  assert.match(read("routes/sales.js"), /Only admins can delete sales/);
  assert.doesNotMatch(read("routes/categories.js"), /Category\.create\(req\.body\)/);
});
