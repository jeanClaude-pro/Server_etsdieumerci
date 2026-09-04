const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const usersRoute = fs.readFileSync(path.join(__dirname, "../routes/users.js"), "utf8");
const adminPanel = fs.readFileSync(
  path.join(__dirname, "../../client/src/pages/admin/AdminPanel.tsx"),
  "utf8"
);

test("admin account creation uses matching password constraints", () => {
  assert.match(usersRoute, /password\.length < 10 \|\| password\.length > 128/);
  assert.match(adminPanel, /createForm\.password\.length < 10 \|\| createForm\.password\.length > 128/);
  assert.match(adminPanel, /minLength=\{10\}/);
  assert.match(adminPanel, /maxLength=\{128\}/);
});

test("created account is returned safely and added to the administration list", () => {
  assert.match(usersRoute, /res\.status\(201\)\.json\(userResponse\)/);
  assert.match(adminPanel, /const createdUser = \(await res\.json\(\)\) as AppUser/);
  assert.match(adminPanel, /setUsers\(\(previousUsers\) => \[createdUser, \.\.\.previousUsers\]\)/);
});
