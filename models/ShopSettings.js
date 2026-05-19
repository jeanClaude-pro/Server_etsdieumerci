const mongoose = require("mongoose");

const shopSettingsSchema = new mongoose.Schema(
  {
    shopName: { type: String, default: "ETS. DIEU MERCI" },
    shopAddress: {
      type: String,
      default: "Av Manono Coin Munama N°39, C. Kenya, Lubumbashi",
    },
    shopNumber: {
      type: String,
      default: "+243 977 771 421 / +243 853 549 102",
    },
    shopRegistration: { type: String, default: "RCCM: 14-A-017885" },
    receiptFooter: {
      type: String,
      default: "Merci pour votre confiance ! À bientôt.",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShopSettings", shopSettingsSchema);
