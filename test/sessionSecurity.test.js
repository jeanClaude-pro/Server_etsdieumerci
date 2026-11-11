const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { once } = require("node:events");

process.env.JWT_SECRET = process.env.JWT_SECRET || "session-security-test-secret-0123456789abcdef";

const User = require("../models/User");
const { tokenFor, mockSessionStore } = require("./helpers/auth");

const ADMIN_ID = "507f1f77bcf86cd799439011";
const CASHIER_ID = "507f1f77bcf86cd799439012";
const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

async function startServer(t, users) {
  const revoked = mockSessionStore(t);
  t.mock.method(User, "findById", (id) => {
    const user = users[String(id)] || null;
    const result = Promise.resolve(user);
    result.select = async () => user;
    return result;
  });
  t.mock.method(User, "findOne", ({ email }) => ({
    select: async () => Object.values(users).find((user) => user.email === email) || null,
  }));
  t.mock.method(User, "updateOne", async (filter, update) => {
    const user = users[String(filter._id)];
    if (user && update.$inc?.tokenVersion) user.tokenVersion = (user.tokenVersion || 0) + update.$inc.tokenVersion;
    return { acknowledged: true };
  });

  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/users", require("../routes/users"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, route, token, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { call, revoked };
}

function makeUsers() {
  const base = (id, role, extra = {}) => ({
    _id: { toString: () => id },
    username: role,
    email: `${role}@shop.test`,
    role,
    isActive: true,
    permissions: [],
    actionPermissions: [],
    tokenVersion: 0,
    ...extra,
  });
  return {
    [ADMIN_ID]: base(ADMIN_ID, "admin"),
    [CASHIER_ID]: base(CASHIER_ID, "cashier_supervisor", { password: bcrypt.hashSync("correct-horse-battery", 4) }),
  };
}

test("the server, not the browser, confirms who is signed in", async (t) => {
  const users = makeUsers();
  const { call } = await startServer(t, users);

  const session = await call("GET", "/auth/session", tokenFor(CASHIER_ID));
  assert.equal(session.status, 200);
  assert.equal(session.body.user.role, "cashier_supervisor");
  assert.equal(session.body.user.password, undefined);

  assert.equal((await call("GET", "/auth/session")).status, 401);
  assert.equal((await call("GET", "/auth/session", "not-a-token")).status, 401);
});

test("logout ends the session on the server: the same token is refused afterwards", async (t) => {
  const { call } = await startServer(t, makeUsers());
  const token = tokenFor(CASHIER_ID);
  assert.equal((await call("GET", "/auth/session", token)).status, 200);
  assert.equal((await call("POST", "/auth/logout", token)).status, 200);
  assert.equal((await call("GET", "/auth/session", token)).status, 401);
  // Another session of the same user is not affected by this logout.
  assert.equal((await call("GET", "/auth/session", tokenFor(CASHIER_ID))).status, 200);
});

test("logout-all and deactivation end every session of the user", async (t) => {
  const users = makeUsers();
  const { call } = await startServer(t, users);
  const first = tokenFor(CASHIER_ID);
  const second = tokenFor(CASHIER_ID);
  assert.equal((await call("POST", "/auth/logout-all", first)).status, 200);
  assert.equal((await call("GET", "/auth/session", second)).status, 401);

  users[CASHIER_ID].isActive = false;
  const disabled = await call("GET", "/auth/session", tokenFor(CASHIER_ID, users[CASHIER_ID].tokenVersion));
  assert.equal(disabled.status, 401);
  assert.equal(disabled.body.code, "ACCOUNT_DISABLED");
});

test("forged or loosely signed tokens are refused", async (t) => {
  const { call } = await startServer(t, makeUsers());
  const legacy = jwt.sign({ id: ADMIN_ID }, process.env.JWT_SECRET, { expiresIn: "1h" });
  assert.equal((await call("GET", "/auth/session", legacy)).status, 401);

  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ id: ADMIN_ID, v: 0, jti: "x" })).toString("base64url")}.`;
  assert.equal((await call("GET", "/auth/session", unsigned)).status, 401);

  const wrongKey = jwt.sign({ id: ADMIN_ID, v: 0 }, "another-secret-0123456789abcdef0123456789", {
    issuer: "ets-dieu-merci-api", audience: "ets-dieu-merci-app", jwtid: "y", expiresIn: "1h",
  });
  assert.equal((await call("GET", "/auth/session", wrongKey)).status, 401);
});

test("login answers the same way for an unknown email and a wrong password", async (t) => {
  const { call } = await startServer(t, makeUsers());
  const unknown = await call("POST", "/auth/login", null, { email: "nobody@shop.test", password: "whatever-123" });
  const wrong = await call("POST", "/auth/login", null, { email: "cashier_supervisor@shop.test", password: "wrong-password" });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body);

  const ok = await call("POST", "/auth/login", null, { email: "cashier_supervisor@shop.test", password: "correct-horse-battery" });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.token, "string");
  assert.equal(ok.body.user.password, undefined);
  assert.equal((await call("GET", "/auth/session", ok.body.token)).status, 200);

  const operator = await call("POST", "/auth/login", null, { email: { $ne: null }, password: "x" });
  assert.equal(operator.status, 400);
});

test("user management refuses unknown permissions and self lock-out", async (t) => {
  const { call } = await startServer(t, makeUsers());
  const admin = tokenFor(ADMIN_ID);
  const bogus = await call("PUT", `/users/${CASHIER_ID}/permissions`, admin, { permissions: ["/", "/../../etc"] });
  assert.equal(bogus.status, 400);
  const bogusAction = await call("PUT", `/users/${CASHIER_ID}/actions`, admin, { actionPermissions: ["<script>"] });
  assert.equal(bogusAction.status, 400);
  assert.equal((await call("PUT", `/users/${ADMIN_ID}/status`, admin)).status, 400);
  assert.equal((await call("PUT", `/users/${ADMIN_ID}/role`, admin, { role: "staff" })).status, 400);
  assert.equal((await call("POST", `/users/${CASHIER_ID}/revoke-sessions`, tokenFor(CASHIER_ID))).status, 403);
  assert.equal((await call("POST", `/users/${CASHIER_ID}/revoke-sessions`, admin)).status, 200);
});

test("debug leftovers are gone from the server", () => {
  const index = read("index.js");
  assert.doesNotMatch(index, /routes\/test/);
  assert.match(index, /NODE_ENV === "production" && process\.env\.DEBUG_LOGS !== "true"/);
  assert.match(index, /app\.use\("\/api", apiLimiter\)/);
  assert.doesNotMatch(read("utils/generateToken.js"), /console\./);
  assert.doesNotMatch(read("routes/auth.js"), /console\.log/);
});
