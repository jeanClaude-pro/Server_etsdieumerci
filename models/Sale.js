const mongoose = require("mongoose");

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
  total: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
});

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
    enum: ["sale", "reservation", "expense"], // 🔹 Added "expense"
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
  // --- EXISTING RESERVATION FIELDS ---
  reservationDate: {
    type: String,
    default: null
  },
  reservationTime: {
    type: String,
    default: null
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
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  editedAt: {
    type: Date,
    default: null
  },
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

// Create index for better query performance
saleSchema.index({ createdAt: -1 });
saleSchema.index({ "customer.phone": 1 }); // Keep this explicit index
// REMOVED: saleSchema.index({ saleId: 1 }); ← DUPLICATE of unique: true on line 27
saleSchema.index({ salesPerson: 1 });
saleSchema.index({ type: 1 }); // Add index for type (sale/reservation/expense)
saleSchema.index({ status: 1 });

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