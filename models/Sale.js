const mongoose = require("mongoose");

const exitVerificationSchema = new mongoose.Schema(
  {
    verified: { type: Boolean, default: false },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false
    },
    verifiedAt: { type: Date, default: null }
  },
  { _id: false }
);

// Records that payment approval and/or exit control were completed by an
// admin's manual override (scanner unavailable, historical data correction)
// rather than by an actual scan, so the two paths stay distinguishable for audit.
const manualOverrideSchema = new mongoose.Schema(
  {
    overridden: { type: Boolean, default: false },
    overriddenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false
    },
    overriddenAt: { type: Date, default: null },
    reason: { type: String, default: null }
  },
  { _id: false }
);

const receiptVerificationSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, default: null, select: false },
    tokenCiphertext: { type: String, default: null, select: false },
    version: { type: Number, min: 1, default: 1 },
    paymentStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending"
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false
    },
    approvedAt: { type: Date, default: null },
    invalidatedAt: { type: Date, default: null },
    invalidationReason: { type: String, default: null },
    exitVerification: {
      type: exitVerificationSchema,
      default: () => ({ verified: false })
    },
    manualOverride: {
      type: manualOverrideSchema,
      default: () => ({ overridden: false })
    },
    // Hashes are safe to retain and let the API distinguish obsolete receipts
    // without retaining any raw QR token.
    invalidatedTokenHashes: { type: [String], default: [], select: false }
  },
  { _id: false }
);

const saleItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: false // Made optional for expenses
  },
  name: {
    type: String,
    required: false // Made optional for expenses
  },
  quantity: {
    type: Number,
    required: false, // Made optional for expenses
    min: 1
  },
  price: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  enteredPrice: {
    type: Number,
    required: false,
    min: 0
  },
  enteredCurrency: {
    type: String,
    enum: ["USD", "FC"],
    required: false
  },
  priceUSD: {
    type: Number,
    required: false,
    min: 0
  },
  priceFC: {
    type: Number,
    required: false,
    min: 0
  },
  exchangeRate: {
    type: Number,
    required: false,
    min: 0
  },
  total: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
});

const saleEditApprovalSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      required: true,
    },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requestedByName: { type: String, required: true },
    requestedAt: { type: Date, required: true, default: Date.now },
    reason: { type: String, required: true },
    // Immutable audit snapshots. Mixed is intentional: these are historical
    // representations, not a second authoritative Sale document.
    original: { type: mongoose.Schema.Types.Mixed, required: true },
    proposed: { type: mongoose.Schema.Types.Mixed, required: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedByName: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },
  },
  { _id: true }
);

const saleSchema = new mongoose.Schema({
  saleId: {
    type: String,
    required: true,
    unique: true  // ← THIS creates an index automatically
  },
  customer: {
    name: {
      type: String,
      required: false, // Made optional for expenses
      trim: true
    },
    phone: {
      type: String,
      required: false, // Made optional for expenses
      trim: true
      // REMOVED: index: true  ← Fixed: removed duplicate index
    },
    email: {
      type: String,
      trim: true,
      default: ""
    }
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: false
  },
  // Walk-in customer: sale made without collecting customer details
  isWalkIn: {
    type: Boolean,
    default: false
  },
  items: [saleItemSchema],
  subtotal: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  total: {
    type: Number,
    required: true,
    min: 0
  },
  // Snapshot used for this transaction; historical sales never use today's rate.
  exchangeRate: {
    type: Number,
    required: false,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "transfer", "other"],
    default: "cash"
  },
  saleNumber: {
    type: String,
    unique: true  // ← THIS also creates an index automatically
  },
  salesPerson: {
    type: String,
    required: true,
    trim: true,
    default: "Admin"
  },
  // --- UPDATED STATUS ENUM ---
  status: {
    type: String,
    enum: ["completed", "refunded", "pending", "voided", "corrected", "expense"], // 🔹 Added "expense"
    default: "completed"
  },
  // --- UPDATED TYPE ENUM ---
  type: {
    type: String,
    enum: ["sale", "expense"],
    default: "sale"
  },
  // --- NEW EXPENSE FIELDS ---
  reason: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  recipientName: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  recipientPhone: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  notes: {
    type: String,
    default: ""
  },
  completedAt: {
    type: Date,
    default: null
  },
  completedBy: {
    type: String,
    default: null
  },
  // --- EXISTING FIELDS ---
  voidedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  voidedAt: {
    type: Date,
    default: null
  },
  // --- NEW FIELDS FOR SALE CORRECTION ---
  originalSaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sale",
    default: null
  },
  correctionSaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sale",
    default: null
  },
  editedBy: {
    type: String,
    default: null
  },
  editedAt: {
    type: Date,
    default: null
  },
  editHistory: [{
    editedBy: {
      type: String,
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
  saleEditApproval: {
    type: saleEditApprovalSchema,
    default: undefined
  },
  saleEditApprovalHistory: {
    type: [saleEditApprovalSchema],
    default: []
  },
  receiptVerification: {
    type: receiptVerificationSchema,
    default: undefined
  },
}, {
  timestamps: true
});

// Create index for better query performance
saleSchema.index({ createdAt: -1 });
saleSchema.index({ "customer.phone": 1 }); // Keep this explicit index
// REMOVED: saleSchema.index({ saleId: 1 }); ← DUPLICATE of unique: true on line 27
saleSchema.index({ salesPerson: 1 });
saleSchema.index({ status: 1 });
saleSchema.index({ type: 1, status: 1, createdAt: -1 });
saleSchema.index({ paymentMethod: 1, createdAt: -1 });
saleSchema.index({ customerId: 1, createdAt: -1 });
saleSchema.index({ "receiptVerification.tokenHash": 1 }, { sparse: true, unique: true });
saleSchema.index({ "receiptVerification.invalidatedTokenHashes": 1 }, { sparse: true });
saleSchema.index({ "saleEditApproval.status": 1, "saleEditApproval.requestedAt": -1 });

// Pre-save middleware to calculate item totals (only for sales with items)
saleSchema.pre("save", function(next) {
  // Only calculate totals if this is a sale with items
  if (this.type === "sale" && this.items && this.items.length > 0) {
    this.items.forEach(item => {
      if (item.price && item.quantity) {
        item.total = item.price * item.quantity;
      }
    });
  }
  
  next();
});

module.exports = mongoose.model("Sale", saleSchema);
