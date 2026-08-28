const mongoose = require("mongoose");

function hasMongoOperator(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasMongoOperator);
  return Object.entries(value).some(
    ([key, nested]) => key.startsWith("$") || key.includes(".") || hasMongoOperator(nested)
  );
}

function preventNoSqlInjection(req, res, next) {
  if (hasMongoOperator(req.body) || hasMongoOperator(req.query)) {
    return res.status(400).json({ message: "Invalid request" });
  }
  next();
}

function validateObjectIdParam(name = "id") {
  return (req, res, next, value) => {
    if (!mongoose.isObjectIdOrHexString(value)) {
      return res.status(400).json({ message: `Invalid ${name}` });
    }
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}

module.exports = { preventNoSqlInjection, requireRole, validateObjectIdParam };
