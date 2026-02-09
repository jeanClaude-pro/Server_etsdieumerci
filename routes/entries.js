const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Entry = require("../models/Entry");
const authMiddleware = require("../middleware/auth");

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

// Normalize payment method (same as your sales route)
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

// ==================== MAIN ENTRIES ENDPOINT (TIME FRAME PAGINATION) ====================

/** 
 * GET /api/entries
 * Timeframe-based pagination (no numeric pagination)
 * Priority: custom range > specific day > month > year > today (default)
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { 
      category,
      source,
      status,
      search,
      createdBy
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
    
    // 2. Apply status filter if provided, otherwise use default
    if (status) {
      if (status === 'all') {
        // Include all statuses
        filter.status = { $in: ["active", "deleted"] };
      } else if (["active", "deleted"].includes(status)) {
        filter.status = status;
      } else {
        return res.status(400).json({ error: "Invalid status. Use 'active', 'deleted', or 'all'" });
      }
    } else {
      // Default: include only active entries
      filter.status = "active";
    }
    
    // 3. Apply category filter if provided
    if (category) {
      filter.category = category;
    }
    
    // 4. Apply source filter if provided
    if (source) {
      filter.source = source;
    }
    
    // 5. Apply createdBy filter if provided
    if (createdBy) {
      filter.createdBy = createdBy;
    }
    
    // 6. Apply search filter if provided
    if (search) {
      filter.$or = [
        { entryId: { $regex: search, $options: "i" } },
        { source: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } }
      ];
    }

    // Execute query - get ALL records within timeframe (no skip/limit)
    const entries = await Entry.find(filter)
      .populate("createdBy", "username email")
      .populate("updatedBy", "username")
      .select('-__v') // Exclude version key
      .sort({ createdAt: -1 }) // Newest first
      .lean();

    // Get count for metadata
    const total = entries.length;

    // Generate timeframe metadata
    const timeframeDescription = getTimeframeDescription(req.query);
    const timeframeFilter = buildTimeframeFilter(req.query);

    // Calculate totals for quick insights
    const totals = entries.reduce((acc, entry) => {
      acc.totalAmount += entry.amount;
      
      // Count by status
      if (entry.status === "active") {
        acc.activeCount += 1;
        acc.activeAmount += entry.amount;
      } else if (entry.status === "deleted") {
        acc.deletedCount += 1;
        acc.deletedAmount += entry.amount;
      }
      
      // Count by payment method
      acc.paymentMethods[entry.paymentMethod] = 
        (acc.paymentMethods[entry.paymentMethod] || 0) + entry.amount;
      
      // Count by category
      acc.categories[entry.category] = 
        (acc.categories[entry.category] || 0) + entry.amount;
      
      return acc;
    }, {
      totalAmount: 0,
      activeCount: 0,
      activeAmount: 0,
      deletedCount: 0,
      deletedAmount: 0,
      paymentMethods: {},
      categories: {}
    });

    // Prepare response with timeframe metadata
    const response = {
      success: true,
      data: entries,
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
        totalAmount: totals.totalAmount,
        active: {
          count: totals.activeCount,
          amount: totals.activeAmount
        },
        deleted: {
          count: totals.deletedCount,
          amount: totals.deletedAmount
        },
        categories: totals.categories,
        paymentMethods: totals.paymentMethods
      },
      filtersApplied: {
        status: status || 'default (active only)',
        category: category || 'none',
        source: source || 'none',
        createdBy: createdBy || 'none',
        search: search || 'none'
      },
      // Performance warning for large datasets
      performanceNote: total > 1000 
        ? `Large dataset (${total} records). Consider using a more specific timeframe.`
        : null
    };

    res.json(response);
    
  } catch (error) {
    console.error("Error fetching entries with timeframe pagination:", error);
    
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
      error: "Failed to fetch entries",
      suggestion: "Check your query parameters and try again"
    });
  }
});

// ==================== ALL OTHER ROUTES ====================

/** ---------- CREATE ENTRY (Everyone can create) ---------- */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { 
      amount, 
      source, 
      paymentMethod, 
      category, 
      description,
      receivedFrom 
    } = req.body;

    // Validation (like your sale validation)
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        error: "Amount is required and must be positive" 
      });
    }
    if (!source) {
      return res.status(400).json({ 
        error: "Source is required" 
      });
    }
    if (!category) {
      return res.status(400).json({ 
        error: "Category is required" 
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);
    const entryAmount = parseFloat(amount);

    // Generate unique entry ID (like your saleId)
    const entryId = `ENTRY-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    const entryData = {
      entryId,
      amount: entryAmount,
      source: source.trim(),
      paymentMethod: normalizedPM,
      category: category.trim(),
      description: description ? description.trim() : "",
      receivedFrom: receivedFrom || {},
      createdBy: req.user.userId
    };

    const entry = new Entry(entryData);
    const savedEntry = await entry.save();

    return res.status(201).json(savedEntry);
  } catch (error) {
    console.error("Error creating entry:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    return res.status(500).json({ error: "Failed to create entry" });
  }
});

/** ---------- GET ENTRY BY ID ---------- */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const entryId = req.params.id;
    
    const entry = await Entry.findById(entryId)
      .populate("createdBy", "username email")
      .populate("updatedBy", "username")
      .populate("editHistory.editedBy", "username email");

    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    res.json(entry);
  } catch (error) {
    console.error("Error fetching entry:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    res.status(500).json({ error: "Failed to fetch entry" });
  }
});

/** ---------- EDIT ENTRY (Admin only) ---------- */
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Access denied. Only administrators can edit entries." 
      });
    }

    const { id } = req.params;
    const { 
      amount, 
      source, 
      paymentMethod, 
      category, 
      description,
      receivedFrom,
      reason 
    } = req.body;

    // Validate required fields for edit
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        error: "Amount is required and must be positive" 
      });
    }
    if (!source) {
      return res.status(400).json({ 
        error: "Source is required" 
      });
    }
    if (!category) {
      return res.status(400).json({ 
        error: "Category is required" 
      });
    }
    if (!reason || reason.trim() === "") {
      return res.status(400).json({ 
        error: "Reason for editing is required" 
      });
    }

    // Find the original entry
    const originalEntry = await Entry.findById(id);
    if (!originalEntry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    // Prevent editing deleted entries
    if (originalEntry.status === "deleted") {
      return res.status(400).json({ 
        error: "Cannot edit a deleted entry" 
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);
    const entryAmount = parseFloat(amount);

    // Track changes for audit
    const changes = new Map();
    
    if (originalEntry.amount !== entryAmount) {
      changes.set('amount', { 
        from: originalEntry.amount, 
        to: entryAmount 
      });
    }
    if (originalEntry.source !== source) {
      changes.set('source', { 
        from: originalEntry.source, 
        to: source 
      });
    }
    if (originalEntry.paymentMethod !== normalizedPM) {
      changes.set('paymentMethod', { 
        from: originalEntry.paymentMethod, 
        to: normalizedPM 
      });
    }
    if (originalEntry.category !== category) {
      changes.set('category', { 
        from: originalEntry.category, 
        to: category 
      });
    }
    if (originalEntry.description !== description) {
      changes.set('description', { 
        from: originalEntry.description, 
        to: description 
      });
    }
    if (JSON.stringify(originalEntry.receivedFrom) !== JSON.stringify(receivedFrom)) {
      changes.set('receivedFrom', { 
        from: originalEntry.receivedFrom, 
        to: receivedFrom 
      });
    }

    // Check if there are actual changes
    if (changes.size === 0) {
      return res.status(400).json({ 
        error: "No changes detected" 
      });
    }

    const updatedEntry = await Entry.findByIdAndUpdate(
      id,
      {
        amount: entryAmount,
        source: source.trim(),
        paymentMethod: normalizedPM,
        category: category.trim(),
        description: description ? description.trim() : "",
        receivedFrom: receivedFrom || {},
        updatedBy: req.user.userId,
        $push: {
          editHistory: {
            editedBy: req.user.userId,
            editedAt: new Date(),
            changes: Object.fromEntries(changes),
            reason: reason.trim()
          }
        }
      },
      { new: true, runValidators: true }
    ).populate("createdBy", "username")
     .populate("updatedBy", "username")
     .populate("editHistory.editedBy", "username");

    res.json({
      message: "Entry updated successfully",
      entry: updatedEntry
    });
  } catch (error) {
    console.error("Error editing entry:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    res.status(500).json({ error: "Failed to edit entry" });
  }
});

/** ---------- DELETE ENTRY (Admin only - soft delete) ---------- */
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Access denied. Only administrators can delete entries." 
      });
    }

    const entry = await Entry.findById(req.params.id);
    
    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    if (entry.status === "deleted") {
      return res.status(400).json({ error: "Entry is already deleted" });
    }

    // Soft delete
    const deletedEntry = await Entry.findByIdAndUpdate(
      req.params.id,
      {
        status: "deleted",
        deletedBy: req.user.userId,
        deletedAt: new Date()
      },
      { new: true }
    );

    res.json({ 
      message: "Entry deleted successfully", 
      entry: deletedEntry 
    });
  } catch (error) {
    console.error("Error deleting entry:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

/** ---------- RESTORE ENTRY (Admin only) ---------- */
router.patch("/:id/restore", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Access denied. Only administrators can restore entries." 
      });
    }

    const entry = await Entry.findById(req.params.id);
    
    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    if (entry.status !== "deleted") {
      return res.status(400).json({ error: "Entry is not deleted" });
    }

    const restoredEntry = await Entry.findByIdAndUpdate(
      req.params.id,
      {
        status: "active",
        deletedBy: null,
        deletedAt: null,
        updatedBy: req.user.userId
      },
      { new: true }
    );

    res.json({ 
      message: "Entry restored successfully", 
      entry: restoredEntry 
    });
  } catch (error) {
    console.error("Error restoring entry:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    
    res.status(500).json({ error: "Failed to restore entry" });
  }
});

/** ---------- DAILY ENTRY STATS (like your sales stats) ---------- */
router.get("/stats/daily", authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const dailyEntries = await Entry.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfDay, $lte: endOfDay },
          status: "active"
        },
      },
      {
        $group: {
          _id: null,
          totalEntries: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          // Group by category
          categories: {
            $push: {
              category: "$category",
              amount: "$amount"
            }
          }
        },
      },
    ]);

    const entries = await Entry.find({
      createdAt: { $gte: startOfDay, $lte: endOfDay },
      status: "active"
    })
    .populate("createdBy", "username email")
    .sort({ createdAt: -1 })
    .lean();

    // Calculate category breakdown
    const categoryBreakdown = {};
    if (dailyEntries[0]?.categories) {
      dailyEntries[0].categories.forEach(item => {
        categoryBreakdown[item.category] = (categoryBreakdown[item.category] || 0) + item.amount;
      });
    }

    // Calculate payment method breakdown
    const paymentMethodBreakdown = entries.reduce((acc, entry) => {
      acc[entry.paymentMethod] = (acc[entry.paymentMethod] || 0) + entry.amount;
      return acc;
    }, {});

    res.json({
      date: targetDate.toISOString().split("T")[0],
      totalEntries: dailyEntries[0]?.totalEntries || 0,
      totalAmount: dailyEntries[0]?.totalAmount || 0,
      categoryBreakdown,
      paymentMethodBreakdown,
      entries,
    });
  } catch (error) {
    console.error("Error fetching daily entry stats:", error);
    res.status(500).json({ error: "Failed to fetch daily statistics" });
  }
});

/** ---------- GET ENTRY STATISTICS WITH TIMEFRAME FILTERING ---------- */
router.get("/stats/summary", authMiddleware, async (req, res) => {
  try {
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }

    // Add status filter (active only for stats)
    timeframeFilter.status = "active";

    const stats = await Entry.aggregate([
      { $match: timeframeFilter },
      {
        $group: {
          _id: null,
          totalEntries: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgAmount: { $avg: "$amount" },
          maxAmount: { $max: "$amount" },
          minAmount: { $min: "$amount" }
        }
      }
    ]);

    const categoryStats = await Entry.aggregate([
      { $match: timeframeFilter },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgAmount: { $avg: "$amount" }
        }
      },
      { $sort: { totalAmount: -1 } }
    ]);

    const sourceStats = await Entry.aggregate([
      { $match: timeframeFilter },
      {
        $group: {
          _id: "$source",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgAmount: { $avg: "$amount" }
        }
      },
      { $sort: { totalAmount: -1 } }
    ]);

    const paymentMethodStats = await Entry.aggregate([
      { $match: timeframeFilter },
      {
        $group: {
          _id: "$paymentMethod",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgAmount: { $avg: "$amount" }
        }
      },
      { $sort: { totalAmount: -1 } }
    ]);

    // Get daily breakdown for the timeframe
    const dailyBreakdown = await Entry.aggregate([
      { $match: timeframeFilter },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" }
          },
          date: { $first: "$createdAt" },
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
      { $limit: 30 } // Limit to last 30 days
    ]);

    // Get top entries
    const topEntries = await Entry.find(timeframeFilter)
      .populate("createdBy", "username email")
      .sort({ amount: -1 })
      .limit(10)
      .select('entryId source amount category paymentMethod createdAt')
      .lean();

    // Get most frequent sources
    const frequentSources = await Entry.aggregate([
      { $match: timeframeFilter },
      {
        $group: {
          _id: "$source",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgAmount: { $avg: "$amount" }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Format the daily breakdown
    const formattedDailyBreakdown = dailyBreakdown.map(day => ({
      date: day.date.toISOString().split('T')[0],
      count: day.count,
      totalAmount: day.totalAmount
    }));

    res.json({
      timeframe: {
        description: getTimeframeDescription(req.query),
        start: timeframeFilter.createdAt.$gte,
        end: timeframeFilter.createdAt.$lte
      },
      totals: stats[0] || { 
        totalEntries: 0, 
        totalAmount: 0, 
        avgAmount: 0,
        maxAmount: 0,
        minAmount: 0
      },
      categories: categoryStats,
      sources: sourceStats,
      paymentMethods: paymentMethodStats,
      dailyBreakdown: formattedDailyBreakdown,
      topEntries: topEntries,
      frequentSources: frequentSources
    });
  } catch (error) {
    console.error("Error fetching entry statistics:", error);
    res.status(500).json({ error: "Failed to fetch entry statistics" });
  }
});

/** ---------- GET ENTRIES BY CATEGORY WITH TIMEFRAME ---------- */
router.get("/category/:category", authMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }

    // Add category filter
    timeframeFilter.category = category;
    timeframeFilter.status = "active";

    const entries = await Entry.find(timeframeFilter)
      .populate("createdBy", "username email")
      .sort({ createdAt: -1 })
      .lean();

    const totalAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);

    res.json({
      success: true,
      category: category,
      timeframe: getTimeframeDescription(req.query),
      summary: {
        count: entries.length,
        totalAmount: totalAmount,
        averageAmount: entries.length > 0 ? totalAmount / entries.length : 0
      },
      entries: entries
    });
  } catch (error) {
    console.error("Error fetching entries by category:", error);
    res.status(500).json({ error: "Failed to fetch entries by category" });
  }
});

/** ---------- GET ENTRIES BY SOURCE WITH TIMEFRAME ---------- */
router.get("/source/:source", authMiddleware, async (req, res) => {
  try {
    const { source } = req.params;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }

    // Add source filter
    timeframeFilter.source = source;
    timeframeFilter.status = "active";

    const entries = await Entry.find(timeframeFilter)
      .populate("createdBy", "username email")
      .sort({ createdAt: -1 })
      .lean();

    const totalAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);

    res.json({
      success: true,
      source: source,
      timeframe: getTimeframeDescription(req.query),
      summary: {
        count: entries.length,
        totalAmount: totalAmount,
        averageAmount: entries.length > 0 ? totalAmount / entries.length : 0
      },
      entries: entries
    });
  } catch (error) {
    console.error("Error fetching entries by source:", error);
    res.status(500).json({ error: "Failed to fetch entries by source" });
  }
});

/** ---------- GET ENTRIES BY PAYMENT METHOD WITH TIMEFRAME ---------- */
router.get("/payment/:method", authMiddleware, async (req, res) => {
  try {
    const { method } = req.params;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }

    // Add payment method filter
    timeframeFilter.paymentMethod = method;
    timeframeFilter.status = "active";

    const entries = await Entry.find(timeframeFilter)
      .populate("createdBy", "username email")
      .sort({ createdAt: -1 })
      .lean();

    const totalAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);

    res.json({
      success: true,
      paymentMethod: method,
      timeframe: getTimeframeDescription(req.query),
      summary: {
        count: entries.length,
        totalAmount: totalAmount,
        averageAmount: entries.length > 0 ? totalAmount / entries.length : 0
      },
      entries: entries
    });
  } catch (error) {
    console.error("Error fetching entries by payment method:", error);
    res.status(500).json({ error: "Failed to fetch entries by payment method" });
  }
});

/** ---------- GET USER'S ENTRIES WITH TIMEFRAME ---------- */
router.get("/user/me", authMiddleware, async (req, res) => {
  try {
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }

    // Add user filter
    timeframeFilter.createdBy = req.user.userId;
    timeframeFilter.status = "active";

    const entries = await Entry.find(timeframeFilter)
      .populate("createdBy", "username email")
      .sort({ createdAt: -1 })
      .lean();

    const totalAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);

    res.json({
      success: true,
      userId: req.user.userId,
      timeframe: getTimeframeDescription(req.query),
      summary: {
        count: entries.length,
        totalAmount: totalAmount,
        averageAmount: entries.length > 0 ? totalAmount / entries.length : 0
      },
      entries: entries
    });
  } catch (error) {
    console.error("Error fetching user's entries:", error);
    res.status(500).json({ error: "Failed to fetch user's entries" });
  }
});

/** ---------- GET USER PERMISSIONS ---------- */
router.get("/permissions/me", authMiddleware, async (req, res) => {
  try {
    const permissions = {
      canCreate: true, // Everyone can create entries
      canEdit: req.user.role === "admin",
      canDelete: req.user.role === "admin",
      canRestore: req.user.role === "admin",
      role: req.user.role,
      userId: req.user.userId,
      userName: req.user.username || req.user.email || "User"
    };

    res.json(permissions);
  } catch (error) {
    console.error("Error fetching user permissions:", error);
    res.status(500).json({ error: "Failed to fetch user permissions" });
  }
});

/** ---------- GET ENTRIES HISTORY/AUDIT LOG ---------- */
router.get("/:id/history", authMiddleware, async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id)
      .populate("editHistory.editedBy", "username email");

    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    res.json({
      entryId: entry.entryId,
      currentStatus: entry.status,
      history: entry.editHistory || []
    });
  } catch (error) {
    console.error("Error fetching entry history:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid entry ID" });
    }
    res.status(500).json({ error: "Failed to fetch entry history" });
  }
});

module.exports = router;