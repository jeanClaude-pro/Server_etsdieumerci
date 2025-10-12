const express = require("express");
const router = express.Router();
const ExchangeRate = require("../models/ExchangeRate");
const authMiddleware = require("../middleware/auth");

// GET current active exchange rate
router.get("/current", async (req, res) => {
  try {
    const currentRate = await ExchangeRate.getCurrentRate();
    
    if (!currentRate) {
      return res.status(404).json({ 
        error: "No active exchange rate found" 
      });
    }

    res.json({
      rate: currentRate.rate,
      effectiveFrom: currentRate.effectiveFrom,
      lastUpdated: currentRate.updatedAt,
      notes: currentRate.notes
    });
  } catch (error) {
    console.error("Error fetching current exchange rate:", error);
    res.status(500).json({ error: "Failed to fetch exchange rate" });
  }
});

// GET exchange rate history (Admin only)
router.get("/history", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can view rate history" 
      });
    }

    const { limit = 50 } = req.query;
    const history = await ExchangeRate.getRateHistory(parseInt(limit));

    res.json({
      history,
      total: history.length
    });
  } catch (error) {
    console.error("Error fetching exchange rate history:", error);
    res.status(500).json({ error: "Failed to fetch rate history" });
  }
});

// CREATE new exchange rate (Admin only)
router.post("/", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can set exchange rates" 
      });
    }

    const { rate, effectiveFrom, notes } = req.body;

    // Validate required fields
    if (!rate || rate <= 0) {
      return res.status(400).json({ 
        error: "Valid exchange rate is required" 
      });
    }

    // Deactivate all previous rates
    await ExchangeRate.updateMany(
      { isActive: true },
      { isActive: false }
    );

    // Create new active rate
    const newRate = new ExchangeRate({
      rate: parseFloat(rate),
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      createdBy: req.user.userId,
      notes: notes || ""
    });

    const savedRate = await newRate.save();

    res.status(201).json({
      message: "Exchange rate updated successfully",
      rate: savedRate
    });
  } catch (error) {
    console.error("Error creating exchange rate:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    res.status(500).json({ error: "Failed to update exchange rate" });
  }
});

// UPDATE exchange rate (Admin only)
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can update exchange rates" 
      });
    }

    const { id } = req.params;
    const { rate, notes } = req.body;

    const existingRate = await ExchangeRate.findById(id);
    if (!existingRate) {
      return res.status(404).json({ error: "Exchange rate not found" });
    }

    // Validate rate if provided
    if (rate && rate <= 0) {
      return res.status(400).json({ 
        error: "Valid exchange rate is required" 
      });
    }

    // Update rate
    if (rate) existingRate.rate = parseFloat(rate);
    if (notes !== undefined) existingRate.notes = notes;

    const updatedRate = await existingRate.save();

    res.json({
      message: "Exchange rate updated successfully",
      rate: updatedRate
    });
  } catch (error) {
    console.error("Error updating exchange rate:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid exchange rate ID" });
    }
    
    res.status(500).json({ error: "Failed to update exchange rate" });
  }
});

// DEACTIVATE exchange rate (Admin only)
router.patch("/:id/deactivate", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can deactivate exchange rates" 
      });
    }

    const { id } = req.params;

    const rate = await ExchangeRate.findById(id);
    if (!rate) {
      return res.status(404).json({ error: "Exchange rate not found" });
    }

    if (!rate.isActive) {
      return res.status(400).json({ error: "Exchange rate is already inactive" });
    }

    await rate.deactivate();

    res.json({
      message: "Exchange rate deactivated successfully",
      rate
    });
  } catch (error) {
    console.error("Error deactivating exchange rate:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid exchange rate ID" });
    }
    
    res.status(500).json({ error: "Failed to deactivate exchange rate" });
  }
});

module.exports = router;