const User = require("../models/User");

async function isAdmin(req, res, next) {
  try {
    // req.user was set by authMiddleware
    const user = await User.findById(req.user._id).select("role");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.role !== "admin") {
      return res.status(403).json({ message: "Access denied: Admins only" });
    }

    next(); // ✅ user is admin
  } catch (err) {
    console.error("isAdmin middleware error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = isAdmin;
