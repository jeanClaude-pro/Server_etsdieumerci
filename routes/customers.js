const express = require("express");
const router = express.Router();
const Customer = require("../models/Customer");
const Sale = require("../models/Sale"); // Make sure to import Sale model
const authMiddleware = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/security");

router.use(authMiddleware);
router.param("id", validateObjectIdParam("customer ID"));

// GET /api/customers - Get all customers with optional filtering
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    
    // Build filter object
    const filter = {};
    
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } }
      ];
    }
    
    const customers = await Customer.find(filter)
      .sort({ totalSpent: -1, lastPurchaseDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Customer.countDocuments(filter);
    
    res.json({
      customers,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// GET /api/customers/:id - Get a single customer by ID
router.get("/:id", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error fetching customer:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// GET /api/customers/phone/:phone - Get customer by phone number
router.get("/phone/:phone", async (req, res) => {
  try {
    const customer = await Customer.findOne({ phone: req.params.phone });
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error fetching customer by phone:", error);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// POST /api/customers/:id/recalculate - Recalculate customer statistics
// POST /api/customers/:id/recalculate - Recalculate customer statistics
router.post("/:id/recalculate", async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Administrator access required" });
    const customerId = req.params.id;
    
    // FIX: Only get COMPLETED sales (exclude voided and corrected sales)
    const sales = await Sale.find({ 
      customerId: customerId,
      status: { $in: ["completed", "pending", undefined] } // Include completed, pending, or sales without status
    }).sort({ createdAt: 1 });
    
    // FIX: Also filter out voided sales manually for safety
    const validSales = sales.filter(sale => 
      sale.status !== "voided" && sale.status !== "corrected"
    );
    
    if (validSales.length === 0) {
      // If no valid sales, reset the customer stats
      const updatedCustomer = await Customer.findByIdAndUpdate(
        customerId,
        {
          totalPurchases: 0,
          totalSpent: 0,
          firstPurchaseDate: null,
          lastPurchaseDate: null,
        },
        { new: true }
      );
      
      return res.json(updatedCustomer);
    }
    
    // Recalculate totals from VALID sales only
    const totalPurchases = validSales.length;
    const totalSpent = validSales.reduce((sum, sale) => sum + sale.total, 0);
    const firstPurchaseDate = validSales[0].createdAt;
    const lastPurchaseDate = validSales[validSales.length - 1].createdAt;

    // Update customer
    const updatedCustomer = await Customer.findByIdAndUpdate(
      customerId,
      {
        totalPurchases,
        totalSpent,
        firstPurchaseDate,
        lastPurchaseDate,
      },
      { new: true }
    );

    if (!updatedCustomer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json(updatedCustomer);
  } catch (error) {
    console.error("Error recalculating customer stats:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    res.status(500).json({ error: "Failed to recalculate customer statistics" });
  }
});

// PUT /api/customers/:id - Update a customer
router.put("/:id", async (req, res) => {
  try {
    const { name, email } = req.body;
    
    const updateData = {};
    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName || cleanName.length > 120) return res.status(400).json({ error: "Invalid name" });
      updateData.name = cleanName;
    }
    if (email !== undefined) {
      const cleanEmail = String(email).trim().toLowerCase();
      if (cleanEmail.length > 254 || (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) return res.status(400).json({ error: "Invalid email" });
      updateData.email = cleanEmail;
    }
    
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error updating customer:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    res.status(500).json({ error: "Failed to update customer" });
  }
});

// GET /api/customers/stats/top - Get top customers by spending
router.get("/stats/top", async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    
    const topCustomers = await Customer.find()
      .sort({ totalSpent: -1 })
      .limit(limit);
    
    res.json(topCustomers);
  } catch (error) {
    console.error("Error fetching top customers:", error);
    res.status(500).json({ error: "Failed to fetch top customers" });
  }
});

module.exports = router;
