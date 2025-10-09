const express = require("express");
const router = express.Router();
const Expense = require("../models/Expense");
const authMiddleware = require("../middleware/auth");

// Helper function to normalize payment method
function normalizePaymentMethod(pm) {
  const v = String(pm || "cash").toLowerCase();
  if (v === "cash") return "cash";
  if (v === "card") return "card";
  if (["mpesa", "m-pesa", "bank", "transfer", "wire", "bank transfer"].includes(v)) {
    return "bank"; // Fixed to match model enum
  }
  return "other";
}

// Helper function to sanitize input
function sanitizeInput(input) {
  return String(input || "").trim();
}

/** ---------- CREATE EXPENSE ---------- **/
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { reason, recipientName, recipientPhone, amount, paymentMethod, notes, recordedBy } = req.body;

    // Validation
    if (!reason || !recipientName || !recipientPhone || !amount) {
      return res.status(400).json({ 
        error: "Reason, recipientName, recipientPhone, and amount are required" 
      });
    }

    const expenseAmount = parseFloat(amount);
    if (isNaN(expenseAmount) || expenseAmount <= 0) {
      return res.status(400).json({ 
        error: "Amount must be a positive number" 
      });
    }

    // Sanitize inputs
    const sanitizedReason = sanitizeInput(reason);
    const sanitizedRecipientName = sanitizeInput(recipientName);
    const sanitizedRecipientPhone = sanitizeInput(recipientPhone).replace(/\s+/g, "");
    const sanitizedNotes = sanitizeInput(notes);
    const sanitizedRecordedBy = sanitizeInput(recordedBy || req.user?.id || "Unknown");

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // Generate unique expense ID
    const expenseId = `EXP-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    const expenseData = {
      expenseId,
      reason: sanitizedReason,
      recipientName: sanitizedRecipientName,
      recipientPhone: sanitizedRecipientPhone,
      amount: expenseAmount,
      paymentMethod: normalizedPM,
      recordedBy: sanitizedRecordedBy,
      notes: sanitizedNotes
    };

    const expense = new Expense(expenseData);
    const savedExpense = await expense.save();

    return res.status(201).json(savedExpense);
  } catch (error) {
    console.error("Error creating expense:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    if (error.code === 11000) {
      return res.status(400).json({ error: "Expense ID already exists" });
    }
    return res.status(500).json({ error: "Failed to create expense" });
  }
});

/** ---------- GET ALL EXPENSES (with pagination & filtering) ---------- **/
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { 
      status, 
      paymentMethod, 
      startDate, 
      endDate, 
      search,
      page = 1, 
      limit = 50 
    } = req.query;

    const filter = {};
    
    // Status filter
    if (status && ["pending", "validated", "rejected"].includes(status)) {
      filter.status = status;
    }
    
    // Payment method filter
    if (paymentMethod && ["cash", "card", "bank", "mpesa", "other"].includes(paymentMethod)) {
      filter.paymentMethod = paymentMethod;
    }
    
    // Date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    
    // Search filter
    if (search) {
      filter.$or = [
        { reason: { $regex: search, $options: "i" } },
        { recipientName: { $regex: search, $options: "i" } },
        { expenseId: { $regex: search, $options: "i" } },
        { recordedBy: { $regex: search, $options: "i" } }
      ];
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const expenses = await Expense.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    const total = await Expense.countDocuments(filter);
    const totalPages = Math.ceil(total / limitNum);
    
    res.json({
      expenses,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1
      }
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

/** ---------- GET EXPENSE BY ID ---------- **/
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }
    res.json(expense);
  } catch (error) {
    console.error("Error fetching expense:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid expense ID" });
    }
    res.status(500).json({ error: "Failed to fetch expense" });
  }
});

/** ---------- VALIDATE EXPENSE ---------- **/
router.patch("/:id/validate", authMiddleware, async (req, res) => {
  try {
    const { validatedBy, notes } = req.body;
    
    // Check authorization (assuming user object has role/permissions)
    if (req.user && !req.user.canValidate) {
      return res.status(403).json({ error: "Insufficient permissions to validate expenses" });
    }

    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    if (expense.status === "validated") {
      return res.status(400).json({ error: "Expense is already validated" });
    }

    if (expense.status === "rejected") {
      return res.status(400).json({ error: "Cannot validate a rejected expense" });
    }

    const validationNotes = notes ? `Validated: ${notes}` : "Expense validated";
    const updatedNotes = expense.notes ? `${expense.notes}\n${validationNotes}` : validationNotes;

    const updatedExpense = await Expense.findByIdAndUpdate(
      req.params.id,
      {
        status: "validated",
        validatedBy: validatedBy || req.user?.id || "Admin",
        validatedAt: new Date(),
        notes: updatedNotes
      },
      { new: true, runValidators: true }
    );

    res.json(updatedExpense);
  } catch (error) {
    console.error("Error validating expense:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid expense ID" });
    }
    res.status(500).json({ error: "Failed to validate expense" });
  }
});

/** ---------- REJECT EXPENSE ---------- **/
router.patch("/:id/reject", authMiddleware, async (req, res) => {
  try {
    const { reason, notes } = req.body;
    
    // Check authorization
    if (req.user && !req.user.canValidate) {
      return res.status(403).json({ error: "Insufficient permissions to reject expenses" });
    }

    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    if (expense.status === "rejected") {
      return res.status(400).json({ error: "Expense is already rejected" });
    }

    if (expense.status === "validated") {
      return res.status(400).json({ error: "Cannot reject a validated expense" });
    }

    if (!reason) {
      return res.status(400).json({ error: "Rejection reason is required" });
    }

    const rejectionNotes = `Rejected: ${reason}${notes ? ` - ${notes}` : ''}`;
    const updatedNotes = expense.notes ? `${expense.notes}\n${rejectionNotes}` : rejectionNotes;

    const updatedExpense = await Expense.findByIdAndUpdate(
      req.params.id,
      {
        status: "rejected",
        validatedBy: req.user?.id || "Admin",
        validatedAt: new Date(),
        notes: updatedNotes
      },
      { new: true, runValidators: true }
    );

    res.json(updatedExpense);
  } catch (error) {
    console.error("Error rejecting expense:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid expense ID" });
    }
    res.status(500).json({ error: "Failed to reject expense" });
  }
});

/** ---------- UPDATE EXPENSE ---------- **/
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { reason, recipientName, recipientPhone, amount, paymentMethod, notes } = req.body;

    // Validation
    if (!reason || !recipientName || !recipientPhone || !amount) {
      return res.status(400).json({ 
        error: "Reason, recipientName, recipientPhone, and amount are required" 
      });
    }

    const expenseAmount = parseFloat(amount);
    if (isNaN(expenseAmount) || expenseAmount <= 0) {
      return res.status(400).json({ 
        error: "Amount must be a positive number" 
      });
    }

    // Sanitize inputs
    const sanitizedReason = sanitizeInput(reason);
    const sanitizedRecipientName = sanitizeInput(recipientName);
    const sanitizedRecipientPhone = sanitizeInput(recipientPhone).replace(/\s+/g, "");
    const sanitizedNotes = sanitizeInput(notes);

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // Check if expense exists and can be updated
    const existingExpense = await Expense.findById(req.params.id);
    if (!existingExpense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Prevent updating validated or rejected expenses
    if (existingExpense.status !== "pending") {
      return res.status(400).json({ 
        error: `Cannot update ${existingExpense.status} expense. Only pending expenses can be modified.` 
      });
    }

    const updatedExpense = await Expense.findByIdAndUpdate(
      req.params.id,
      {
        reason: sanitizedReason,
        recipientName: sanitizedRecipientName,
        recipientPhone: sanitizedRecipientPhone,
        amount: expenseAmount,
        paymentMethod: normalizedPM,
        notes: sanitizedNotes
      },
      { new: true, runValidators: true }
    );

    res.json(updatedExpense);
  } catch (error) {
    console.error("Error updating expense:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid expense ID" });
    }
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    res.status(500).json({ error: "Failed to update expense" });
  }
});

/** ---------- DELETE EXPENSE ---------- **/
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Prevent deleting validated or rejected expenses
    if (expense.status !== "pending") {
      return res.status(400).json({ 
        error: `Cannot delete ${expense.status} expense. Only pending expenses can be deleted.` 
      });
    }

    await Expense.findByIdAndDelete(req.params.id);
    res.json({ 
      message: "Expense deleted successfully",
      deletedExpense: {
        id: expense._id,
        expenseId: expense.expenseId,
        reason: expense.reason
      }
    });
  } catch (error) {
    console.error("Error deleting expense:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid expense ID" });
    }
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

/** ---------- GET EXPENSE STATISTICS ---------- **/
router.get("/stats/summary", authMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    const stats = await Expense.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" }
        }
      }
    ]);

    const totalStats = await Expense.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgAmount: { $avg: "$amount" }
        }
      }
    ]);

    const paymentMethodStats = await Expense.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: "$paymentMethod",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" }
        }
      }
    ]);

    res.json({
      statusBreakdown: stats,
      totals: totalStats[0] || { totalExpenses: 0, totalAmount: 0, avgAmount: 0 },
      paymentMethods: paymentMethodStats
    });
  } catch (error) {
    console.error("Error fetching expense statistics:", error);
    res.status(500).json({ error: "Failed to fetch expense statistics" });
  }
});

module.exports = router;