require("dotenv").config();

// Production keeps errors and warnings in the server logs but drops debug
// chatter (console.log / console.debug), so no internal detail is printed by
// accident. Set DEBUG_LOGS=true temporarily to see it again.
if (process.env.NODE_ENV === "production" && process.env.DEBUG_LOGS !== "true") {
  console.log = () => {};
  console.debug = () => {};
}
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { preventNoSqlInjection } = require("./middleware/security");
const auditTrail = require("./middleware/auditTrail");
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
// Production: one short line per request, without user agents or referrers.
app.use(morgan(isProduction ? ":remote-addr :method :url :status :response-time ms" : "dev"));

// Cap on API traffic per IP address so the server cannot be flooded or
// scraped. Generous enough for a whole shop behind one internet connection.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});
app.use("/api", apiLimiter);
// API answers carry live business data: never let a browser or proxy cache them.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
// Security journal: observes every API request once its response is sent.
app.use("/api", auditTrail);
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

function getMongoUri() {
  const uri = process.env.MONGO_URI;
  const parsed = new URL(uri);

  // This network's DNS proxy returns EBADRESP for Atlas SRV queries. Use the
  // equivalent seed list for this cluster so Node does ordinary A/AAAA lookups.
  if (parsed.protocol !== "mongodb+srv:" || parsed.hostname !== "cluster0.dckjabm.mongodb.net") {
    return uri;
  }

  const hosts = [
    "ac-rchorki-shard-00-00.dckjabm.mongodb.net:27017",
    "ac-rchorki-shard-00-01.dckjabm.mongodb.net:27017",
    "ac-rchorki-shard-00-02.dckjabm.mongodb.net:27017",
  ].join(",");
  const params = new URLSearchParams(parsed.searchParams);
  params.set("tls", "true");
  params.set("authSource", "admin");
  params.set("replicaSet", "atlas-9ou3vz-shard-0");

  return `mongodb://${parsed.username}:${parsed.password}@${hosts}${parsed.pathname}?${params}`;
}

const MONGO_URI = getMongoUri();

// ====== Use Routes ======
app.use("/api/products", require("./routes/products"));
app.use("/api/sales", require("./routes/sales"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/categories", require("./routes/categories"));
app.use('/api/print', printRoutes);
app.use("/api/expenses", require("./routes/expenses")); // ✅ Added expense routes
app.use("/api/exchange-rates", require("./routes/exchangeRates"));
app.use("/api/entries", require("./routes/entries"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/creditors", require("./routes/creditors"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/audit", require("./routes/audit"));
// Health check (says nothing about the software behind it).
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK");
});

// Unknown API paths get a plain JSON 404 instead of Express's HTML page.
app.use("/api", (_req, res) => {
  res.status(404).json({ message: "Not found" });
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
    console.info("Connected to MongoDB");
    app.listen(PORT, () => {
      console.info(`Server listening on port ${PORT}`);
    });
    // Start the stock ledger for products it does not cover yet (first run
    // after deployment, or products inserted directly into the database).
    // Idempotent, never changes a stock value, and does not delay startup.
    const { ensureStockBaselines } = require("./utils/stockLedger");
    const { runTransaction } = require("./utils/transaction");
    ensureStockBaselines({ runTransaction })
      .then(({ created, failed }) => {
        if (created || failed) console.log(`📦 Stock ledger baselines: ${created} recorded, ${failed} failed`);
      })
      .catch((error) => console.error("Stock ledger baseline error:", error.message));
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.name || "Error");
    process.exit(1);
  });
