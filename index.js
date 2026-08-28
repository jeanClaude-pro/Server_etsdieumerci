require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const { preventNoSqlInjection } = require("./middleware/security");
const { validateReceiptTokenConfiguration } = require("./utils/receiptTokenCrypto");

try {
  validateReceiptTokenConfiguration();
} catch (error) {
  console.error(`Server configuration error: ${error.message}`);
  process.exit(1);
}

const app = express();
const printRoutes = require('./routes/print');

const isProduction = process.env.NODE_ENV === "production";
const requiredSecrets = ["MONGO_URI", "JWT_SECRET", "RECEIPT_TOKEN_ENCRYPTION_KEY"];
const missingSecrets = requiredSecrets.filter((name) => !process.env[name]);
if (missingSecrets.length) {
  console.error(`Server configuration error: missing ${missingSecrets.join(", ")}`);
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error("Server configuration error: JWT_SECRET must be at least 32 characters");
  process.exit(1);
}

// Middleware
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(express.json({ limit: "256kb" }));
app.use((error, _req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON request" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ message: "Request payload too large" });
  }
  next(error);
});
app.use(morgan("combined"));
app.use(preventNoSqlInjection);

// Allow all origins with explicit headers so Authorization is never stripped
const configuredOrigins = (process.env.CLIENT_URL || "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
const developmentOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
const allowedOrigins = new Set(isProduction ? configuredOrigins : [...developmentOrigins, ...configuredOrigins]);
if (isProduction && allowedOrigins.size === 0) {
  console.error("Server configuration error: CLIENT_URL is required in production");
  process.exit(1);
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept", "X-Requested-With"],
  credentials: false,
  optionsSuccessStatus: 200,
}));

app.use((req, res, next) => {
  if (!isProduction || req.secure || req.get("x-forwarded-proto") === "https") return next();
  if (req.method === "GET" || req.method === "HEAD") {
    return res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
  }
  return res.status(426).json({ message: "HTTPS required" });
});

// Env variables
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

// ====== Use Routes ======
app.use("/api/products", require("./routes/products"));
app.use("/api/sales", require("./routes/sales"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/test", require("./routes/test"));
app.use("/api/categories", require("./routes/categories"));
app.use('/api/print', printRoutes);
app.use("/api/expenses", require("./routes/expenses")); // ✅ Added expense routes
app.use("/api/exchange-rates", require("./routes/exchangeRates"));
app.use("/api/entries", require("./routes/entries"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/creditors", require("./routes/creditors"));
// Default route
app.get("/", (req, res) => {
  res.send("ERP/POS System Backend is running...");
});

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin not allowed by CORS") return res.status(403).json({ message: "Origin not allowed" });
  console.error("Unhandled server error:", error?.name || "Error");
  return res.status(500).json({ message: "Internal server error" });
});

// ====== DB + Server Startup ======
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });
