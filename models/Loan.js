const mongoose = require("mongoose");

const loanSchema = new mongoose.Schema({
  creditorId: { type: mongoose.Schema.Types.ObjectId, ref: "Creditor", required: true, index: true },
  enteredAmount: { type: Number, required: true, min: 0 },
  enteredCurrency: { type: String, enum: ["USD", "FC"], required: true },
  amountUSD: { type: Number, required: true, min: 0 },
  amountFC: { type: Number, required: true, min: 0 },
  exchangeRate: { type: Number, required: true, min: 0 },
  borrowedAt: { type: Date, required: true, default: Date.now, index: true },
  reference: { type: String, trim: true, default: "" },
  note: { type: String, trim: true, default: "" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

loanSchema.index({ creditorId: 1, borrowedAt: -1 });
module.exports = mongoose.model("Loan", loanSchema);
