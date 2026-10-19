const mongoose = require("mongoose");

// Append-only security journal. One document per user action reaching the API
// (every mutation, every refused request, every login attempt and a few
// sensitive reads). The application never edits the recorded facts; an
// administrator can only attach a review note to an entry.
const SEVERITIES = ["info", "warning", "critical"];

const auditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    userName: { type: String, default: null },
    userEmail: { type: String, default: null },
    role: { type: String, default: null },
    method: { type: String, required: true },
    path: { type: String, required: true },
    route: { type: String, required: true },
    action: { type: String, required: true },
    category: { type: String, required: true },
    resourceId: { type: String, default: null },
    statusCode: { type: Number, required: true },
    outcome: { type: String, enum: ["success", "denied", "failed", "error"], required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    durationMs: { type: Number, default: 0 },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    severity: { type: String, enum: SEVERITIES, default: "info" },
    suspicious: { type: Boolean, default: false },
    flags: { type: [String], default: [] },
    review: {
      reviewed: { type: Boolean, default: false },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      reviewedByName: { type: String, default: null },
      reviewedAt: { type: Date, default: null },
      note: { type: String, default: "" },
    },
  },
  { versionKey: false }
);

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ user: 1, at: -1 });
auditLogSchema.index({ suspicious: 1, at: -1 });
auditLogSchema.index({ severity: 1, at: -1 });
auditLogSchema.index({ category: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });
auditLogSchema.index({ ip: 1, action: 1, at: -1 });

// Optional retention: AUDIT_RETENTION_DAYS=365 removes entries older than a year.
const retentionDays = Number.parseInt(process.env.AUDIT_RETENTION_DAYS, 10);
if (Number.isInteger(retentionDays) && retentionDays > 0) {
  auditLogSchema.index({ at: 1 }, { expireAfterSeconds: retentionDays * 86400, name: "audit_retention" });
}

const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
module.exports.SEVERITIES = SEVERITIES;
