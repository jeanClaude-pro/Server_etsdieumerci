const express = require("express");
const router = express.Router();

const isAdmin = require("../middleware/isAdmin");

const Category = require("../models/Category");

//router.use(isAdmin);

// Create a new category
router.post("/", async (req, res) => {
  try {
    const newCategories = await Category.create(req.body);
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
