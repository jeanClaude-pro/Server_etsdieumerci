// routes/auth.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const RevokedToken = require("../models/RevokedToken");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const { rateLimit } = require("express-rate-limit");
const authMiddleware = require("../middleware/auth");

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so a wrong email takes as long
// as a wrong password and the response time does not reveal which accounts exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("no-account-placeholder-password", BCRYPT_ROUNDS);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Please try again later." },
});

const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});

// Helper: basic field guard
function required(...fields) {
  return fields.every((f) => typeof f === "string" && f.trim().length > 0);
}

// The only user shape ever sent to the browser. The app renders menus and
// screens from THIS (fetched from the server), never from what it stored.
function safeUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    permissions: user.permissions || [],
    actionPermissions: user.actionPermissions || [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// Public self-registration is disabled. User creation is admin-only via /api/users.
router.post("/register", (_req, res) => {
  res.status(403).json({
    message:
      "L'inscription publique est désactivée. Contactez un administrateur pour créer un compte.",
  });
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = typeof email === "string" ? email.trim().toLowerCase() : "";
    password = typeof password === "string" ? password : "";

    if (!required(email, password) || email.length > 254 || password.length > 128 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      res.locals.audit = { summary: { reason: "unknown_email" } };
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      res.locals.auditActor = user;
      res.locals.audit = { summary: { reason: "wrong_password" } };
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (!user.isActive) {
      res.locals.auditActor = user;
      return res.status(403).json({ message: "Votre compte a été désactivé. Contactez un administrateur." });
    }

    // Upgrade older, weaker password hashes transparently on a correct login.
    try {
      if (bcrypt.getRounds(user.password) < BCRYPT_ROUNDS) {
        const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await User.updateOne({ _id: user._id }, { $set: { password: upgraded } });
      }
    } catch {
      // Never block a valid login on the upgrade.
    }

    res.locals.auditActor = user;
    const token = generateToken(user);
    return res.status(200).json({ user: safeUser(user), token });
  } catch (error) {
    console.error("Login error:", error?.name || "Error");
    return res.status(500).json({ message: "Internal server error" });
  }
});

// The app asks this on start, on focus and periodically. Only the server's
// answer decides whether the session is open and what the user may see.
router.get("/session", sessionLimiter, authMiddleware, (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ user: safeUser(req.user), expiresAt: req.auth.exp ? req.auth.exp * 1000 : null });
});

// Ends THIS session on the server: the token stops working immediately,
// even if someone copied it.
router.post("/logout", sessionLimiter, authMiddleware, async (req, res) => {
  try {
    const expiresAt = new Date((req.auth.exp || Math.floor(Date.now() / 1000) + 86400) * 1000);
    await RevokedToken.updateOne(
      { jti: req.auth.jti },
      { $setOnInsert: { jti: req.auth.jti, user: req.user._id, reason: "logout", expiresAt } },
      { upsert: true }
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error?.name || "Error");
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Ends EVERY session of the signed-in user (all devices).
router.post("/logout-all", sessionLimiter, authMiddleware, async (req, res) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    return res.json({ success: true });
  } catch (error) {
    console.error("Logout-all error:", error?.name || "Error");
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Re-confirms the signed-in user's password before a sensitive screen or
// document (reports, official PDF). Issues no token and changes nothing.
const verifyPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many attempts. Please try again later." },
});

router.post("/verify-password", authMiddleware, verifyPasswordLimiter, async (req, res) => {
  try {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || password.length > 128) {
      return res.status(400).json({ verified: false, message: "Missing password" });
    }
    const user = await User.findById(req.user._id).select("+password");
    const verified = Boolean(user && user.isActive && await bcrypt.compare(password, user.password));
    if (!verified) {
      res.locals.audit = { summary: { reason: "wrong_password", purpose: String(req.body?.purpose || "").slice(0, 40) } };
      // 422, not 401: a mistyped confirmation must not end the session.
      return res.status(422).json({ verified: false, message: "Invalid password" });
    }
    res.locals.audit = { summary: { purpose: String(req.body?.purpose || "").slice(0, 40) } };
    return res.json({ verified: true });
  } catch (error) {
    console.error("Password verification error:", error?.name || "Error");
    return res.status(500).json({ verified: false, message: "Internal server error" });
  }
});

module.exports = router;
module.exports.safeUser = safeUser;
module.exports.BCRYPT_ROUNDS = BCRYPT_ROUNDS;
