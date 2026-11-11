const mongoose = require("mongoose");

// Sessions that were ended on the server (logout). A token listed here is
// refused even though its signature and expiry are still valid. MongoDB drops
// each entry by itself once the token would have expired anyway.
const revokedTokenSchema = new mongoose.Schema(
  {
    jti: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, enum: ["logout"], default: "logout" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RevokedToken", revokedTokenSchema);
