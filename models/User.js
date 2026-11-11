const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["admin", "manager", "inventory_manager", "cashier_supervisor", "staff"],
      default: "staff",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    actionPermissions: {
      type: [String],
      default: [],
    },
    // Raised to end every open session of this user at once (role change,
    // deactivation, "log out everywhere"). Tokens carry the value they were
    // issued with and are refused once it no longer matches.
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
