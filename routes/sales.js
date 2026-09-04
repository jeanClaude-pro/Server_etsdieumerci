// routes/sales.js
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const {
  normalizeExchangeRate,
  normalizeSaleItemPricing,
} = require("../utils/salePricing");
const {
  buildTimeframeFilter: buildBusinessTimeframeFilter,
  paginationMetadata,
  parsePagination,
} = require("../utils/queryHelpers");
const { buildStockAdjustments } = require("../utils/stockCalculations");
const {
  createReceiptToken,
  decryptReceiptToken,
  encryptReceiptToken,
  hashReceiptToken,
  normalizeReceiptToken,
} = require("../utils/receiptTokenCrypto");

const receiptScanLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many receipt requests. Please try again shortly." },
});

const receiptTokenLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many reprint requests. Please try again shortly." },
});

function receiptPayloadGuard(req, res, next) {
  const contentLength = Number(req.get("content-length") || 0);
  if (contentLength > 1024 || typeof req.body?.token !== "string" || req.body.token.length > 64) {
    return res.status(400).json({ code: "INVALID", message: "REÇU INVALIDE" });
  }
  next();
}

function requireReceiptReprintPermission(req, res, next) {
  const allowed = req.user.role === "admin" ||
    req.user.actionPermissions?.includes("reprint_receipts");
  if (!allowed) {
    return res.status(403).json({ message: "Access denied" });
  }
  next();
}

function receiptResult(sale, code, message) {
  const approval = sale.receiptVerification || {};
  const exitVerification = approval.exitVerification || {};
  return {
    code,
    message,
    receiptNumber: sale.saleNumber || sale.saleId,
    amount: sale.total,
    paymentStatus: approval.paymentStatus || "pending",
    approvedBy: approval.approvedBy?.username || null,
    approvedAt: approval.approvedAt || null,
    exitVerified: Boolean(exitVerification.verified),
    verifiedBy: exitVerification.verifiedBy?.username || null,
    verifiedAt: exitVerification.verifiedAt || null,
  };
}

function safeSaleResponse(sale, receiptToken) {
  const value = typeof sale.toObject === "function" ? sale.toObject() : { ...sale };
  if (value.receiptVerification) {
    delete value.receiptVerification.tokenHash;
    delete value.receiptVerification.tokenCiphertext;
    delete value.receiptVerification.invalidatedTokenHashes;
    delete value.receiptVerification.approvedBy;
    if (value.receiptVerification.exitVerification) {
      delete value.receiptVerification.exitVerification.verifiedBy;
    }
  }
  return receiptToken ? { ...value, receiptToken } : value;
}

function receiptMaterialSnapshot(sale) {
  return JSON.stringify({
    customer: sale.customer || null,
    isWalkIn: Boolean(sale.isWalkIn),
    items: (sale.items || []).map((item) => ({
      productId: String(item.productId || ""),
      name: item.name,
      quantity: Number(item.quantity),
      price: Number(item.price),
      enteredPrice: item.enteredPrice == null ? null : Number(item.enteredPrice),
      enteredCurrency: item.enteredCurrency || null,
      priceUSD: item.priceUSD == null ? null : Number(item.priceUSD),
      priceFC: item.priceFC == null ? null : Number(item.priceFC),
      exchangeRate: item.exchangeRate == null ? null : Number(item.exchangeRate),
      total: Number(item.total),
    })),
    subtotal: Number(sale.subtotal),
    total: Number(sale.total),
    exchangeRate: sale.exchangeRate == null ? null : Number(sale.exchangeRate),
    paymentMethod: sale.paymentMethod,
  });
}

// normalize to the Sale model enum
function normalizePaymentMethod(pm) {
  const v = String(pm || "cash").toLowerCase();
  if (v === "cash") return "cash";
  if (v === "card") return "card";
  if (
    ["mpesa", "m-pesa", "bank", "transfer", "wire", "bank transfer"].includes(v)
  ) {
    return "transfer";
  }
  return "other";
}

// Helper function to update customer data (FIXED)
async function updateCustomerData(customerData, saleTotal, session = null) {
  const { name, email } = customerData;
  const phone = String(customerData.phone || "").trim() || undefined;
  const now = new Date();
  if (!phone) {
    const customer = await Customer.create([{ name, email: email || "", firstPurchaseDate: now, lastPurchaseDate: now, totalPurchases: 1, totalSpent: Number(saleTotal) }], { session });
    return customer[0]._id;
  }
  const customer = await Customer.findOneAndUpdate(
    { phone },
    {
      $set: { name, email: email || "", lastPurchaseDate: now },
      $setOnInsert: { firstPurchaseDate: now },
      $inc: { totalPurchases: 1, totalSpent: Number(saleTotal) },
    },
    { new: true, upsert: true, runValidators: true, session }
  );
  return customer._id;
}

// Helper function to attach a sale to a customer record without touching
// stats (recalculateCustomerStats recomputes totals afterwards). Used when a
// sale that had no customer on file (e.g. a walk-in) is later linked to one.
async function findOrCreateCustomerId(customerData, session = null) {
  const { name, email } = customerData;
  const phone = String(customerData.phone || "").trim() || undefined;
  if (!phone) {
    const customer = new Customer({ name, email: email || "", totalPurchases: 0, totalSpent: 0 });
    await customer.save({ session });
    return customer._id;
  }
  let customer = await Customer.findOne({ phone }).session(session);
  if (!customer) {
    customer = new Customer({
      name,
      phone,
      email: email || "",
      totalPurchases: 0,
      totalSpent: 0,
    });
    await customer.save({ session });
  } else {
    customer.name = name;
    customer.email = email || "";
    await customer.save({ session });
  }
  return customer._id;
}

