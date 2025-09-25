const express = require("express");
const router = express.Router();

const User = require("../models/User");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

router.get("/me", async (req, res) => {
  const userId = req.user._id;
  try {
    const user = await User.findById(userId).select("_id username email role");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;