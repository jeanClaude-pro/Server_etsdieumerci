const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Entry = require("../models/Entry");
const authMiddleware = require("../middleware/auth");

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

/** ---------- LIST ENTRIES (Active only by default) ---------- */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      dateFrom, 
      dateTo,
      category,
      source,
      status = "active" // Default to active only
    } = req.query;
    
    const p = parseInt(page, 10);
    const l = parseInt(limit, 10);
    const filter = {};

    // Status filter
    if (status) {
      filter.status = status;
    }

    // Category filter
    if (category) {
      filter.category = category;
    }

    // Source filter
    if (source) {
      filter.source = source;
    }

    // Date range filter (like your sales route)
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    const entries = await Entry.find(filter)
      .populate("createdBy", "username")
      .populate("updatedBy", "username")
      .skip((p - 1) * l)
      .limit(l)
      .sort({ createdAt: -1 });

    const totalEntries = await Entry.countDocuments(filter);

    res.json({
      entries,
      pagination: { total: totalEntries, page: p, limit: l },
    });
  } catch (error) {
    console.error("Error fetching entries:", error);
    res.status(500).json({ error: "Failed to fetch entries" });
  }
});

/** ---------- GET ENTRY BY ID ---------- */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const entryId = req.params.id;
    
    const entry = await Entry.findById(entryId)
      .populate("createdBy", "username")
      .populate("updatedBy", "username")
      .populate("editHistory.editedBy", "username");

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
    }).sort({ createdAt: -1 });

    // Calculate category breakdown
    const categoryBreakdown = {};
    if (dailyEntries[0]?.categories) {
      dailyEntries[0].categories.forEach(item => {
        categoryBreakdown[item.category] = (categoryBreakdown[item.category] || 0) + item.amount;
      });
    }

    res.json({
      date: targetDate.toISOString().split("T")[0],
      totalEntries: dailyEntries[0]?.totalEntries || 0,
      totalAmount: dailyEntries[0]?.totalAmount || 0,
      categoryBreakdown,
      entries,
    });
  } catch (error) {
    console.error("Error fetching daily entry stats:", error);
    res.status(500).json({ error: "Failed to fetch daily statistics" });
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
      role: req.user.role
    };

    res.json(permissions);
  } catch (error) {
    console.error("Error fetching user permissions:", error);
    res.status(500).json({ error: "Failed to fetch user permissions" });
  }
});

module.exports = router;