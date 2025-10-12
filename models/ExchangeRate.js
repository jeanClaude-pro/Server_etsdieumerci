const mongoose = require("mongoose");

const exchangeRateSchema = new mongoose.Schema({
  rate: {
    type: Number,
    required: true,
    min: 0.0001, // Very small positive number
    description: "FC to USD rate (e.g., 2500 means 1 USD = 2500 FC)"
  },
  effectiveFrom: {
    type: Date,
    default: Date.now,
    description: "When this rate becomes active"
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  isActive: {
    type: Boolean,
    default: true,
    description: "Only one active rate at a time"
  },
  notes: {
    type: String,
    maxlength: 500,
    description: "Optional notes about rate change"
  }
}, {
  timestamps: true
});

// Index for efficient queries
exchangeRateSchema.index({ isActive: 1 });
exchangeRateSchema.index({ effectiveFrom: -1 });

// Static method to get current active rate
exchangeRateSchema.statics.getCurrentRate = function() {
  return this.findOne({ isActive: true }).sort({ effectiveFrom: -1 });
};

// Static method to get rate history
exchangeRateSchema.statics.getRateHistory = function(limit = 50) {
  return this.find().sort({ effectiveFrom: -1 }).limit(limit).populate('createdBy', 'username email');
};

// Instance method to deactivate this rate
exchangeRateSchema.methods.deactivate = function() {
  this.isActive = false;
  return this.save();
};

module.exports = mongoose.model("ExchangeRate", exchangeRateSchema);