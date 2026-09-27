const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildWalkInCustomer,
  WALK_IN_DEFAULT_NAME,
  WALK_IN_NAME_MAX_LENGTH,
} = require("../utils/walkInCustomer");

test("walk-in without a name keeps the historical default label", () => {
  assert.deepEqual(buildWalkInCustomer(undefined), { name: WALK_IN_DEFAULT_NAME, phone: "", email: "" });
  assert.deepEqual(buildWalkInCustomer({ name: "   " }), { name: WALK_IN_DEFAULT_NAME, phone: "", email: "" });
});

test("walk-in may carry an optional display name", () => {
  assert.deepEqual(buildWalkInCustomer({ name: "  Jean   Mukendi " }), { name: "Jean Mukendi", phone: "", email: "" });
});

test("walk-in never stores contact details, even if the client sends them", () => {
  const customer = buildWalkInCustomer({ name: "Jean", phone: "+243 990 000 000", email: "jean@example.com" });
  assert.equal(customer.phone, "");
  assert.equal(customer.email, "");
});

test("walk-in name is bounded and ignores non-string input", () => {
  assert.equal(buildWalkInCustomer({ name: "x".repeat(200) }).name.length, WALK_IN_NAME_MAX_LENGTH);
  assert.equal(buildWalkInCustomer({ name: 42 }).name, WALK_IN_DEFAULT_NAME);
});

test("sale routes still never create or update a Customer for walk-in sales", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "sales.js"), "utf8");
  assert.match(source, /saleData\.customerId = walkIn\s*\?\s*null\s*:\s*await updateCustomerData/);
  assert.match(source, /let newCustomerId = walkIn \? null/);
  assert.equal((source.match(/buildWalkInCustomer\(customer\)/g) || []).length, 2);
  assert.doesNotMatch(source, /name: "Client de passage"/);
});
