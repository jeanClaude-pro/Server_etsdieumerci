// routes/sales.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");

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
async function updateCustomerData(customerData, saleTotal) {
  const { name, phone, email } = customerData;
  const now = new Date();
  try {
    let customer = await Customer.findOne({ phone });
    if (customer) {
      customer.totalPurchases += 1;
      customer.totalSpent += parseFloat(saleTotal);
      customer.lastPurchaseDate = now;
      if (name && customer.name !== name) customer.name = name;
      if (email && customer.email !== email) customer.email = email;
    } else {
      customer = new Customer({
        name,
        phone,
        email: email || "",
        totalPurchases: 1,
        totalSpent: parseFloat(saleTotal),
        firstPurchaseDate: now,
        lastPurchaseDate: now,
      });
    }
    await customer.save();
    
    // RETURN THE CUSTOMER ID
    return customer._id;
  } catch (error) {
    console.error("Error updating customer data:", error);
    return null;
  }
}

// Helper function to recalculate customer statistics (FIXED)
async function recalculateCustomerStats(customerId) {
  try {
    // FIX: Only include completed sales (exclude voided and corrected)
    const sales = await Sale.find({ 
      customerId: customerId,
      status: { $in: ["completed", "pending", undefined, null] } // Only valid sales
    }).sort({ createdAt: 1 });
    
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
      });
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
    });
  } catch (error) {
    console.error("Error recalculating customer stats:", error);
    throw error;
  }
}

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

    const sales = await Sale.find({
      createdAt: { $gte: startOfDay, $lte: endOfDay },
      // ✅ FIXED: SAME FILTER FOR CONSISTENCY
      status: { $in: ["completed", "pending"] },
      type: { $in: ["sale", "reservation"] }
    }).sort({ createdAt: -1 });

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
    if (!customer || !customer.name || !customer.phone) {
      return res
        .status(400)
        .json({ error: "Customer name and phone are required" });
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

      const lineTotal = Number(price) * Number(quantity);
      subtotal += lineTotal;

      enrichedItems.push({
        productId: new mongoose.Types.ObjectId(productId),
        name: name || product.name,
        quantity: Number(quantity),
        price: Number(price),
        total: lineTotal,
      });
    }

    const total = subtotal;
    const saleId = `SALE-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    const saleNumber = `SN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // FIX: Get customer ID from updateCustomerData and set customerId
    const customerId = await updateCustomerData(customer, total);

    // UPDATED: Include type and reservation fields WITH CORRECT STATUS
    const saleData = {
      saleId,
      saleNumber,
      customer: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email || "",
      },
      customerId: customerId,
      items: enrichedItems,
      subtotal,
      total,
      paymentMethod: normalizedPM,
      status: type === "reservation" ? "pending" : "completed", // ✅ FIXED: Reservations as pending (money received)
      salesPerson: salesPerson || "Admin",
      type: type || "sale",
      reservationDate: reservationDate || null,
      reservationTime: reservationTime || null,
      notes: notes || ""
    };

    for (const it of enrichedItems) {
      const updated = await Product.findOneAndUpdate(
        { _id: it.productId, stock: { $gte: it.quantity } },
        { $inc: { stock: -it.quantity } },
        { new: true }
      );
      if (!updated) {
        return res.status(409).json({
          error: "Stock changed for an item. Please refresh and try again.",
        });
      }
    }

    const sale = new Sale(saleData);
    const savedSale = await sale.save();

    return res.status(201).json(savedSale);
  } catch (error) {
    console.error("Error creating sale/expense:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    return res.status(500).json({ error: "Failed to create sale/expense" });
  }
});

