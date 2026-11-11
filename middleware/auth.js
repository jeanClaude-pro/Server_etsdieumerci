const User = require("../models/User");
const RevokedToken = require("../models/RevokedToken");
const { verifyToken } = require("../utils/generateToken");

function reject(res, message = "Authentication required") {
  return res.status(401).json({ code: "SESSION_INVALID", message });
}

// Every protected request is decided here, on the server: the token must be
// correctly signed, unexpired, not logged out, issued for the user's current
// session generation, and the account must still exist and be active.
async function authMiddleware(req, res, next) {
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length > 2048) return reject(res);

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return reject(res);
  }
  if (!decoded || typeof decoded.id !== "string" || typeof decoded.jti !== "string") {
    return reject(res);
  }

  let user;
  let revoked;
  try {
    [user, revoked] = await Promise.all([
      User.findById(decoded.id),
      RevokedToken.exists({ jti: decoded.jti }),
    ]);
  } catch (error) {
    if (error?.name === "CastError") return reject(res);
    console.error("Authentication lookup failed:", error?.name || "Error");
    return res.status(503).json({ message: "Service temporarily unavailable" });
  }

  if (!user || revoked) return reject(res);
  if ((Number(decoded.v) || 0) !== (Number(user.tokenVersion) || 0)) return reject(res);

  if (!user.isActive) {
    // 401 (not 403) so the app ends the session at once instead of staying
    // open on a disabled account.
    res.locals.auditActor = user;
    return res.status(401).json({ code: "ACCOUNT_DISABLED", message: "Votre compte a été désactivé. Contactez un administrateur." });
  }

  req.user = user;
  req.auth = { jti: decoded.jti, exp: decoded.exp };
  req.user.canValidate = user.role === "admin" || user.role === "manager";
  req.user.isAdmin = user.role === "admin";
  req.user.id = user._id.toString();
  req.user.userId = user._id.toString();

  next();
}

module.exports = authMiddleware;
