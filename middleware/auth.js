const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function authMiddleware(req, res, next) {
  // Get token from header
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "Votre compte a été désactivé. Contactez un administrateur." });
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
    console.warn("Authentication rejected:", err.name);
    res.status(401).json({ message: "Authentication required" });
  }
}

module.exports = authMiddleware;
