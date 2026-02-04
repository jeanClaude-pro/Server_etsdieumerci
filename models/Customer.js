const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    default: ""
  },
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  firstPurchaseDate: {
    type: Date
  },
  lastPurchaseDate: {
    type: Date
  }
}, {
  timestamps: true
});

// Create index for better query performance
// NOTE: Removed duplicate index for phone (already created by unique: true)
customerSchema.index({ name: "text" });
customerSchema.index({ totalSpent: -1 });

module.exports = mongoose.model("Customer", customerSchema);