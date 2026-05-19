const express = require("express");
const router = express.Router();
const ShopSettings = require("../models/ShopSettings");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

async function getOrCreateSettings() {
  let settings = await ShopSettings.findOne();
  if (!settings) {
    settings = await ShopSettings.create({});
  }
  return settings;
}

// GET receipt settings — all authenticated users (needed to populate receipts)
router.get("/receipt", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// PUT receipt settings — admin only
router.put("/receipt", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Accès refusé. Réservé aux administrateurs." });
    }
    const { shopName, shopAddress, shopNumber, shopRegistration, receiptFooter } =
      req.body;

    const settings = await getOrCreateSettings();
    if (shopName !== undefined) settings.shopName = shopName;
    if (shopAddress !== undefined) settings.shopAddress = shopAddress;
    if (shopNumber !== undefined) settings.shopNumber = shopNumber;
    if (shopRegistration !== undefined) settings.shopRegistration = shopRegistration;
    if (receiptFooter !== undefined) settings.receiptFooter = receiptFooter;

    await settings.save();
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
