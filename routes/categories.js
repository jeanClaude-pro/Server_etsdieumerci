const express = require("express");
const router = express.Router();

const isAdmin = require("../middleware/isAdmin");
const authMiddleware = require("../middleware/auth");

const Category = require("../models/Category");

router.use(authMiddleware);

// Create a new category
router.post("/", isAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    if (!name || name.length > 100 || description.length > 500) {
      return res.status(400).json({ message: "Invalid category" });
    }
    const newCategories = await Category.create({ name, description });
    res.status(201).json(newCategories);
  } catch (error) {
    console.error("Error creating category:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get all categories
router.get("/", async (req, res) => {
  try {
    const categories = await Category.find();
    res.status(200).json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
