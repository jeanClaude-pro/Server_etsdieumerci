// routes/auth.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const { rateLimit } = require("express-rate-limit");
const authMiddleware = require("../middleware/auth");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Please try again later." },
});

// Helper: basic field guard
function required(...fields) {
  return fields.every((f) => typeof f === "string" && f.trim().length > 0);
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
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!required(email, password) || email.length > 254 || password.length > 128 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    // 1) DO NOT exclude password here; we need it to compare
    // If your schema had `select: false` for password, you'd use `.select("+password")` instead.
    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      res.locals.audit = { summary: { reason: "unknown_email" } };
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // 2) Compare plain password with stored hash
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      res.locals.auditActor = user;
      res.locals.audit = { summary: { reason: "wrong_password" } };
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // 2b) Check if account is active
    if (!user.isActive) {
      res.locals.auditActor = user;
      return res.status(403).json({ message: "Votre compte a été désactivé. Contactez un administrateur." });
    }

    res.locals.auditActor = user;
    // 3) Create token AFTER successful compare
    const token = generateToken({ id: user._id });

    // 4) Return a safe user payload (don’t send the password/hash)
    const safeUser = {
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

    // Optional: console.log minimal info (avoid logging tokens in prod)
    console.log("User logged in:", safeUser.id);

    return res.status(200).json({ user: safeUser, token });
  } catch (error) {
    console.error("Error logging in user:", error);
    return res.status(500).json({ message: "Internal server error" });
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
    const password = String(req.body?.password || "");
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
    console.error("Password verification error:", error);
    return res.status(500).json({ verified: false, message: "Internal server error" });
  }
});

module.exports = router;
