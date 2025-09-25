const express = require("express");
const authMiddleware = require("../middleware/auth");
const router = express.Router();

router.use(authMiddleware);

router.get("/", async (req, res) => {
  res.json({ message: "Test route is working", user: req.user });
});

module.exports = router;