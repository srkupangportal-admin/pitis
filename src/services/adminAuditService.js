const dayjs = require("dayjs");
const { db } = require("../db/init");

const SENSITIVE_KEYS = new Set([
  "password", "new_password", "current_password", "password_hash",
  "confirmation", "csrf", "token", "qr_token"
]);

function humanizeSegment(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function describeAdminAction(method, routePath) {
  const segments = String(routePath || "").split("?")[0].split("/").filter(Boolean);
  const adminIndex = segments.indexOf("admin");
  const relevant = adminIndex >= 0 ? segments.slice(adminIndex + 1) : segments;
  const actionWord = relevant.find((segment) => /^(add|update|delete|reset|restore|rollover|import|upload|purge|run-now|set-active|save-path|bulk-manage)$/.test(segment));
  const area = relevant[0] || "administration";
  const target = relevant.filter((segment) => segment !== actionWord).slice(0, 3).join(" / ") || area;
  return {
    actionType: actionWord || String(method || "POST").toLowerCase(),
    actionLabel: `${humanizeSegment(actionWord || method)} ${humanizeSegment(area)}`.trim(),
    targetType: area,
    targetLabel: target
  };
}

function safeRequestDetails(body) {
  if (!body || typeof body !== "object") return {};
  const output = {};
  Object.entries(body).forEach(([key, value]) => {
    const normalizedKey = String(key).toLowerCase();
    if (SENSITIVE_KEYS.has(normalizedKey) || /password|secret|confirmation|token/.test(normalizedKey)) return;
    const values = Array.isArray(value) ? value : [value];
    output[key] = values.slice(0, 25).map((item) => String(item == null ? "" : item).slice(0, 300));
    if (!Array.isArray(value)) output[key] = output[key][0];
  });
  return output;
}

function getResultFromResponse(res) {
  const location = String(res.getHeader("location") || "");
  if (/[?&]error=/i.test(location) || res.statusCode >= 400) return "failed";
  return "success";
}

function adminAuditMiddleware(req, res, next) {
  if (!req.session || !req.session.user || req.method === "GET" || req.method === "HEAD") return next();
  const startedAt = Date.now();
  const actor = { ...req.session.user };
  res.once("finish", () => {
    try {
      const action = describeAdminAction(req.method, req.originalUrl);
      db.prepare(`
        INSERT INTO admin_action_logs
          (user_id, username, display_name, action_type, action_label, target_type, target_label,
           request_method, request_path, result, response_status, details_json, ip_address, user_agent,
           duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        actor.id || null,
        actor.username || "unknown",
        actor.displayName || actor.username || "Unknown administrator",
        action.actionType,
        action.actionLabel,
        action.targetType,
        action.targetLabel,
        req.method,
        String(req.originalUrl || "").split("?")[0],
        getResultFromResponse(res),
        Number(res.statusCode || 0),
        JSON.stringify(safeRequestDetails(req.body)),
        req.ip || req.socket?.remoteAddress || "",
        String(req.get("user-agent") || "").slice(0, 500),
        Date.now() - startedAt,
        dayjs().toISOString()
      );
    } catch (error) {
      console.error("Unable to write administrator audit log:", error);
    }
  });
  next();
}

function getAdminAuditRows(filters = {}, limit = 100) {
  const clauses = [];
  const values = [];
  if (filters.search) {
    clauses.push("(username LIKE ? OR display_name LIKE ? OR action_label LIKE ? OR target_label LIKE ? OR request_path LIKE ?)");
    const term = `%${String(filters.search).trim()}%`;
    values.push(term, term, term, term, term);
  }
  if (filters.result === "success" || filters.result === "failed") {
    clauses.push("result = ?");
    values.push(filters.result);
  }
  if (filters.dateFrom) {
    clauses.push("DATE(created_at) >= DATE(?)");
    values.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    clauses.push("DATE(created_at) <= DATE(?)");
    values.push(filters.dateTo);
  }
  values.push(Math.min(Math.max(Number(limit) || 100, 1), 5000));
  return db.prepare(`
    SELECT id, user_id, username, display_name, action_type, action_label, target_type, target_label,
           request_method, request_path, result, response_status, details_json, ip_address, user_agent,
           duration_ms, created_at
    FROM admin_action_logs
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...values).map((row) => ({
    ...row,
    details: (() => { try { return JSON.parse(row.details_json || "{}"); } catch (_) { return {}; } })()
  }));
}

module.exports = { adminAuditMiddleware, getAdminAuditRows, safeRequestDetails };
