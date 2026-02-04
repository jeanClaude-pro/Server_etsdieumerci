const mongoose = require("mongoose");

const entrySchema = new mongoose.Schema({
  entryId: {
    type: String,
    required: true,
    unique: true
  },
  // Core entry data
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  source: {
    type: String,
    required: true,
    trim: true
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "transfer", "other"],
    default: "cash"
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: false,
    trim: true,
    default: ""
  },
  // Who the money was received from (like your customer object)
  receivedFrom: {
    name: {
      type: String,
      required: false,
      trim: true
    },
    phone: {
      type: String,
      required: false,
      trim: true
    },
    email: {
      type: String,
      trim: true,
      default: ""
    }
  },
  // Status and audit (following your Sale pattern)
  status: {
    type: String,
    enum: ["active", "deleted"],
    default: "active"
  },
  // Creator info
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  // Editor info
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  // Delete info (admin only)
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  deletedAt: {
    type: Date,
    default: null
  },
  // Version history (exactly like your Sale model)
  editHistory: [{
    editedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    editedAt: {
      type: Date,
      default: Date.now
    },
    changes: {
      type: Map,
      of: mongoose.Schema.Types.Mixed
    },
    reason: String
  }],
}, {
  timestamps: true
});

// Indexes for performance (like your Sale model)
// NOTE: Removed duplicate index for entryId (already created by unique: true)
entrySchema.index({ createdAt: -1 });
entrySchema.index({ status: 1 });
entrySchema.index({ category: 1 });
entrySchema.index({ "receivedFrom.phone": 1 });
entrySchema.index({ source: 1 });

module.exports = mongoose.model("Entry", entrySchema);