/** ---------- LIST SALES ---------- **/
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      customerPhone, 
      dateFrom, 
      dateTo,
      status,
      type // ADD TYPE FILTER
    } = req.query;
    
    const p = parseInt(page, 10);
    const l = parseInt(limit, 10);
    const filter = {};

    if (customerPhone) filter["customer.phone"] = customerPhone;

    if (status) {
      filter.status = status;
    } else {
      // ✅ FIXED: INCLUDE PENDING RESERVATIONS (money received) AND COMPLETED SALES
      filter.status = { $in: ["completed", "pending", "expense"] };
    }

    // ADD TYPE FILTERING
    if (type) {
      filter.type = type;
    } else {
      // ✅ FIXED: INCLUDE BOTH SALES AND RESERVATIONS BY DEFAULT
      filter.type = { $in: ["sale", "reservation", "expense"] };
    }

    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    const sales = await Sale.find(filter)
      .skip((p - 1) * l)
      .limit(l)
      .sort({ createdAt: -1 });

    const totalSales = await Sale.countDocuments(filter);

    res.json({
      sales,
      pagination: { total: totalSales, page: p, limit: l },
    });
  } catch (error) {
    console.error("Error fetching sales:", error);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

/** ---------- GET EXPENSES ---------- **/
router.get("/expenses/all", authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    
    const filter = { type: "expense" };
    
    if (status) {
      filter.status = status;
    }

    const expenses = await Sale.find(filter)
      .sort({ createdAt: -1 });

    res.json(expenses);
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

/** ---------- GET RESERVATIONS ---------- **/
router.get("/reservations/all", authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    
    const filter = { type: "reservation" };
    
    if (status) {
      filter.status = status;
    }

    const reservations = await Sale.find(filter)
      .sort({ createdAt: -1 });

    res.json(reservations);
  } catch (error) {
    console.error("Error fetching reservations:", error);
    res.status(500).json({ error: "Failed to fetch reservations" });
  }
});

/** ---------- GET BY ID (after other specific routes) ---------- **/
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const saleId = req.params.id;
    
    const sale = await Sale.findById(saleId);
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // Check if there are duplicate sales
    const potentialDuplicates = await Sale.find({
      saleId: sale.saleId,
      _id: { $ne: saleId } // Exclude current sale
    });

    res.json({
      sale: sale,
      potentialDuplicates: potentialDuplicates,
      duplicateCount: potentialDuplicates.length,
      message: potentialDuplicates.length > 0 ? 
        `Found ${potentialDuplicates.length} potential duplicates` : 
        "No duplicates found"
    });

  } catch (error) {
    console.error("Error debugging sale:", error);
    res.status(500).json({ error: "Failed to debug sale" });
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
      notes 
    } = req.body;

    // Find the original sale
    const originalSale = await Sale.findById(id);
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
          editedBy: req.user.userId,
          editedAt: new Date(),
          $push: {
            editHistory: {
              editedBy: req.user.userId,
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

      const lineTotal = Number(price) * Number(quantity);
      subtotal += lineTotal;

      enrichedItems.push({
        productId: new mongoose.Types.ObjectId(productId),
        name: name || product.name,
        quantity: Number(quantity),
        price: Number(price),
        total: lineTotal,
      });
    }

    const total = subtotal;

    // Calculate stock adjustments
    const stockAdjustments = [];
    
    for (const newItem of enrichedItems) {
      const oldItem = originalSale.items.find(item => 
        item.productId.toString() === newItem.productId.toString()
      );

      if (oldItem) {
        // Item exists in both old and new - calculate quantity difference
        const quantityDiff = newItem.quantity - oldItem.quantity;
        if (quantityDiff !== 0) {
          stockAdjustments.push({
            productId: newItem.productId,
            adjustment: -quantityDiff // Negative because we're reversing old sale and applying new
          });
        }
      } else {
        // New item added - need to reduce stock
        stockAdjustments.push({
          productId: newItem.productId,
          adjustment: -newItem.quantity
        });
      }
    }

    // Handle removed items - return stock
    for (const oldItem of originalSale.items) {
      const itemStillExists = enrichedItems.find(item => 
        item.productId.toString() === oldItem.productId.toString()
      );
      
      if (!itemStillExists) {
        stockAdjustments.push({
          productId: oldItem.productId,
          adjustment: oldItem.quantity // Positive because we're returning stock
        });
      }
    }

    // Apply stock adjustments
    for (const adjustment of stockAdjustments) {
      const updatedProduct = await Product.findByIdAndUpdate(
        adjustment.productId,
        { $inc: { stock: adjustment.adjustment } },
        { new: true }
      );
      
      if (!updatedProduct || updatedProduct.stock < 0) {
        // Rollback previous adjustments if any fail
        for (const rollbackAdj of stockAdjustments) {
          await Product.findByIdAndUpdate(
            rollbackAdj.productId,
            { $inc: { stock: -rollbackAdj.adjustment } }
          );
        }
        return res.status(400).json({ 
          error: `Insufficient stock for product update` 
        });
      }
    }

    // Track what changed
    if (JSON.stringify(originalSale.customer) !== JSON.stringify(customer)) {
      changes.set('customer', { from: originalSale.customer, to: customer });
    }
    
    if (originalSale.total !== total) {
      changes.set('total', { from: originalSale.total, to: total });
    }
    
    if (originalSale.paymentMethod !== normalizedPM) {
      changes.set('paymentMethod', { from: originalSale.paymentMethod, to: normalizedPM });
    }

    // Track type changes
    if (originalSale.type !== type) {
      changes.set('type', { from: originalSale.type, to: type });
    }

    // Update the sale
    const updatedSale = await Sale.findByIdAndUpdate(
      id,
      {
        customer,
        items: enrichedItems,
        subtotal,
        total,
        paymentMethod: normalizedPM,
        type: type || originalSale.type,
        reservationDate: reservationDate || originalSale.reservationDate,
        reservationTime: reservationTime || originalSale.reservationTime,
        notes: notes || originalSale.notes,
        editedBy: req.user.userId,
        editedAt: new Date(),
        $push: {
          editHistory: {
            editedBy: req.user.userId,
            editedAt: new Date(),
            changes: Object.fromEntries(changes),
            reason: reason || "Sale correction"
          }
        }
      },
      { new: true, runValidators: true }
    );

    // FIX: Use recalculateCustomerStats instead of updateCustomerData
    if (changes.has('customer') || changes.has('total')) {
      await recalculateCustomerStats(originalSale.customerId);
    }

    res.json(updatedSale);
  } catch (error) {
    console.error("Error editing sale:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    res.status(500).json({ error: "Failed to edit sale" });
  }
});

