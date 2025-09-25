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

router.post("/register", async (req, res) => {
  try {
    let { username, email, password, role } = req.body || {};
    username = (username || "").trim();
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!required(username, email, password)) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      username,
      email,
      password: hashedPassword,
      role, // optional, depends on your schema defaults/validation
    });

    // Keep response minimal for register; client will switch to login
    return res.status(201).json({
      message: `Welcome ${newUser.username}, you have registered successfully`,
    });
  } catch (error) {
    console.error("Error registering user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
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

    // 3) Create token AFTER successful compare
    const token = generateToken({ id: user._id });

    // 4) Return a safe user payload (don’t send the password/hash)
    const safeUser = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      role: user.role,
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

module.exports = router;