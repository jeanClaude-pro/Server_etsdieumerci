const express = require("express");
const router = express.Router();
const Expense = require("../models/Expense");
const authMiddleware = require("../middleware/auth");
const nodemailer = require("nodemailer");

// ✅ CREATE EMAIL TRANSPORTER
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ✅ EMAIL FUNCTIONS
async function sendExpenseNotification(expense) {
  try {
    const adminEmails = process.env.ADMIN_EMAILS ? 
      process.env.ADMIN_EMAILS.split(',') : 
      [process.env.DEFAULT_ADMIN_EMAIL || "admin@example.com"];
    
    const formattedAmount = new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'USD'
    }).format(expense.amount);
    
    const mailOptions = {
      from: process.env.EMAIL_FROM || "noreply@expenses.com",
      to: adminEmails,
      subject: `[NOUVELLE DÉPENSE] ${expense.expenseId} - ${expense.reason}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #4a6fa5; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
            .detail { margin-bottom: 10px; }
            .label { font-weight: bold; color: #555; }
            .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #777; font-size: 12px; }
            .action { background-color: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>Nouvelle Dépense Créée</h2>
              <p>Dépense ID: ${expense.expenseId}</p>
            </div>
            <div class="content">
              <div class="detail"><span class="label">Statut:</span> <strong>EN ATTENTE</strong></div>
              <div class="detail"><span class="label">Raison:</span> ${expense.reason}</div>
              <div class="detail"><span class="label">Bénéficiaire:</span> ${expense.recipientName}</div>
              <div class="detail"><span class="label">Téléphone:</span> ${expense.recipientPhone}</div>
              <div class="detail"><span class="label">Montant:</span> ${formattedAmount}</div>
              <div class="detail"><span class="label">Méthode de paiement:</span> ${expense.paymentMethod}</div>
              <div class="detail"><span class="label">Enregistré par:</span> ${expense.recordedBy}</div>
              <div class="detail"><span class="label">Date:</span> ${new Date(expense.createdAt).toLocaleString('fr-FR')}</div>
              
              <div class="action">
                <strong>Action Requise:</strong> Veuillez valider ou rejeter cette dépense dans le système.
              </div>
              
              <p><a href="${process.env.APP_URL || 'http://localhost:3000'}/expenses">Cliquez ici pour accéder au système</a></p>
            </div>
            <div class="footer">
              <p>Cet email a été envoyé automatiquement par le système de gestion des dépenses.</p>
              <p>Ne pas répondre à cet email.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`New expense notification email sent for ${expense.expenseId}`);
  } catch (error) {
    console.error('Error sending expense notification email:', error);
  }
}

async function sendExpenseUpdateNotification(expense, updatedBy, updateReason) {
  try {
    const adminEmails = process.env.ADMIN_EMAILS ? 
      process.env.ADMIN_EMAILS.split(',') : 
      [process.env.DEFAULT_ADMIN_EMAIL || "admin@example.com"];
    
    const formattedAmount = new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'USD'
    }).format(expense.amount);
    
    const mailOptions = {
      from: process.env.EMAIL_FROM || "noreply@expenses.com",
      to: adminEmails,
      subject: `[MISE À JOUR] Dépense ${expense.expenseId} mise à jour`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #4a6fa5; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
            .detail { margin-bottom: 10px; }
            .label { font-weight: bold; color: #555; }
            .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #777; font-size: 12px; }
            .warning { background-color: #fff3cd; border: 1px solid #ffc107; padding: 10px; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>Mise à Jour de Dépense</h2>
              <p>Dépense ID: ${expense.expenseId}</p>
            </div>
            <div class="content">
              <div class="detail"><span class="label">Statut:</span> ${expense.status}</div>
              <div class="detail"><span class="label">Raison:</span> ${expense.reason}</div>
              <div class="detail"><span class="label">Bénéficiaire:</span> ${expense.recipientName}</div>
              <div class="detail"><span class="label">Montant:</span> ${formattedAmount}</div>
              <div class="detail"><span class="label">Méthode de paiement:</span> ${expense.paymentMethod}</div>
              <div class="detail"><span class="label">Mis à jour par:</span> ${updatedBy}</div>
              <div class="detail"><span class="label">Raison de la mise à jour:</span> ${updateReason || 'Non spécifiée'}</div>
              <div class="detail"><span class="label">Date de mise à jour:</span> ${new Date().toLocaleString('fr-FR')}</div>
              
              <div class="warning">
                <strong>⚠️ Note:</strong> Cette dépense a été modifiée. Veuillez vérifier les détails mis à jour.
              </div>
            </div>
            <div class="footer">
              <p>Cet email a été envoyé automatiquement par le système de gestion des dépenses.</p>
              <p>Ne pas répondre à cet email.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`Update notification email sent for expense ${expense.expenseId}`);
  } catch (error) {
    console.error('Error sending update notification email:', error);
  }
}

async function sendExpenseDeletionNotification(expenseInfo, deletedBy) {
  try {
    const adminEmails = process.env.ADMIN_EMAILS ? 
      process.env.ADMIN_EMAILS.split(',') : 
      [process.env.DEFAULT_ADMIN_EMAIL || "admin@example.com"];
    
    const formattedAmount = new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'USD'
    }).format(expenseInfo.amount);
    
    const mailOptions = {
      from: process.env.EMAIL_FROM || "noreply@expenses.com",
      to: adminEmails,
      subject: `[SUPPRESSION] Dépense ${expenseInfo.expenseId} supprimée`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #dc3545; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
            .detail { margin-bottom: 10px; }
            .label { font-weight: bold; color: #555; }
            .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #777; font-size: 12px; }
            .alert { background-color: #f8d7da; border: 1px solid #f5c6cb; padding: 10px; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>Suppression de Dépense</h2>
              <p>Dépense ID: ${expenseInfo.expenseId}</p>
            </div>
            <div class="content">
              <div class="alert">
                <strong>⚠️ ALERTE:</strong> Cette dépense a été supprimée définitivement du système.
              </div>
              
              <div class="detail"><span class="label">Ancien statut:</span> ${expenseInfo.status}</div>
              <div class="detail"><span class="label">Raison:</span> ${expenseInfo.reason}</div>
              <div class="detail"><span class="label">Bénéficiaire:</span> ${expenseInfo.recipientName}</div>
              <div class="detail"><span class="label">Montant:</span> ${formattedAmount}</div>
              <div class="detail"><span class="label">Supprimé par:</span> ${deletedBy}</div>
              <div class="detail"><span class="label">Date de suppression:</span> ${new Date().toLocaleString('fr-FR')}</div>
              
              <p><strong>Note:</strong> Cette action est permanente et ne peut pas être annulée.</p>
            </div>
            <div class="footer">
              <p>Cet email a été envoyé automatiquement par le système de gestion des dépenses.</p>
              <p>Ne pas répondre à cet email.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`Deletion notification email sent for expense ${expenseInfo.expenseId}`);
  } catch (error) {
    console.error('Error sending deletion notification email:', error);
  }
}

// Helper function to normalize payment method
function normalizePaymentMethod(pm) {
  const v = String(pm || "cash").toLowerCase();
  if (v === "cash") return "cash";
  if (v === "card") return "card";
  if (["mpesa", "m-pesa", "bank", "transfer", "wire", "bank transfer"].includes(v)) {
    return "bank";
  }
  return "other";
}

// Helper function to sanitize input
function sanitizeInput(input) {
  return String(input || "").trim();
}

// Helper to check if user is admin
function isAdminUser(user) {
  return user && (user.role === 'admin' || user.isAdmin === true || user.canValidate === true);
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
      notes: sanitizedNotes,
      status: "pending"
    };

    const expense = new Expense(expenseData);
    const savedExpense = await expense.save();

    // Send email notification
    sendExpenseNotification(savedExpense);

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

/** ---------- GET ALL EXPENSES (NO PAGINATION - returns all expenses) ---------- **/
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { 
      status, 
      paymentMethod, 
      startDate, 
      endDate, 
      search
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

    const expenses = await Expense.find(filter).sort({ createdAt: -1 });
    res.json(expenses);
    
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
    
    // Check authorization
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

/** ---------- UPDATE EXPENSE (ENHANCED FOR ALL STATUSES WITH ADMIN CHECK) ---------- **/
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { reason, recipientName, recipientPhone, amount, paymentMethod, notes, updateReason } = req.body;

    // Validation - FIXED TYPO HERE
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
    const sanitizedUpdateReason = sanitizeInput(updateReason);

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // Check if expense exists
    const existingExpense = await Expense.findById(req.params.id);
    if (!existingExpense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Authorization check for editing validated/rejected expenses
    if (existingExpense.status !== "pending") {
      // Only admins can edit validated or rejected expenses
      if (!isAdminUser(req.user)) {
        return res.status(403).json({ 
          error: "Only administrators can edit validated or rejected expenses" 
        });
      }
      
      // Require update reason for admin edits of validated/rejected expenses
      if (!sanitizedUpdateReason) {
        return res.status(400).json({ 
          error: "Update reason is required when editing validated or rejected expenses" 
        });
      }
    }

    // Check if the current user is the one who recorded it (for pending expenses)
    if (existingExpense.status === "pending" && 
        existingExpense.recordedBy !== req.user?.id && 
        !isAdminUser(req.user)) {
      return res.status(403).json({ 
        error: "You can only edit your own pending expenses" 
      });
    }

    // Prepare update data
    const updateData = {
      reason: sanitizedReason,
      recipientName: sanitizedRecipientName,
      recipientPhone: sanitizedRecipientPhone,
      amount: expenseAmount,
      paymentMethod: normalizedPM,
      updatedAt: new Date()
    };

    // Add notes with update history
    const updateNote = sanitizedUpdateReason ? 
      `[${new Date().toISOString()}] Updated by ${req.user?.id || "Unknown"}: ${sanitizedUpdateReason}` : 
      `[${new Date().toISOString()}] Updated by ${req.user?.id || "Unknown"}`;
    
    updateData.notes = existingExpense.notes ? 
      `${existingExpense.notes}\n${updateNote}` : 
      updateNote;

    // If admin is editing a validated expense, keep it validated but update validator info
    if (existingExpense.status === "validated" && isAdminUser(req.user)) {
      updateData.validatedBy = `${existingExpense.validatedBy || "Admin"} (Modified by: ${req.user?.id || "Admin"})`;
      updateData.validatedAt = new Date();
    }

    const updatedExpense = await Expense.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    // Send update notification
    sendExpenseUpdateNotification(updatedExpense, req.user?.id || "Unknown", sanitizedUpdateReason);

    res.json({
      ...updatedExpense.toObject(),
      message: "Expense updated successfully"
    });
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

/** ---------- ADMIN DELETE EXPENSE (FOR ANY STATUS) ---------- **/
router.delete("/:id/admin", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ 
        error: "Only administrators can delete expenses of any status" 
      });
    }

    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Store expense info for response before deletion
    const deletedExpenseInfo = {
      id: expense._id,
      expenseId: expense.expenseId,
      reason: expense.reason,
      amount: expense.amount,
      status: expense.status,
      recipientName: expense.recipientName
    };

    await Expense.findByIdAndDelete(req.params.id);

    // Send deletion notification
    sendExpenseDeletionNotification(deletedExpenseInfo, req.user?.id || "Admin");

    res.json({ 
      success: true,
      message: "Expense permanently deleted by administrator",
      deletedExpense: deletedExpenseInfo
    });
  } catch (error) {
    console.error("Error deleting expense (admin):", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid expense ID" });
    }
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

/** ---------- REGULAR DELETE EXPENSE (FOR PENDING ONLY) ---------- **/
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Prevent deleting validated or rejected expenses via regular route
    if (expense.status !== "pending") {
      return res.status(400).json({ 
        error: `Cannot delete ${expense.status} expense via this route. Only pending expenses can be deleted. Use /admin route for admin deletion.` 
      });
    }

    // Check if the current user is the one who recorded it
    if (expense.recordedBy !== req.user?.id && !isAdminUser(req.user)) {
      return res.status(403).json({ 
        error: "You can only delete your own pending expenses" 
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

/** ---------- GET EXPENSE HISTORY/AUDIT LOG ---------- **/
router.get("/:id/history", authMiddleware, async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Extract history from notes (assuming notes contain history)
    const notes = expense.notes || "";
    const historyLines = notes.split('\n').filter(line => line.trim());
    
    const history = historyLines.map(line => {
      const timestampMatch = line.match(/\[(.*?)\]/);
      const timestamp = timestampMatch ? timestampMatch[1] : new Date().toISOString();
      const action = line.replace(/\[.*?\]/, '').trim();
      
      return {
        timestamp,
        action,
        formattedDate: new Date(timestamp).toLocaleString('fr-FR')
      };
    });

    res.json({
      expenseId: expense.expenseId,
      currentStatus: expense.status,
      history
    });
  } catch (error) {
    console.error("Error fetching expense history:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid expense ID" });
    }
    res.status(500).json({ error: "Failed to fetch expense history" });
  }
});

/** ---------- TEST EMAIL ENDPOINT ---------- **/
router.get("/test/email", authMiddleware, async (req, res) => {
  try {
    // Create a test expense object
    const testExpense = {
      expenseId: "TEST-001",
      reason: "Test Expense - Achat fournitures bureau",
      recipientName: "Jean Test",
      recipientPhone: "+243 81 234 5678",
      amount: 150.50,
      paymentMethod: "cash",
      recordedBy: "test_user",
      notes: "Ceci est un test du système d'email",
      status: "pending",
      createdAt: new Date()
    };

    await sendExpenseNotification(testExpense);
    res.json({ 
      success: true,
      message: "✅ Test email sent to all admins! Check admin email inboxes." 
    });
  } catch (error) {
    console.error("Test email error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/** ---------- TEST UPDATE EMAIL ENDPOINT ---------- **/
router.get("/test/email-update", authMiddleware, async (req, res) => {
  try {
    // Create a test expense object
    const testExpense = {
      expenseId: "TEST-002",
      reason: "Test Expense Update - Réparation équipement",
      recipientName: "Marie Test",
      recipientPhone: "+243 82 345 6789",
      amount: 250.75,
      paymentMethod: "bank",
      recordedBy: "test_user",
      notes: "Ceci est un test du système d'email de mise à jour",
      status: "validated",
      validatedBy: "admin_user",
      validatedAt: new Date(),
      createdAt: new Date()
    };

    await sendExpenseUpdateNotification(testExpense, "admin_user", "Correction du montant");
    res.json({ 
      success: true,
      message: "✅ Test update email sent to all admins! Check admin email inboxes." 
    });
  } catch (error) {
    console.error("Test update email error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/** ---------- TEST DELETE EMAIL ENDPOINT ---------- **/
router.get("/test/email-delete", authMiddleware, async (req, res) => {
  try {
    // Create a test expense info object
    const testExpenseInfo = {
      id: "test_id_123",
      expenseId: "TEST-003",
      reason: "Test Expense Delete - Achat matériel",
      amount: 99.99,
      status: "validated",
      recipientName: "Pierre Test"
    };

    await sendExpenseDeletionNotification(testExpenseInfo, "admin_user");
    res.json({ 
      success: true,
      message: "✅ Test delete email sent to all admins! Check admin email inboxes." 
    });
  } catch (error) {
    console.error("Test delete email error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/** ---------- GET USER PERMISSIONS ENDPOINT ---------- **/
router.get("/permissions/me", authMiddleware, async (req, res) => {
  try {
    const user = req.user || {};
    const permissions = {
      isAdmin: isAdminUser(user),
      canValidate: user.canValidate || false,
      canEditAll: isAdminUser(user),
      canDeleteAll: isAdminUser(user),
      userId: user.id || "unknown",
      userName: user.name || user.email || "Unknown User"
    };
    
    res.json(permissions);
  } catch (error) {
    console.error("Error getting user permissions:", error);
    res.status(500).json({ error: "Failed to get user permissions" });
  }
});

module.exports = router;