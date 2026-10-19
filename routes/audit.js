const express = require("express");
const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const authMiddleware = require("../middleware/auth");
const { requireAdmin } = require("../utils/accessPolicy");
const { BUSINESS_TIMEZONE, buildTimeframeFilter, paginationMetadata, parsePagination } = require("../utils/queryHelpers");

// Administrator-only security journal. The recorded facts are read-only:
// the only write is a review note attached to an entry.
const router = express.Router();
router.use(authMiddleware, requireAdmin);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFilter(query) {
  const filter = buildTimeframeFilter(query, "at");
  if (query.user && mongoose.isObjectIdOrHexString(query.user)) filter.user = new mongoose.Types.ObjectId(query.user);
  if (["info", "warning", "critical"].includes(query.severity)) filter.severity = query.severity;
  if (query.suspicious === "true") filter.suspicious = true;
  if (["success", "denied", "failed", "error"].includes(query.outcome)) filter.outcome = query.outcome;
  if (typeof query.category === "string" && /^[a-z]{2,20}$/.test(query.category)) filter.category = query.category;
  if (query.reviewed === "false") filter["review.reviewed"] = false;
  if (typeof query.search === "string" && query.search.trim()) {
    const search = { $regex: escapeRegex(query.search.trim().slice(0, 80)), $options: "i" };
    filter.$or = [{ userName: search }, { userEmail: search }, { action: search }, { path: search }, { ip: search }, { flags: search }];
  }
  return filter;
}

// GET /api/audit?from=&to=&user=&severity=&suspicious=&category=&outcome=&search=&page=&limit=
router.get("/", async (req, res) => {
  let filter;
  try {
    filter = buildFilter(req.query);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  const { page, limit, skip } = parsePagination(req.query, 50, 200);
  try {
    const [result] = await AuditLog.aggregate([
      { $match: filter },
      {
        $facet: {
          rows: [
            { $sort: { at: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
            { $project: { userAgent: 0 } },
          ],
          total: [{ $count: "count" }],
          bySeverity: [{ $group: { _id: "$severity", count: { $sum: 1 } } }],
          byOutcome: [{ $group: { _id: "$outcome", count: { $sum: 1 } } }],
          byCategory: [{ $group: { _id: "$category", count: { $sum: 1 }, suspicious: { $sum: { $cond: ["$suspicious", 1, 0] } } } }, { $sort: { count: -1 } }],
          byFlag: [{ $unwind: "$flags" }, { $group: { _id: "$flags", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 12 }],
          topUsers: [
            { $match: { user: { $ne: null } } },
            {
              $group: {
                _id: "$user",
                userName: { $last: "$userName" },
                role: { $last: "$role" },
                actions: { $sum: 1 },
                suspicious: { $sum: { $cond: ["$suspicious", 1, 0] } },
                critical: { $sum: { $cond: [{ $eq: ["$severity", "critical"] }, 1, 0] } },
                lastAt: { $max: "$at" },
              },
            },
            { $sort: { critical: -1, suspicious: -1, actions: -1 } },
            { $limit: 8 },
          ],
          timeline: [
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: BUSINESS_TIMEZONE } },
                actions: { $sum: 1 },
                suspicious: { $sum: { $cond: ["$suspicious", 1, 0] } },
              },
            },
            { $sort: { _id: 1 } },
          ],
          unreviewed: [{ $match: { suspicious: true, "review.reviewed": { $ne: true } } }, { $count: "count" }],
        },
      },
    ]).allowDiskUse(true);

    const counts = (rows) => Object.fromEntries((rows || []).map((row) => [row._id, row.count]));
    const total = result?.total?.[0]?.count || 0;
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      source: "mongodb-aggregation",
      data: result?.rows || [],
      pagination: paginationMetadata(page, limit, total),
      summary: {
        total,
        bySeverity: { info: 0, warning: 0, critical: 0, ...counts(result?.bySeverity) },
        byOutcome: { success: 0, denied: 0, failed: 0, error: 0, ...counts(result?.byOutcome) },
        byCategory: (result?.byCategory || []).map((row) => ({ category: row._id, count: row.count, suspicious: row.suspicious })),
        byFlag: (result?.byFlag || []).map((row) => ({ flag: row._id, count: row.count })),
        topUsers: (result?.topUsers || []).map((row) => ({ userId: row._id, userName: row.userName, role: row.role, actions: row.actions, suspicious: row.suspicious, critical: row.critical, lastAt: row.lastAt })),
        timeline: (result?.timeline || []).map((row) => ({ date: row._id, actions: row.actions, suspicious: row.suspicious })),
        unreviewedSuspicious: result?.unreviewed?.[0]?.count || 0,
      },
    });
  } catch (error) {
    console.error("Audit journal query failed:", error);
    res.status(500).json({ success: false, message: "Impossible de charger le journal d'audit" });
  }
});

// PATCH /api/audit/:id/review  { note }
router.patch("/:id/review", async (req, res) => {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid audit entry ID" });
  }
  const note = String(req.body?.note || "").trim().slice(0, 500);
  try {
    const entry = await AuditLog.findOneAndUpdate(
      { _id: req.params.id },
      {
        $set: {
          "review.reviewed": true,
          "review.reviewedBy": req.user._id,
          "review.reviewedByName": req.user.username || null,
          "review.reviewedAt": new Date(),
          "review.note": note,
        },
      },
      { new: true, projection: { userAgent: 0 } }
    ).lean();
    if (!entry) return res.status(404).json({ success: false, message: "Entrée introuvable" });
    res.json({ success: true, data: entry });
  } catch (error) {
    console.error("Audit review failed:", error);
    res.status(500).json({ success: false, message: "Impossible d'enregistrer la revue" });
  }
});

// Recorded facts cannot be edited or erased through the API.
router.all(["/:id", "/"], (req, res, next) => {
  if (["PUT", "DELETE", "POST"].includes(req.method)) {
    return res.status(405).json({ success: false, message: "Le journal d'audit est en lecture seule." });
  }
  next();
});

module.exports = router;