/** ---------- MARK RESERVATION AS COMPLETED ---------- **/
router.patch("/:id/complete", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { completedBy } = req.body;

    const sale = await Sale.findById(id);
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

    const updatedSale = await Sale.findByIdAndUpdate(
      id,
      {
        status: "completed",
        completedAt: new Date(),
        completedBy: completedBy || req.user.userId,
      },
      { new: true }
    );

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

    const sale = await Sale.findById(id);
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

    const updatedSale = await Sale.findByIdAndUpdate(
      id,
      {
        status: "pending",
        completedAt: null,
        completedBy: null,
      },
      { new: true }
    );

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

    const sale = await Sale.findById(id);
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    if (sale.status === "voided") {
      return res.status(400).json({ error: "Sale is already voided" });
    }

    // Return stock to inventory (only for sales and reservations with items)
    // ✅ FIXED: Check for reservation type as well
    if ((sale.type === "sale" || sale.type === "reservation") && sale.items && sale.items.length > 0) {
      for (const item of sale.items) {
        await Product.findByIdAndUpdate(
          item.productId,
          { $inc: { stock: item.quantity } }
        );
      }
    }

    const voidedSale = await Sale.findByIdAndUpdate(
      id,
      {
        status: "voided",
        voidedBy: req.user.userId,
        voidedAt: new Date(),
        $push: {
          editHistory: {
            editedBy: req.user.userId,
            editedAt: new Date(),
            changes: { status: { from: sale.status, to: "voided" } },
            reason: reason || "Sale voided"
          }
        }
      },
      { new: true }
    );

    // FIX: Recalculate customer stats after voiding (only for sales and reservations)
    if (sale.customerId && (sale.type === "sale" || sale.type === "reservation")) {
      await recalculateCustomerStats(sale.customerId);
    }

    res.json(voidedSale);
  } catch (error) {
    console.error("Error voiding sale:", error);
    res.status(500).json({ error: "Failed to void sale" });
  }
});

/** ---------- DELETE SALE ---------- **/
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // 🔹 NEW: RESTRICTION - Only admin can delete reservations
    if (sale.type === "reservation" && req.user.role !== "admin") {
      return res.status(403).json({ 
        error: "Only admin can delete reservations" 
      });
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
            { new: true }
          );
          
          if (updatedProduct) {
            console.log(`✅ Returned ${item.quantity} units of "${item.name}", new stock: ${updatedProduct.stock}`);
          } else {
            console.warn(`❌ Product not found for ID: ${item.productId}`);
          }
        } catch (productError) {
          console.error(`Error returning stock for product ${item.productId}:`, productError);
        }
      }
    }

    // Delete the sale record
    await Sale.findByIdAndDelete(req.params.id);

    // Update customer statistics (only for sales and reservations, not expenses)
    if (customerId && (sale.type === "sale" || sale.type === "reservation")) {
      await recalculateCustomerStats(customerId);
    }

    res.json({ 
      message: "Sale deleted successfully",
      stockReturned: (sale.type === "reservation" || sale.type === "sale") && sale.items && sale.items.length > 0
    });
  } catch (error) {
    console.error("Error deleting sale:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

module.exports = router;