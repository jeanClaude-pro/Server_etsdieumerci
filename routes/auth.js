// routes/auth.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");

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

router.post("/login", async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!required(email, password)) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    // 1) DO NOT exclude password here; we need it to compare
    // If your schema had `select: false` for password, you'd use `.select("+password")` instead.
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // 2) Compare plain password with stored hash
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // 2b) Check if account is active
    if (!user.isActive) {
      return res.status(403).json({ message: "Votre compte a été désactivé. Contactez un administrateur." });
    }

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
//hello
module.exports = router;