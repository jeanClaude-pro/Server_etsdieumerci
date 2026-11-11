const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

// Every session token is pinned to one algorithm, issuer and audience, carries
// a unique id (jti) so it can be revoked on logout, and the user's
// tokenVersion so all of a user's sessions can be ended at once.
const JWT_ALGORITHM = "HS256";
const JWT_ISSUER = "ets-dieu-merci-api";
const JWT_AUDIENCE = "ets-dieu-merci-app";
const DEFAULT_LIFETIME = "12h";

function tokenLifetime() {
  const configured = String(process.env.JWT_EXPIRES_IN || "").trim();
  return /^\d{1,4}[mhd]$/.test(configured) ? configured : DEFAULT_LIFETIME;
}

function generateToken(user) {
  const id = user?._id ?? user?.id;
  if (!id) throw new Error("Cannot issue a session token without a user id");
  return jwt.sign(
    { id: String(id), v: Number(user.tokenVersion) || 0 },
    process.env.JWT_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      expiresIn: tokenLifetime(),
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      jwtid: crypto.randomUUID(),
    }
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

module.exports = generateToken;
module.exports.generateToken = generateToken;
module.exports.verifyToken = verifyToken;
module.exports.tokenLifetime = tokenLifetime;
