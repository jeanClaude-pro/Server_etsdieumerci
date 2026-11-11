// Test helpers: real session tokens (same signing rules as production) and an
// in-memory stand-in for the logout list, so route tests need no database.
const generateToken = require("../../utils/generateToken");
const RevokedToken = require("../../models/RevokedToken");

function tokenFor(id, tokenVersion = 0) {
  return generateToken({ _id: id, tokenVersion });
}

function mockSessionStore(t, revokedJtis = new Set()) {
  t.mock.method(RevokedToken, "exists", async (filter) => (revokedJtis.has(filter?.jti) ? { _id: filter.jti } : null));
  t.mock.method(RevokedToken, "updateOne", async (filter) => {
    revokedJtis.add(filter.jti);
    return { acknowledged: true, upsertedCount: 1 };
  });
  return revokedJtis;
}

module.exports = { tokenFor, mockSessionStore };
