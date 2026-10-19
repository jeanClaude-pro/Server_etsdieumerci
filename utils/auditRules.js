// Suspicion rules for the audit journal. Pure functions: the middleware
// gathers the few counters they need, these decide the flags and severity.
const { DESTRUCTIVE_ACTIONS, PRIVILEGE_ACTIONS } = require("./auditActions");

const BUSINESS_UTC_OFFSET_HOURS = 2; // Africa/Lubumbashi, no DST

function businessHours() {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(process.env.AUDIT_BUSINESS_HOURS || "6-21"));
  const open = match ? Number(match[1]) : 6;
  const close = match ? Number(match[2]) : 21;
  return { open, close };
}

function businessHour(date) {
  return (date.getUTCHours() + BUSINESS_UTC_OFFSET_HOURS) % 24;
}

function isOffHours(date) {
  const { open, close } = businessHours();
  const hour = businessHour(date);
  return hour < open || hour >= close;
}

const THRESHOLDS = Object.freeze({
  repeatedDenials: 3, // within 10 minutes
  loginFailures: 3, // within 15 minutes, same e-mail or IP
  burstMutations: 30, // within 5 minutes
  largeAdjustment: 20, // pieces removed by one correction
  rateJumpPercent: 10, // exchange-rate change
});

const SEVERITY_ORDER = { info: 0, warning: 1, critical: 2 };

// flag code -> severity
const FLAG_SEVERITY = Object.freeze({
  ACCESS_DENIED: "warning",
  REPEATED_DENIALS: "critical",
  LOGIN_FAILED: "warning",
  BRUTE_FORCE: "critical",
  OFF_HOURS: "warning",
  DESTRUCTIVE_ACTION: "warning",
  DESTRUCTIVE_OFF_HOURS: "critical",
  PRIVILEGE_CHANGE: "warning",
  SELF_PRIVILEGE_CHANGE: "critical",
  STOCK_REMOVED: "warning",
  LARGE_STOCK_REMOVAL: "critical",
  BURST_ACTIVITY: "critical",
  RATE_JUMP: "critical",
  MANUAL_OVERRIDE: "warning",
  SELF_VALIDATION: "critical",
  SERVER_ERROR: "warning",
  INACTIVE_ACCOUNT: "critical",
  INJECTION_ATTEMPT: "critical",
  PASSWORD_RECHECK_FAILED: "warning",
  IDENTITY_MISMATCH: "critical",
});

/**
 * @param {object} entry   the audit document being built
 * @param {object} context counters + route hints:
 *   { recentDenials, recentLoginFailures, recentMutations, hints }
 */
function evaluateAuditFlags(entry, context = {}) {
  const flags = new Set();
  const hints = context.hints || {};
  const mutation = entry.method !== "GET" && entry.method !== "HEAD";
  const succeeded = entry.outcome === "success";

  if (entry.outcome === "denied") {
    flags.add("ACCESS_DENIED");
    if ((context.recentDenials || 0) + 1 >= THRESHOLDS.repeatedDenials) flags.add("REPEATED_DENIALS");
  }

  if (entry.action === "auth.login" && entry.statusCode === 401) {
    flags.add("LOGIN_FAILED");
    if ((context.recentLoginFailures || 0) + 1 >= THRESHOLDS.loginFailures) flags.add("BRUTE_FORCE");
  }
  if (entry.action === "auth.login" && entry.statusCode === 403) flags.add("INACTIVE_ACCOUNT");
  if (entry.action === "auth.verify_password" && entry.statusCode === 422) flags.add("PASSWORD_RECHECK_FAILED");

  if (mutation && entry.user && isOffHours(entry.at)) flags.add("OFF_HOURS");

  if (succeeded && DESTRUCTIVE_ACTIONS.has(entry.action)) {
    flags.add(isOffHours(entry.at) ? "DESTRUCTIVE_OFF_HOURS" : "DESTRUCTIVE_ACTION");
  }
  if (succeeded && entry.action === "receipt.admin_override") flags.add("MANUAL_OVERRIDE");

  if (succeeded && PRIVILEGE_ACTIONS.has(entry.action)) {
    flags.add("PRIVILEGE_CHANGE");
    if (entry.user && entry.resourceId && String(entry.user) === String(entry.resourceId)) {
      flags.add("SELF_PRIVILEGE_CHANGE");
    }
  }

  if (succeeded) {
    if (hints.selfValidation) flags.add("SELF_VALIDATION");
    if (hints.identityMismatch) flags.add("IDENTITY_MISMATCH");

    const removed = Number(hints.stockRemoved || 0);
    if (removed > 0) {
      flags.add("STOCK_REMOVED");
      const stockBefore = Number(hints.stockBefore || 0);
      if (removed >= THRESHOLDS.largeAdjustment || (stockBefore > 0 && removed / stockBefore >= 0.5)) {
        flags.add("LARGE_STOCK_REMOVAL");
      }
    }

    if (hints.previousRate && hints.newRate) {
      const change = Math.abs(hints.newRate - hints.previousRate) / hints.previousRate * 100;
      if (change >= THRESHOLDS.rateJumpPercent) flags.add("RATE_JUMP");
    }
  }

  if (hints.injectionBlocked) flags.add("INJECTION_ATTEMPT");
  if (mutation && (context.recentMutations || 0) + 1 >= THRESHOLDS.burstMutations) flags.add("BURST_ACTIVITY");
  if (mutation && entry.statusCode >= 500) flags.add("SERVER_ERROR");

  let severity = "info";
  for (const flag of flags) {
    const level = FLAG_SEVERITY[flag] || "warning";
    if (SEVERITY_ORDER[level] > SEVERITY_ORDER[severity]) severity = level;
  }

  return { flags: [...flags], severity, suspicious: severity !== "info" };
}

module.exports = {
  FLAG_SEVERITY,
  THRESHOLDS,
  businessHour,
  evaluateAuditFlags,
  isOffHours,
};
