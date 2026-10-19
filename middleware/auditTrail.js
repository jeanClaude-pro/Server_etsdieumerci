// Records user actions in the audit journal once the response is sent.
// Never blocks, slows or fails the request it observes.
const AuditLog = require("../models/AuditLog");
const { SENSITIVE_READS, describeRequest, resourceIdOf } = require("../utils/auditActions");
const { evaluateAuditFlags } = require("../utils/auditRules");

const SECRET_KEY = /pass(word)?|token|secret|cipher|hash|authorization|signature/i;
const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_DEPTH = 3;
const MAX_DETAILS_BYTES = 4000;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`… +${value.length - MAX_ARRAY}`);
    return items;
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? "[masqué]" : sanitize(nested, depth + 1);
    }
    return output;
  }
  return String(value);
}

function boundedDetails(details) {
  try {
    const json = JSON.stringify(details);
    if (json.length <= MAX_DETAILS_BYTES) return details;
    return { truncated: true, preview: json.slice(0, MAX_DETAILS_BYTES) };
  } catch {
    return { unserializable: true };
  }
}

function outcomeOf(status) {
  if (status === 401 || status === 403) return "denied";
  if (status >= 500) return "error";
  if (status >= 400) return "failed";
  return "success";
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "") || null;
}

function shouldRecord(method, outcome, action) {
  if (method === "OPTIONS" || method === "HEAD") return false;
  if (method !== "GET") return true;
  return outcome === "denied" || SENSITIVE_READS.has(action);
}

async function countersFor(entry) {
  const context = {};
  const tasks = [];
  const now = entry.at.getTime();
  if (entry.outcome === "denied" && (entry.user || entry.ip)) {
    tasks.push(
      AuditLog.countDocuments({
        ...(entry.user ? { user: entry.user } : { ip: entry.ip }),
        outcome: "denied",
        at: { $gte: new Date(now - 10 * 60 * 1000) },
      }).then((count) => { context.recentDenials = count; })
    );
  }
  if (entry.action === "auth.login" && entry.statusCode === 401) {
    const or = [{ ip: entry.ip }];
    if (entry.userEmail) or.push({ userEmail: entry.userEmail });
    tasks.push(
      AuditLog.countDocuments({
        action: "auth.login",
        statusCode: 401,
        $or: or,
        at: { $gte: new Date(now - 15 * 60 * 1000) },
      }).then((count) => { context.recentLoginFailures = count; })
    );
  }
  if (entry.method !== "GET" && entry.user) {
    tasks.push(
      AuditLog.countDocuments({
        user: entry.user,
        method: { $ne: "GET" },
        at: { $gte: new Date(now - 5 * 60 * 1000) },
      }).then((count) => { context.recentMutations = count; })
    );
  }
  await Promise.all(tasks);
  return context;
}

async function record(req, res, startedAt) {
  const method = req.method;
  const status = res.statusCode;
  const outcome = outcomeOf(status);
  const { route, action, category } = describeRequest(method, req.originalUrl);
  if (!shouldRecord(method, outcome, action) && !res.locals.audit?.injectionBlocked) return;

  const actor = res.locals.auditActor || req.user || null;
  // An expired session polling the API is noise, not an attack.
  if (method === "GET" && status === 401 && !actor) return;
  const hints = res.locals.audit || {};
  const body = req.body && typeof req.body === "object" ? sanitize(req.body) : undefined;
  const entry = {
    at: new Date(),
    user: actor?._id || null,
    userName: actor?.username || null,
    userEmail: actor?.email || (action === "auth.login" ? String(req.body?.email || "").trim().toLowerCase().slice(0, 254) || null : null),
    role: actor?.role || null,
    method,
    path: String(req.originalUrl).split("?")[0].slice(0, 300),
    route,
    action,
    category,
    resourceId: hints.resourceId || resourceIdOf(req.originalUrl),
    statusCode: status,
    outcome,
    ip: clientIp(req),
    userAgent: String(req.get("user-agent") || "").slice(0, 200) || null,
    durationMs: Date.now() - startedAt,
    details: boundedDetails(sanitize({
      ...(Object.keys(req.query || {}).length ? { query: req.query } : {}),
      ...(body && Object.keys(body).length ? { body } : {}),
      ...(hints.summary ? { summary: hints.summary } : {}),
      ...(res.locals.accessDenied ? { denied: res.locals.accessDenied } : {}),
    })),
  };

  const context = await countersFor(entry);
  context.hints = hints;
  Object.assign(entry, evaluateAuditFlags(entry, context));
  await AuditLog.create(entry);
}

function auditTrail(req, res, next) {
  const startedAt = Date.now();
  res.on("finish", () => {
    setImmediate(() => {
      record(req, res, startedAt).catch((error) => {
        console.error("Audit journal write failed:", error.message);
      });
    });
  });
  next();
}

module.exports = auditTrail;
module.exports.sanitize = sanitize;
module.exports.outcomeOf = outcomeOf;
module.exports.shouldRecord = shouldRecord;
