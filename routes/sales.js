// routes/sales.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Customer = require("../models/Customer");
const Product = require("../models/product");
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
      sale.status !== "voided" && sale.status !== "corrected"
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
          status: "completed",
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
      status: "completed",
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

/** ---------- CREATE SALE ---------- **/
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { customer, items, paymentMethod, salesPerson } = req.body;

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

    const normalizedPM = normalizePaymentMethod(paymentMethod);

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

    const saleData = {
      saleId,
      saleNumber,
      customer: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email || "",
      },
      customerId: customerId, // ← ADDED customerId
      items: enrichedItems,
      subtotal,
      total,
      paymentMethod: normalizedPM,
      status: "completed",
      salesPerson: salesPerson || "Admin"
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
    console.error("Error creating sale:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    return res.status(500).json({ error: "Failed to create sale" });
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
      status
    } = req.query;
    
    const p = parseInt(page, 10);
    const l = parseInt(limit, 10);
    const filter = {};

    if (customerPhone) filter["customer.phone"] = customerPhone;

    if (status) {
      filter.status = status;
    } else {
      filter.status = "completed";
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

/** ---------- EDIT SALE (Admin Only) ---------- **/
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can edit sales" });
    }

    const { id } = req.params;
    const { customer, items, paymentMethod, reason } = req.body;

    // Find the original sale
    const originalSale = await Sale.findById(id);
    if (!originalSale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // Prevent editing voided or corrected sales
    if (originalSale.status === "voided" || originalSale.status === "corrected") {
      return res.status(400).json({ 
        error: "Cannot edit a voided or corrected sale" 
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);

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

    // Update the sale
    const updatedSale = await Sale.findByIdAndUpdate(
      id,
      {
        customer,
        items: enrichedItems,
        subtotal,
        total,
        paymentMethod: normalizedPM,
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

    // Return stock to inventory
    for (const item of sale.items) {
      await Product.findByIdAndUpdate(
        item.productId,
        { $inc: { stock: item.quantity } }
      );
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

    // FIX: Recalculate customer stats after voiding
    if (sale.customerId) {
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

    const customerId = sale.customerId;
    
    await Sale.findByIdAndDelete(req.params.id);

    // Update customer statistics
    if (customerId) {
      await recalculateCustomerStats(customerId);
    }

    res.json({ message: "Sale deleted successfully" });
  } catch (error) {
    console.error("Error deleting sale:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

module.exports = router;