// Helper function to recalculate customer statistics (FIXED)
async function recalculateCustomerStats(customerId, session = null) {
  try {
    // FIX: Only include completed sales (exclude voided and corrected)
    const sales = await Sale.find({
      customerId,
      type: { $in: ["sale", "reservation"] },
      status: { $in: ["completed", "pending", null] }
    })
    .sort({ createdAt: 1 })
    .select('total status type createdAt') // Only select needed fields
    .session(session)
    .lean();
    
    // Additional safety filter
    const validSales = sales.filter(sale => 
      sale.status !== "voided" && sale.status !== "corrected" && sale.type !== "expense"
    );
    
    if (validSales.length === 0) {
      await Customer.findByIdAndUpdate(customerId, {
        totalPurchases: 0,
        totalSpent: 0,
        firstPurchaseDate: null,
        lastPurchaseDate: null,
      }, { session });
      return;
    }
    
    const totalPurchases = validSales.length;
    const totalSpent = validSales.reduce((sum, sale) => sum + sale.total, 0);
    const firstPurchaseDate = validSales[0].createdAt;
    const lastPurchaseDate = validSales[validSales.length - 1].createdAt;

    await Customer.findByIdAndUpdate(customerId, {
      totalPurchases,
      totalSpent,
      firstPurchaseDate,
      lastPurchaseDate,
    }, { session });
  } catch (error) {
    console.error("Error recalculating customer stats:", error);
    throw error;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isTransactionUnsupported(error) {
  return error?.code === 20 ||
    /transaction numbers are only allowed|replica set member or mongos/i.test(error?.message || "");
}

async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function sendMutationError(res, error, fallbackMessage) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (isTransactionUnsupported(error)) {
    return res.status(503).json({
      error: "Les opérations de vente exigent MongoDB en replica set pour garantir l'intégrité du stock.",
    });
  }
  if (error.name === "ValidationError") {
    const errors = Object.values(error.errors).map((entry) => entry.message);
    return res.status(400).json({ error: errors.join(", ") });
  }
  return res.status(500).json({ error: fallbackMessage });
}

// ==================== TIME FRAME HELPER FUNCTIONS ====================

/**
 * Parse date string and set appropriate time boundaries
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {boolean} isEndDate - If true, sets to end of day (23:59:59.999)
 * @returns {Date} Parsed date object
 */
function parseDate(dateStr, isEndDate = false) {
  if (!dateStr) return null;
  
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD format.`);
  }
  
  if (isEndDate) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  
  return date;
}

/**
 * Build date range filter based on timeframe parameters
 * Follows priority: custom range > specific day > month > year > today
 * @param {Object} query - Request query parameters
 * @returns {Object} MongoDB date filter { createdAt: { $gte, $lte } }
 */
function buildTimeframeFilter(query) {
  return buildBusinessTimeframeFilter(query);
  /* legacy implementation retained below for reference during rollout */
  const { from, to, date, year, month } = query;
  
  // Priority 1: Custom date range (from and to)
  if (from || to) {
    const startDate = from ? parseDate(from, false) : new Date(0); // Beginning of time
    const endDate = to ? parseDate(to, true) : new Date(); // Current date/time
    
    if (from && to && startDate > endDate) {
      throw new Error("Start date (from) must be before or equal to end date (to)");
    }
    
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  // Priority 2: Specific day
  if (date) {
    const dayDate = parseDate(date, false);
    const startDate = new Date(dayDate);
    const endDate = new Date(dayDate);
    endDate.setHours(23, 59, 59, 999);
    
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  // Priority 3: Specific month
  if (year && month) {
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10) - 1; // JS months are 0-indexed
    
    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      throw new Error(`Invalid year: ${year}. Must be between 2000-2100.`);
    }
    
    if (isNaN(monthNum) || monthNum < 0 || monthNum > 11) {
      throw new Error(`Invalid month: ${month}. Must be between 01-12.`);
    }
    
    const startDate = new Date(yearNum, monthNum, 1);
    const endDate = new Date(yearNum, monthNum + 1, 0); // Last day of month
    endDate.setHours(23, 59, 59, 999);
    
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  // Priority 4: Full year
  if (year) {
    const yearNum = parseInt(year, 10);
    
    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      throw new Error(`Invalid year: ${year}. Must be between 2000-2100.`);
    }
    
    const startDate = new Date(yearNum, 0, 1); // Jan 1
    const endDate = new Date(yearNum, 11, 31); // Dec 31
    endDate.setHours(23, 59, 59, 999);
    
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  // Priority 5: Default to today
  const today = new Date();
  const startDate = new Date(today);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setHours(23, 59, 59, 999);
  
  return {
    createdAt: {
      $gte: startDate,
      $lte: endDate
    }
  };
}

/**
 * Get human-readable timeframe description
 */
function getTimeframeDescription(query) {
  const { from, to, date, year, month } = query;
  
  if (from || to) {
    return `Custom range: ${from || 'Beginning'} to ${to || 'Now'}`;
  }
  if (date) {
    return `Day: ${date}`;
  }
  if (year && month) {
    return `Month: ${year}-${String(month).padStart(2, '0')}`;
  }
  if (year) {
    return `Year: ${year}`;
  }
  return 'Today (default)';
}

// ==================== MAIN SALES ENDPOINT (TIME FRAME PAGINATION) ====================

/** 
 * GET /api/sales
 * Timeframe-based pagination (no numeric pagination)
 * Priority: custom range > specific day > month > year > today (default)
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { 
      customerPhone, 
      status,
      type,
      paymentMethod,
      search,
      controlStatus
    } = req.query;
    
    // Build the main filter object
    const filter = {};
    
    // 1. Apply timeframe filter (priority order handled in buildTimeframeFilter)
    try {
      const timeframeFilter = buildTimeframeFilter(req.query);
      Object.assign(filter, timeframeFilter);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD for dates, YYYY for year, MM for month (01-12)"
      });
    }
    
    // 2. Apply customer phone filter if provided
    if (customerPhone) {
      filter["customer.phone"] = customerPhone;
    }

    if (paymentMethod) {
      const normalizedPayment = normalizePaymentMethod(paymentMethod);
      filter.paymentMethod = normalizedPayment;
    }

    if (search) {
      const escapedSearch = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = { $regex: escapedSearch, $options: "i" };
      filter.$or = [
        { saleId: searchRegex },
        { saleNumber: searchRegex },
        { "customer.name": searchRegex },
        { "customer.phone": searchRegex },
        { salesPerson: searchRegex },
        { "items.name": searchRegex },
      ];
    }
    
    // 3. Apply status filter if provided, otherwise use default
    if (status) {
      filter.status = status;
    } else {
      // History includes invalidated sales so their control state is never misleading.
      filter.status = { $in: ["completed", "pending", "voided", "corrected", "refunded", "expense"] };
    }
    
    // 4. Apply type filter if provided, otherwise use default
    if (type) {
      filter.type = type;
    } else {
      // Default: include all types
      filter.type = { $in: ["sale", "reservation", "expense"] };
    }

    const controlFilters = {
      payment_pending: { "receiptVerification.paymentStatus": "pending" },
      payment_approved: { "receiptVerification.paymentStatus": "approved" },
      exit_unverified: {
        "receiptVerification.paymentStatus": "approved",
        "receiptVerification.exitVerification.verified": { $ne: true },
      },
      exit_verified: { "receiptVerification.exitVerification.verified": true },
    };
    if (controlStatus) {
      if (!controlFilters[controlStatus]) {
        return res.status(400).json({ error: "Invalid receipt control filter" });
      }
      Object.assign(filter, controlFilters[controlStatus]);
    }
    
    const { page, limit, skip } = parsePagination(req.query);
    const facetResult = await Sale.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: "users",
          localField: "receiptVerification.approvedBy",
          foreignField: "_id",
          as: "receiptApprovedByUser",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "receiptVerification.exitVerification.verifiedBy",
          foreignField: "_id",
          as: "receiptVerifiedByUser",
        },
      },
      {
        $set: {
          "receiptVerification.approvedBy": {
            $let: {
              vars: { user: { $arrayElemAt: ["$receiptApprovedByUser", 0] } },
              in: { $cond: ["$$user", { username: "$$user.username" }, null] },
            },
          },
          "receiptVerification.exitVerification.verifiedBy": {
            $let: {
              vars: { user: { $arrayElemAt: ["$receiptVerifiedByUser", 0] } },
              in: { $cond: ["$$user", { username: "$$user.username" }, null] },
            },
          },
        },
      },
      {
        $facet: {
          data: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                __v: 0,
                "receiptVerification.tokenHash": 0,
                "receiptVerification.tokenCiphertext": 0,
                "receiptVerification.invalidatedTokenHashes": 0,
                receiptApprovedByUser: 0,
                receiptVerifiedByUser: 0,
              },
            },
          ],
          metadata: [{ $count: "totalRecords" }],
          summary: [{
            $group: {
              _id: null,
              totalRevenue: {
                $sum: { $cond: [{ $ne: ["$type", "expense"] }, "$total", 0] },
              },
              totalExpenses: {
                $sum: { $cond: [{ $eq: ["$type", "expense"] }, "$total", 0] },
              },
              saleCount: {
                $sum: { $cond: [{ $ne: ["$type", "expense"] }, 1, 0] },
              },
              expenseCount: {
                $sum: { $cond: [{ $eq: ["$type", "expense"] }, 1, 0] },
              },
              completedCount: {
                $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
              },
              pendingCount: {
                $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
              },
            },
          }],
        },
      },
    ]);
    const facet = facetResult[0] || { data: [], metadata: [], summary: [] };
    const sales = facet.data || [];
    const total = facet.metadata?.[0]?.totalRecords || 0;
    
    // Generate timeframe metadata
    const timeframeDescription = getTimeframeDescription(req.query);
    const timeframeFilter = buildTimeframeFilter(req.query);
    
    const totals = facet.summary?.[0] || {
      totalRevenue: 0,
      totalExpenses: 0,
      saleCount: 0,
      expenseCount: 0,
      completedCount: 0,
      pendingCount: 0,
    };
    
    // Prepare response with timeframe metadata
    const response = {
      success: true,
      data: sales,
      pagination: paginationMetadata(page, limit, total),
      timeframe: {
        description: timeframeDescription,
        start: timeframeFilter.createdAt.$gte.toISOString(),
        end: timeframeFilter.createdAt.$lte.toISOString(),
        query: {
          from: req.query.from || null,
          to: req.query.to || null,
          date: req.query.date || null,
          year: req.query.year || null,
          month: req.query.month || null
        }
      },
      summary: {
        totalRecords: total,
        revenue: totals.totalRevenue,
        expenses: totals.totalExpenses,
        net: totals.totalRevenue - totals.totalExpenses,
        salesCount: totals.saleCount,
        expensesCount: totals.expenseCount,
        completedCount: totals.completedCount,
        pendingCount: totals.pendingCount,
      },
      filtersApplied: {
        customerPhone: customerPhone || 'none',
        paymentMethod: paymentMethod || 'none',
        search: search || 'none',
        status: status || 'default history statuses',
        type: type || 'default (sale, reservation, expense)',
        controlStatus: controlStatus || 'all'
      },
      // Performance warning for large datasets
      performanceNote: total > 1000 
        ? `Large dataset (${total} records). Consider using a more specific timeframe.`
        : null
    };
    
    res.json(response);
    
  } catch (error) {
    console.error("Error fetching sales with timeframe pagination:", error);
    
    // Handle specific error types
    if (error.message.includes("Invalid date format") || 
        error.message.includes("Invalid year") || 
        error.message.includes("Invalid month")) {
      return res.status(400).json({ 
        error: error.message,
        validFormats: {
          date: "YYYY-MM-DD (e.g., 2024-12-25)",
          month: "year=YYYY&month=MM (e.g., year=2024&month=12)",
          year: "year=YYYY (e.g., year=2024)",
          customRange: "from=YYYY-MM-DD&to=YYYY-MM-DD"
        }
      });
    }
    
    res.status(500).json({ 
      error: "Failed to fetch sales",
      suggestion: "Check your query parameters and try again"
    });
  }
});

// ==================== ALL OTHER ROUTES REMAIN UNCHANGED ====================

/** ---------- DAILY STATS FIRST (before :id) ---------- **/
router.get("/stats/daily", authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const dailySales = await Sale.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfDay, $lte: endOfDay },
          // ✅ FIXED: INCLUDE PENDING RESERVATIONS (money already received)
          status: { $in: ["completed", "pending"] },
          // ✅ FIXED: INCLUDE BOTH SALES AND RESERVATIONS
          type: { $in: ["sale", "reservation"] }
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: "$total" },
          totalItems: { $sum: { $size: "$items" } },
        },
      },
    ]);

    // Use timeframe-based query (no limit) for consistency
    const sales = await Sale.find({
      createdAt: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["completed", "pending"] },
      type: { $in: ["sale", "reservation"] }
    })
    .sort({ createdAt: -1 })
    .select('-__v')
    .lean();

    res.json({
      date: targetDate.toISOString().split("T")[0],
      totalSales: dailySales[0]?.totalSales || 0,
      totalRevenue: dailySales[0]?.totalRevenue || 0,
      totalItems: dailySales[0]?.totalItems || 0,
      sales,
    });
  } catch (error) {
    console.error("Error fetching daily stats:", error);
    res.status(500).json({ error: "Failed to fetch daily statistics" });
  }
});

/** ---------- CREATE SALE OR EXPENSE ---------- **/
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      customer,
      items,
      paymentMethod,
      salesPerson,
      type,
      reservationDate,
      reservationTime,
      notes,
      isWalkIn,
      exchangeRate,
      // 🔹 NEW EXPENSE FIELDS
      reason,
      recipientName,
      recipientPhone,
      amount,
      recordedBy
    } = req.body;

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // 🔹 HANDLE EXPENSE TYPE
    if (type === "expense") {
      if (!reason || !recipientName || !recipientPhone || !amount) {
        return res.status(400).json({ 
          error: "Expense requires reason, recipientName, recipientPhone, and amount" 
        });
      }

      const expenseAmount = parseFloat(amount);
      if (isNaN(expenseAmount) || expenseAmount <= 0) {
        return res.status(400).json({ 
          error: "Amount must be a positive number" 
        });
      }

      const saleId = `EXP-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 5)
        .toUpperCase()}`;

      const saleNumber = `EXP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const expenseData = {
        saleId,
        saleNumber,
        customer: {
          name: recipientName,
          phone: recipientPhone,
          email: "",
        },
        items: [], // No items for expenses
        subtotal: expenseAmount,
        total: expenseAmount,
        paymentMethod: normalizedPM,
        status: "expense", // 🔹 Special status for expenses
        salesPerson: recordedBy || salesPerson || "Admin",
        type: "expense",
        reason: reason,
        recipientName: recipientName,
        recipientPhone: recipientPhone,
        notes: notes || ""
      };

      const expense = new Sale(expenseData);
      const savedExpense = await expense.save();

      return res.status(201).json(savedExpense);
    }

    // 🔹 HANDLE REGULAR SALE (existing logic)
    const walkIn = Boolean(isWalkIn);
    let transactionExchangeRate;
    try {
      transactionExchangeRate = normalizeExchangeRate(exchangeRate);
    } catch (pricingError) {
      return res.status(400).json({ error: pricingError.message });
    }

    if (walkIn && type === "reservation") {
      return res.status(400).json({
        error: "Une réservation nécessite les coordonnées du client",
      });
    }

    if (!walkIn && (!customer || !customer.name)) {
      return res
        .status(400)
        .json({ error: "Customer name is required" });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "Sale must contain at least one item" });
    }

    let subtotal = 0;
    const enrichedItems = [];
    for (const item of items) {
      const { productId, quantity, price, name } = item || {};
      if (!productId || !quantity || quantity <= 0 || !price || price < 0) {
        return res.status(400).json({
          error: "Each item requires productId, quantity>0, and price>=0",
        });
      }

      const product = await Product.findById(productId).lean();
      if (!product)
        return res
          .status(400)
          .json({ error: `Product not found: ${productId}` });

      if (typeof product.stock !== "number" || product.stock < quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${
            product.name || name || productId
          }. Available: ${product.stock ?? 0}`,
        });
      }

      let pricing;
      try {
        pricing = normalizeSaleItemPricing(item, transactionExchangeRate);
      } catch (pricingError) {
        return res.status(400).json({ error: pricingError.message });
      }

      const lineTotal = pricing.price * Number(quantity);
      subtotal += lineTotal;

      enrichedItems.push({
        productId: new mongoose.Types.ObjectId(productId),
        name: name || product.name,
        quantity: Number(quantity),
        ...pricing,
        total: lineTotal,
      });
    }

    const total = subtotal;
    const saleId = `SALE-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    const saleNumber = `SN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const customerData = walkIn
      ? { name: "Client de passage", phone: "", email: "" }
      : {
          name: customer.name,
          phone: String(customer.phone || "").trim(),
          email: customer.email || "",
        };

    const effectiveSaleType = type || "sale";
    const receiptToken = effectiveSaleType === "sale" ? createReceiptToken() : null;

    // UPDATED: Include type and reservation fields WITH CORRECT STATUS
    const saleData = {
      saleId,
      saleNumber,
      customer: customerData,
      customerId: null,
      isWalkIn: walkIn,
      items: enrichedItems,
      subtotal,
      total,
      exchangeRate: transactionExchangeRate,
      paymentMethod: normalizedPM,
      status: type === "reservation" ? "pending" : "completed", // ✅ FIXED: Reservations as pending (money received)
      salesPerson: salesPerson || "Admin",
      type: effectiveSaleType,
      reservationDate: reservationDate || null,
      reservationTime: reservationTime || null,
      notes: notes || "",
      ...(receiptToken
        ? {
            receiptVerification: {
              tokenHash: hashReceiptToken(receiptToken),
              tokenCiphertext: encryptReceiptToken(receiptToken),
              version: 1,
              paymentStatus: "pending",
              exitVerification: { verified: false },
            },
          }
        : {})
    };

    const savedSale = await runTransaction(async (session) => {
      // Walk-in sales never create or update a Customer record.
      saleData.customerId = walkIn
        ? null
        : await updateCustomerData(customer, total, session);

      for (const item of enrichedItems) {
        const updated = await Product.findOneAndUpdate(
          { _id: item.productId, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } },
          { new: true, session }
        );
        if (!updated) {
          throw new HttpError(
            409,
            `Stock insuffisant pour ${item.name}. Actualisez les produits puis réessayez.`
          );
        }
      }

      const createdSales = await Sale.create([saleData], { session });
      return createdSales[0];
    });

    return res.status(201).json(safeSaleResponse(savedSale, receiptToken));
  } catch (error) {
    console.error("Error creating sale/expense:", error);
    return sendMutationError(res, error, "Failed to create sale/expense");
  }
});

// ==================== MODIFIED ENDPOINTS (REMOVE PAGINATION) ====================

/** ---------- GET EXPENSES (TIME FRAME BASED) ---------- **/
router.get("/expenses/all", authMiddleware, async (req, res) => {
  try {
    const { 
      status 
    } = req.query;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildBusinessTimeframeFilter(
        req.query,
        "createdAt",
        false
      );
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }
    
    const filter = { 
      type: "expense",
      ...timeframeFilter
    };
    
    if (status) {
      filter.status = status;
    }

    const { page, limit, skip } = parsePagination(req.query);
    const [expenses, total, summaryResult] = await Promise.all([
      Sale.find(filter)
      .select('-__v -items') // Expenses don't have items
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Sale.countDocuments(filter),
      Sale.aggregate([
        { $match: filter },
        { $group: { _id: null, totalAmount: { $sum: "$total" } } },
      ]),
    ]);
    const totalAmount = summaryResult[0]?.totalAmount || 0;

    res.json({
      success: true,
      data: expenses,
      pagination: paginationMetadata(page, limit, total),
      summary: {
        totalExpenses: total,
        totalAmount: totalAmount,
        timeframe: Object.keys(timeframeFilter).length
          ? getTimeframeDescription(req.query)
          : "All history"
      }
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

/** ---------- GET RESERVATIONS (TIME FRAME BASED) ---------- **/
router.get("/reservations/all", authMiddleware, async (req, res) => {
  try {
    const { 
      status,
      paymentMethod,
      search,
    } = req.query;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildBusinessTimeframeFilter(
        req.query,
        "createdAt",
        false
      );
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }
    
    const filter = { 
      type: "reservation",
      ...timeframeFilter
    };
    
    if (status) {
      if (!["pending", "completed"].includes(status)) {
        return res.status(400).json({ error: "Invalid reservation status" });
      }
      filter.status = status;
    } else {
      filter.status = { $in: ["pending", "completed"] };
    }
    if (paymentMethod) filter.paymentMethod = normalizePaymentMethod(paymentMethod);
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = { $regex: escaped, $options: "i" };
      filter.$or = [
        { saleId: regex },
        { "customer.name": regex },
        { "customer.phone": regex },
        { "items.name": regex },
      ];
    }

    const { page, limit, skip } = parsePagination(req.query);
    const result = await Sale.aggregate([
      { $match: filter },
      {
        $facet: {
          data: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                __v: 0,
                "receiptVerification.tokenHash": 0,
                "receiptVerification.tokenCiphertext": 0,
                "receiptVerification.invalidatedTokenHashes": 0,
                "receiptVerification.approvedBy": 0,
              },
            },
          ],
          metadata: [{ $count: "totalRecords" }],
          summary: [{
            $group: {
              _id: null,
              totalReservations: { $sum: 1 },
              pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
              completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
              revenue: { $sum: "$total" },
              itemQuantity: {
                $sum: {
                  $reduce: {
                    input: "$items",
                    initialValue: 0,
                    in: { $add: ["$$value", { $ifNull: ["$$this.quantity", 0] }] },
                  },
                },
              },
            },
          }],
        },
      },
    ]);
    const facet = result[0] || { data: [], metadata: [], summary: [] };
    const reservations = facet.data || [];
    const total = facet.metadata?.[0]?.totalRecords || 0;
    const summary = facet.summary?.[0] || {
      totalReservations: 0,
      pending: 0,
      completed: 0,
      revenue: 0,
      itemQuantity: 0,
    };

    res.json({
      success: true,
      data: reservations,
      pagination: paginationMetadata(page, limit, total),
      summary: {
        totalReservations: summary.totalReservations,
        pending: summary.pending,
        completed: summary.completed,
        revenue: summary.revenue,
        itemQuantity: summary.itemQuantity,
        timeframe: Object.keys(timeframeFilter).length
          ? getTimeframeDescription(req.query)
          : "All history"
      }
    });
  } catch (error) {
    console.error("Error fetching reservations:", error);
    res.status(500).json({ error: "Failed to fetch reservations" });
  }
});

// ==================== ALL OTHER ROUTES REMAIN EXACTLY THE SAME ====================

/** ---------- RECEIPT PAYMENT APPROVAL (cashier supervisor/admin only) ---------- **/
router.post(
  "/receipt/approve",
  authMiddleware,
  receiptScanLimiter,
  receiptPayloadGuard,
  async (req, res) => {
    try {
      const token = normalizeReceiptToken(req.body?.token);
      if (!token) {
        return res.status(400).json({ code: "INVALID", message: "REÇU INVALIDE" });
      }

      const tokenHash = hashReceiptToken(token);
      const approvedAt = new Date();
      const approved = await Sale.findOneAndUpdate(
        {
          type: "sale",
          status: { $nin: ["voided", "corrected"] },
          "receiptVerification.tokenHash": tokenHash,
          "receiptVerification.version": { $gte: 1 },
          "receiptVerification.paymentStatus": "pending",
          "receiptVerification.invalidatedAt": null,
        },
        {
          $set: {
            "receiptVerification.paymentStatus": "approved",
            "receiptVerification.approvedBy": req.user._id,
            "receiptVerification.approvedAt": approvedAt,
          },
        },
        { new: true }
      )
        .select("+receiptVerification.approvedBy")
        .populate("receiptVerification.approvedBy", "username");

      if (approved) {
        return res.json(receiptResult(approved, "APPROVED", "PAIEMENT APPROUVÉ"));
      }

      const existing = await Sale.findOne({
        $or: [
          { "receiptVerification.tokenHash": tokenHash },
          { "receiptVerification.invalidatedTokenHashes": tokenHash },
        ],
      })
        .select("+receiptVerification.invalidatedTokenHashes +receiptVerification.approvedBy")
        .populate("receiptVerification.approvedBy", "username");

      if (!existing) {
        return res.status(404).json({ code: "NOT_FOUND", message: "REÇU INTROUVABLE" });
      }
      if (existing.receiptVerification?.invalidatedTokenHashes?.includes(tokenHash)) {
        return res.status(410).json({ code: "OBSOLETE", message: "REÇU OBSOLÈTE / INVALIDE" });
      }
      if (["voided", "corrected"].includes(existing.status) || existing.receiptVerification?.invalidatedAt) {
        return res.status(410).json({ code: "CANCELLED", message: "REÇU ANNULÉ" });
      }
      if (existing.receiptVerification?.paymentStatus === "approved") {
        return res.json(receiptResult(existing, "ALREADY_APPROVED", "DÉJÀ PAYÉ / DÉJÀ VALIDÉ"));
      }
      return res.status(409).json({ code: "INVALID", message: "REÇU INVALIDE" });
    } catch (error) {
      console.error("Receipt approval error:", error);
      return res.status(500).json({ code: "ERROR", message: "Échec de la validation du paiement" });
    }
  }
);

/** ---------- RECEIPT EXIT VERIFICATION (never changes paymentStatus) ---------- **/
router.post(
  "/receipt/verify",
  authMiddleware,
  receiptScanLimiter,
  receiptPayloadGuard,
  async (req, res) => {
    try {
      const token = normalizeReceiptToken(req.body?.token);
      if (!token) {
        return res.status(400).json({ code: "INVALID", message: "REÇU INVALIDE" });
      }

      const tokenHash = hashReceiptToken(token);
      const verifiedAt = new Date();
      const verified = await Sale.findOneAndUpdate({
        type: "sale",
        status: { $nin: ["voided", "corrected"] },
        "receiptVerification.tokenHash": tokenHash,
        "receiptVerification.version": { $gte: 1 },
        "receiptVerification.paymentStatus": "approved",
        "receiptVerification.invalidatedAt": null,
        "receiptVerification.exitVerification.verified": { $ne: true },
      }, {
        $set: {
          "receiptVerification.exitVerification.verified": true,
          "receiptVerification.exitVerification.verifiedBy": req.user._id,
          "receiptVerification.exitVerification.verifiedAt": verifiedAt,
        },
      }, { new: true })
        .select("+receiptVerification.approvedBy +receiptVerification.exitVerification.verifiedBy")
        .populate("receiptVerification.approvedBy", "username")
        .populate("receiptVerification.exitVerification.verifiedBy", "username");

      if (verified) {
        return res.json(receiptResult(verified, "APPROVED", "PAIEMENT APPROUVÉ — SORTIE AUTORISÉE"));
      }

      const sale = await Sale.findOne({
        $or: [
          { "receiptVerification.tokenHash": tokenHash },
          { "receiptVerification.invalidatedTokenHashes": tokenHash },
        ],
      })
        .select("+receiptVerification.invalidatedTokenHashes +receiptVerification.approvedBy +receiptVerification.exitVerification.verifiedBy")
        .populate("receiptVerification.approvedBy", "username")
        .populate("receiptVerification.exitVerification.verifiedBy", "username");

      if (!sale) {
        return res.status(404).json({ code: "NOT_FOUND", message: "REÇU INTROUVABLE" });
      }
      if (sale.receiptVerification?.invalidatedTokenHashes?.includes(tokenHash)) {
        return res.status(410).json({ code: "OBSOLETE", message: "REÇU OBSOLÈTE / INVALIDE" });
      }
      if (["voided", "corrected"].includes(sale.status) || sale.receiptVerification?.invalidatedAt) {
        return res.status(410).json({ code: "CANCELLED", message: "REÇU ANNULÉ" });
      }
      if (sale.receiptVerification?.paymentStatus === "approved") {
        return res.json(receiptResult(sale, "ALREADY_VERIFIED", "DÉJÀ CONTRÔLÉ À LA SORTIE"));
      }
      return res.json(receiptResult(
        sale,
        "PENDING",
        "PAIEMENT NON ENCORE APPROUVÉ — SORTIE NON AUTORISÉE"
      ));
    } catch (error) {
      console.error("Receipt verification error:", error);
      return res.status(500).json({ code: "ERROR", message: "Échec du contrôle du paiement" });
    }
  }
);

/** ---------- RAW TOKEN FOR AUTHENTICATED RECEIPT PRINT/REPRINT ---------- **/
router.get(
  "/:id/receipt-token",
  authMiddleware,
  receiptTokenLimiter,
  requireReceiptReprintPermission,
  async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id)
      .select(
        "type status receiptVerification.version receiptVerification.paymentStatus " +
        "receiptVerification.invalidatedAt +receiptVerification.tokenCiphertext"
      )
      .lean();
    if (!sale || sale.type !== "sale") {
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (["voided", "corrected"].includes(sale.status) || sale.receiptVerification?.invalidatedAt) {
      return res.status(410).json({ message: "Receipt is no longer valid" });
    }
    if (!sale.receiptVerification?.tokenCiphertext) {
      return res.status(404).json({ message: "This legacy receipt has no QR token" });
    }
    return res.json({ receiptToken: decryptReceiptToken(sale.receiptVerification.tokenCiphertext) });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid sale ID" });
    }
    console.error("Receipt token retrieval error:", error);
    return res.status(500).json({ message: "Failed to retrieve receipt token" });
  }
  }
);

/** ---------- GET BY ID (after other specific routes) ---------- **/
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const saleId = req.params.id;
    
    const sale = await Sale.findById(saleId)
      .select('-__v') // Exclude version key
      .lean();
    
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // Only check for duplicates if needed
    let potentialDuplicates = [];
    let duplicateCount = 0;
    
    if (sale.saleId) {
      potentialDuplicates = await Sale.find({
        saleId: sale.saleId,
        _id: { $ne: saleId }
      })
      .select('_id saleId createdAt status')
      .lean();
      
      duplicateCount = potentialDuplicates.length;
    }

    res.json({
      success: true,
      data: sale,
      duplicates: {
        count: duplicateCount,
        items: potentialDuplicates
      },
      message: duplicateCount > 0 ? 
        `Found ${duplicateCount} potential duplicates` : 
        "No duplicates found"
    });

  } catch (error) {
    console.error("Error fetching sale:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID format" });
    }
    res.status(500).json({ error: "Failed to fetch sale" });
  }
});

/** ---------- EDIT SALE (Role-Based Restrictions) ---------- **/
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      customer,
      items,
      paymentMethod,
      reason,
      type,
      reservationDate,
      reservationTime,
      notes,
      isWalkIn,
      exchangeRate,
      // Expense fields
      recipientName,
      recipientPhone,
      amount
    } = req.body;

    // Find the original sale
    const originalSale = await Sale.findById(id).lean();
    if (!originalSale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // 🔹 NEW: RESTRICTION FOR RESERVATIONS
    if (originalSale.type === "reservation") {
      const userRole = req.user.role;
      
      // If reservation is completed, only admin can edit
      if (originalSale.status === "completed" && userRole !== "admin") {
        return res.status(403).json({ 
          error: "Only admin can edit completed reservations" 
        });
      }
      
      // If reservation is pending, only admin and manager can edit
      if (originalSale.status === "pending" && 
          userRole !== "admin" && userRole !== "manager") {
        return res.status(403).json({ 
          error: "Only admin and manager can edit pending reservations" 
        });
      }
    }

    // Prevent editing voided or corrected sales
    if (originalSale.status === "voided" || originalSale.status === "corrected") {
      return res.status(400).json({ 
        error: "Cannot edit a voided or corrected sale" 
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // 🔹 HANDLE EXPENSE EDITING
    if (originalSale.type === "expense" || type === "expense") {
      if (!reason || !recipientName || !recipientPhone || !amount) {
        return res.status(400).json({ 
          error: "Expense requires reason, recipientName, recipientPhone, and amount" 
        });
      }

      const expenseAmount = parseFloat(amount);
      if (isNaN(expenseAmount) || expenseAmount <= 0) {
        return res.status(400).json({ 
          error: "Amount must be a positive number" 
        });
      }

      // Track changes for audit
      const changes = new Map();
      
      if (originalSale.reason !== reason) {
        changes.set('reason', { from: originalSale.reason, to: reason });
      }
      if (originalSale.recipientName !== recipientName) {
        changes.set('recipientName', { from: originalSale.recipientName, to: recipientName });
      }
      if (originalSale.recipientPhone !== recipientPhone) {
        changes.set('recipientPhone', { from: originalSale.recipientPhone, to: recipientPhone });
      }
      if (originalSale.total !== expenseAmount) {
        changes.set('total', { from: originalSale.total, to: expenseAmount });
      }

      const updatedExpense = await Sale.findByIdAndUpdate(
        id,
        {
          reason,
          recipientName,
          recipientPhone,
          subtotal: expenseAmount,
          total: expenseAmount,
          paymentMethod: normalizedPM,
          notes: notes || originalSale.notes,
          editedBy: req.user.username,
          editedAt: new Date(),
          $push: {
            editHistory: {
              editedBy: req.user.username,
              editedAt: new Date(),
              changes: Object.fromEntries(changes),
              reason: reason || "Expense correction"
            }
          }
        },
        { new: true, runValidators: true }
      );

      return res.json(updatedExpense);
    }

    // 🔹 HANDLE REGULAR SALE EDITING
    // Track changes for audit
    const changes = new Map();

    // Walk-in status: use the value sent by the client, falling back to the
    // sale's existing flag when the client doesn't include it in the payload.
    const walkIn = typeof isWalkIn === "boolean" ? isWalkIn : Boolean(originalSale.isWalkIn);
    const effectiveType = type || originalSale.type;
    let transactionExchangeRate;
    try {
      transactionExchangeRate = normalizeExchangeRate(
        exchangeRate ?? originalSale.exchangeRate
      );
    } catch (pricingError) {
      return res.status(400).json({ error: pricingError.message });
    }

    if (walkIn && effectiveType === "reservation") {
      return res.status(400).json({
        error: "Une réservation nécessite les coordonnées du client",
      });
    }

    if (!walkIn && (!customer || !customer.name)) {
      return res
        .status(400)
        .json({ error: "Customer name is required" });
    }

    const customerData = walkIn
      ? { name: "Client de passage", phone: "", email: "" }
      : { name: customer.name, phone: String(customer.phone || "").trim(), email: customer.email || "" };

    // Resolve which customer record (if any) this sale should be linked to:
    // - walk-in sales are never linked to a customer record
    // - a sale that already had a customer keeps that link
    // - a walk-in being converted to an identified sale gets linked here
    let newCustomerId = walkIn ? null : originalSale.customerId || null;

    // Validate and process items
    let subtotal = 0;
    const enrichedItems = [];
    
    for (const item of items) {
      const { productId, quantity, price, name } = item || {};
      if (!productId || !quantity || quantity <= 0 || !price || price < 0) {
        return res.status(400).json({
          error: "Each item requires productId, quantity>0, and price>=0",
        });
      }

      const product = await Product.findById(productId).lean();
      if (!product) {
        return res.status(400).json({ error: `Product not found: ${productId}` });
      }

      let pricing;
      try {
        pricing = normalizeSaleItemPricing(item, transactionExchangeRate);
      } catch (pricingError) {
        return res.status(400).json({ error: pricingError.message });
      }

      const lineTotal = pricing.price * Number(quantity);
      subtotal += lineTotal;

      enrichedItems.push({
        productId: new mongoose.Types.ObjectId(productId),
        name: name || product.name,
        quantity: Number(quantity),
        ...pricing,
        total: lineTotal,
      });
    }

    const total = subtotal;
    let replacementReceiptToken = null;

    // Track what changed
    if (JSON.stringify(originalSale.customer) !== JSON.stringify(customerData)) {
      changes.set('customer', { from: originalSale.customer, to: customerData });
    }

    if (originalSale.total !== total) {
      changes.set('total', { from: originalSale.total, to: total });
    }
    
    if (originalSale.paymentMethod !== normalizedPM) {
      changes.set('paymentMethod', { from: originalSale.paymentMethod, to: normalizedPM });
    }

    // Track type changes
    if (originalSale.type !== effectiveType) {
      changes.set('type', { from: originalSale.type, to: effectiveType });
    }

    const updatedSale = await runTransaction(async (session) => {
      const currentSale = await Sale.findById(id)
        .select("+receiptVerification.tokenHash +receiptVerification.invalidatedTokenHashes")
        .session(session)
        .lean();
      if (!currentSale) throw new HttpError(404, "Sale not found");
      if (["voided", "corrected"].includes(currentSale.status)) {
        throw new HttpError(409, "Cannot edit a voided or corrected sale");
      }

      const nextReceiptSnapshot = {
        customer: customerData,
        isWalkIn: walkIn,
        items: enrichedItems,
        subtotal,
        total,
        exchangeRate: transactionExchangeRate,
        paymentMethod: normalizedPM,
      };
      const receiptChanged =
        currentSale.type === "sale" &&
        receiptMaterialSnapshot(currentSale) !== receiptMaterialSnapshot(nextReceiptSnapshot);
      let receiptVerificationUpdate = {};
      if (receiptChanged) {
        replacementReceiptToken = createReceiptToken();
        const previousVerification = currentSale.receiptVerification || {};
        changes.set("receiptVerification", {
          from: {
            version: previousVerification.version || null,
            paymentStatus: previousVerification.paymentStatus || null,
            approvedBy: previousVerification.approvedBy || null,
            approvedAt: previousVerification.approvedAt || null,
          },
          to: {
            version: Number(previousVerification.version || 0) + 1,
            paymentStatus: "pending",
          },
          invalidationReason: reason || "Sale receipt changed",
        });
        const invalidatedTokenHashes = [
          ...(previousVerification.invalidatedTokenHashes || []),
          ...(previousVerification.tokenHash ? [previousVerification.tokenHash] : []),
        ];
        receiptVerificationUpdate = {
          receiptVerification: {
            tokenHash: hashReceiptToken(replacementReceiptToken),
            tokenCiphertext: encryptReceiptToken(replacementReceiptToken),
            version: Number(previousVerification.version || 0) + 1,
            paymentStatus: "pending",
            approvedBy: null,
            approvedAt: null,
            exitVerification: { verified: false, verifiedBy: null, verifiedAt: null },
            invalidatedAt: null,
            invalidationReason: null,
            invalidatedTokenHashes: [...new Set(invalidatedTokenHashes)].slice(-20),
          },
        };
      }

      const customerChanged =
        !walkIn && currentSale.customer?.phone !== customerData.phone;
      if (!walkIn && (!newCustomerId || customerChanged)) {
        newCustomerId = await findOrCreateCustomerId(customerData, session);
      }

      const stockAdjustments = buildStockAdjustments(
        currentSale.items,
        enrichedItems
      );
      for (const { productId, adjustment } of stockAdjustments) {
        const filter = { _id: productId };
        if (adjustment < 0) filter.stock = { $gte: -adjustment };
        const updatedProduct = await Product.findOneAndUpdate(
          filter,
          { $inc: { stock: adjustment } },
          { new: true, session }
        );
        if (!updatedProduct) {
          throw new HttpError(
            409,
            "Stock insuffisant pour modifier cette vente. Actualisez puis réessayez."
          );
        }
      }

      const savedSale = await Sale.findByIdAndUpdate(
        id,
        {
          customer: customerData,
          customerId: newCustomerId,
          isWalkIn: walkIn,
          items: enrichedItems,
          subtotal,
          total,
          exchangeRate: transactionExchangeRate,
          paymentMethod: normalizedPM,
          type: effectiveType,
          reservationDate: reservationDate || originalSale.reservationDate,
          reservationTime: reservationTime || originalSale.reservationTime,
          notes: notes || originalSale.notes,
          editedBy: req.user.username,
          editedAt: new Date(),
          ...receiptVerificationUpdate,
          $push: {
            editHistory: {
              editedBy: req.user.username,
              editedAt: new Date(),
              changes: Object.fromEntries(changes),
              reason: reason || "Sale correction"
            }
          }
        },
        { new: true, runValidators: true, session }
      );

      const oldCustomerId = currentSale.customerId
        ? currentSale.customerId.toString()
        : null;
      const newCustomerIdString = newCustomerId
        ? newCustomerId.toString()
        : null;
      if (oldCustomerId && oldCustomerId !== newCustomerIdString) {
        await recalculateCustomerStats(oldCustomerId, session);
      }
      if (newCustomerIdString) {
        await recalculateCustomerStats(newCustomerIdString, session);
      }
      return savedSale;
    });

    res.json(safeSaleResponse(updatedSale, replacementReceiptToken));
  } catch (error) {
    console.error("Error editing sale:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    return sendMutationError(res, error, "Failed to edit sale");
  }
});

/** ---------- MARK RESERVATION AS COMPLETED ---------- **/
router.patch("/:id/complete", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { completedBy } = req.body;

    const sale = await Sale.findById(id).lean();
    if (!sale) {
      return res.status(404).json({ error: "Réservation non trouvée" });
    }

    // 🔹 NEW: Check if it's actually a reservation
    if (sale.type !== "reservation") {
      return res.status(400).json({ error: "This is not a reservation" });
    }

    // 🔹 NEW: Check if already completed
    if (sale.status === "completed") {
      return res.status(400).json({ error: "Reservation already completed" });
    }

    const updatedSale = await Sale.findOneAndUpdate(
      { _id: id, type: "reservation", status: "pending" },
      {
        status: "completed",
        completedAt: new Date(),
        completedBy: completedBy || req.user.userId,
      },
      { new: true }
    );

    if (!updatedSale) {
      return res.status(409).json({ error: "Reservation status changed; refresh and retry" });
    }
    res.json(updatedSale);
  } catch (error) {
    console.error("Error completing reservation:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** ---------- MARK RESERVATION AS PENDING ---------- **/
router.patch("/:id/pending", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findById(id).lean();
    if (!sale) {
      return res.status(404).json({ error: "Réservation non trouvée" });
    }

    // 🔹 NEW: RESTRICTION - Only admin can return completed reservations to pending
    if (sale.status === "completed" && req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Only admin can return completed reservations to pending" 
      });
    }

    // 🔹 NEW: Check if it's actually a reservation
    if (sale.type !== "reservation") {
      return res.status(400).json({ error: "This is not a reservation" });
    }

    const updatedSale = await Sale.findOneAndUpdate(
      { _id: id, type: "reservation", status: "completed" },
      {
        status: "pending",
        completedAt: null,
        completedBy: null,
      },
      { new: true }
    );

    if (!updatedSale) {
      return res.status(409).json({ error: "Only a completed reservation can return to pending" });
    }
    res.json(updatedSale);
  } catch (error) {
    console.error("Error setting reservation to pending:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** ---------- VOID/REFUND SALE ---------- **/
router.patch("/:id/void", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can void sales" });
    }

    const { id } = req.params;
    const { reason } = req.body;

    const voidedSale = await runTransaction(async (session) => {
    const sale = await Sale.findById(id)
      .select("+receiptVerification.tokenHash")
      .session(session)
      .lean();
    if (!sale) {
      throw new HttpError(404, "Sale not found");
    }

    if (sale.status === "voided") {
      throw new HttpError(409, "Sale is already voided");
    }

    // Return stock to inventory (only for sales and reservations with items)
    // ✅ FIXED: Check for reservation type as well
    if ((sale.type === "sale" || sale.type === "reservation") && sale.items && sale.items.length > 0) {
      for (const item of sale.items) {
        const restoredProduct = await Product.findByIdAndUpdate(
          item.productId,
          { $inc: { stock: item.quantity } },
          { session }
        );
        if (!restoredProduct) {
          throw new HttpError(409, `Produit introuvable: ${item.name}`);
        }
      }
    }

    const updatedSale = await Sale.findByIdAndUpdate(
      id,
      {
        status: "voided",
        voidedBy: req.user.userId,
        voidedAt: new Date(),
        ...(sale.receiptVerification?.tokenHash
          ? {
              "receiptVerification.invalidatedAt": new Date(),
              "receiptVerification.invalidationReason": reason || "Sale voided",
            }
          : {}),
        $push: {
          editHistory: {
            editedBy: req.user.username,
            editedAt: new Date(),
            changes: { status: { from: sale.status, to: "voided" } },
            reason: reason || "Sale voided"
          }
        }
      },
      { new: true, session }
    );

    // FIX: Recalculate customer stats after voiding (only for sales and reservations)
    if (sale.customerId && (sale.type === "sale" || sale.type === "reservation")) {
      await recalculateCustomerStats(sale.customerId, session);
    }
    return updatedSale;
    });

    res.json(safeSaleResponse(voidedSale));
  } catch (error) {
    console.error("Error voiding sale:", error);
    return sendMutationError(res, error, "Failed to void sale");
  }
});

/** ---------- DELETE SALE ---------- **/
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can delete sales" });
    }
    const sale = await Sale.findById(req.params.id).lean();
    
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // 🔹 NEW: RESTRICTION - Only admin can delete reservations
    if (sale.type === "reservation" && req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Only admin can delete reservations" 
      });
    }

    const stockReturned = await runTransaction(async (session) => {
    const sale = await Sale.findById(req.params.id).session(session).lean();
    if (!sale) throw new HttpError(404, "Sale not found");
    if (sale.type === "reservation" && req.user.role !== "admin") {
      throw new HttpError(403, "Only admin can delete reservations");
    }
    const customerId = sale.customerId;
    
    // ✅ FIXED: RETURN STOCK TO INVENTORY WHEN DELETING RESERVATIONS OR SALES
    // Only return stock if the sale wasn't already voided (to avoid double return)
    if ((sale.type === "reservation" || sale.type === "sale") && 
        sale.items && sale.items.length > 0 && 
        sale.status !== "voided") {
      
      console.log(`🔄 Returning stock for deleted ${sale.type}:`, {
        saleId: sale._id,
        itemsCount: sale.items.length,
        items: sale.items.map(item => ({
          productId: item.productId,
          name: item.name,
          quantity: item.quantity
        }))
      });
      
      for (const item of sale.items) {
        try {
          const updatedProduct = await Product.findByIdAndUpdate(
            item.productId,
            { $inc: { stock: item.quantity } },
            { new: true, session }
          );
          
          if (!updatedProduct) {
            throw new HttpError(409, `Produit introuvable: ${item.name}`);
          }
          if (updatedProduct) {
            console.log(`✅ Returned ${item.quantity} units of "${item.name}", new stock: ${updatedProduct.stock}`);
          } else {
            console.warn(`❌ Product not found for ID: ${item.productId}`);
          }
        } catch (productError) {
          console.error(`Error returning stock for product ${item.productId}:`, productError);
          throw productError;
        }
      }
    }

    // Delete the sale record
    await Sale.findByIdAndDelete(req.params.id, { session });

    // Update customer statistics (only for sales and reservations, not expenses)
    if (customerId && (sale.type === "sale" || sale.type === "reservation")) {
      await recalculateCustomerStats(customerId, session);
    }
    return (sale.type === "reservation" || sale.type === "sale") &&
      sale.status !== "voided" && sale.items && sale.items.length > 0;
    });

    res.json({ 
      success: true,
      message: "Sale deleted successfully",
      stockReturned
    });
  } catch (error) {
    console.error("Error deleting sale:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    
    return sendMutationError(res, error, "Failed to delete sale");
  }
});

module.exports = router;
