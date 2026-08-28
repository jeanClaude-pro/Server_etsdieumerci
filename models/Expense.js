const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema({
  expenseId: {
    type: String,
    required: true,
    unique: true
  },
  reason: {
    type: String,
    required: true,
    trim: true
  },
  recipientName: {
    type: String,
    required: true,
    trim: true
  },
  recipientPhone: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  enteredAmount: { type: Number, min: 0 },
  enteredCurrency: { type: String, enum: ["USD", "FC"], default: "USD" },
  amountUSD: { type: Number, min: 0 },
  amountFC: { type: Number, min: 0 },
  exchangeRate: { type: Number, min: 0 },
  paymentMethod: {
    type: String,
    enum: ["cash", "mpesa", "bank", "card", "other"],
    default: "cash"
  },
  status: {
    type: String,
    enum: ["pending", "validated", "rejected"],
    default: "pending"
  },
  recordedBy: {
    type: String,
    required: true,
    trim: true
  },
  validatedBy: {
    type: String,
    default: null
  },
  validatedAt: {
    type: Date,
    default: null
  },
  notes: {
    type: String,
    default: ""
  },
  expenseType: { type: String, enum: ["normal", "repayment"], default: "normal", index: true },
  creditorId: { type: mongoose.Schema.Types.ObjectId, ref: "Creditor", default: null },
  creditorSnapshot: {
    name: { type: String, trim: true },
    type: { type: String, enum: ["person", "bank", "company"] }
  },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  repaymentAppliedAt: { type: Date, default: null },
  repaymentAppliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, {
  timestamps: true
});

// Create index for better query performance
// NOTE: Removed duplicate index for expenseId (already created by unique: true)
expenseSchema.index({ createdAt: -1 });
expenseSchema.index({ recordedBy: 1 });
expenseSchema.index({ status: 1, createdAt: -1 });
expenseSchema.index({ paymentMethod: 1, createdAt: -1 });
expenseSchema.index({ creditorId: 1, status: 1, repaymentAppliedAt: -1 });

module.exports = mongoose.model("Expense", expenseSchema);
