const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function authMiddleware(req, res, next) {
  // Get token from header
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = user;
    
    // ✅ ADD THESE PERMISSION FLAGS
    req.user.canValidate = user.role === 'admin' || user.role === 'manager';
    req.user.isAdmin = user.role === 'admin';
    
    // ✅ Also add these for compatibility
    req.user.id = user._id.toString();
    req.user.userId = user._id.toString();

    next(); // continue to next middleware/route
  } catch (err) {
    console.error("Invalid token:", err.message);
    res.status(401).json({ message: "Token is not valid" });
  }
}

module.exports = authMiddleware;