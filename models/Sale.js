const mongoose = require("mongoose");

const saleItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: true
  },
  name: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  total: {
    type: Number,
    required: true,
    min: 0
  },

});

const saleSchema = new mongoose.Schema({
  saleId: {
    type: String,
    required: true,
    unique: true
  },
  customer: {
    name: {
      type: String,
      required: true,
      trim: true
    },
    phone: {
      type: String,
      required: true,
      trim: true
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
    required: true,
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
    unique: true
  },
  // --- ADD SALES PERSON FIELD ---
  salesPerson: {
    type: String,
    required: true,
    trim: true,
    default: "Admin" // Default value for existing sales
  },
  // --- UPDATED STATUS ENUM ---
  status: {
    type: String,
    enum: ["completed", "refunded", "pending", "voided", "corrected"], // 🔹 Added "corrected"
    default: "completed"
  },
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
    ref: "Sale", // 🔹 Points to the original sale this one is correcting
    default: null
  },
  correctionSaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sale", // 🔹 Points to the sale that corrects this one
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
saleSchema.index({ "customer.phone": 1 });
saleSchema.index({ saleId: 1 });
saleSchema.index({ salesPerson: 1 }); // Add index for sales person

// Pre-save middleware to calculate item totals
saleSchema.pre("save", function(next) {
  // Calculate total for each item
  this.items.forEach(item => {
    item.total = item.price * item.quantity;
  });
  
  next();
});

module.exports = mongoose.model("Sale", saleSchema);