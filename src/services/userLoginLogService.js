const dayjs = require("dayjs");
const { db } = require("../db/init");

function recordUserLogin(req, user) {
  if (!user || !user.id) return;
  try {
    db.prepare(
      `INSERT INTO user_login_logs
        (user_id, username, display_name, role, user_type, logged_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Number(user.id),
      String(user.username || "").trim(),
      String(user.display_name || user.displayName || user.username || "User").trim(),
      String(user.role || "").trim(),
      String(user.user_type || user.userType || user.role || "").trim(),
      dayjs().toISOString(),
      String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip || "")).split(",")[0].trim(),
      String(req.headers["user-agent"] || "").trim()
    );
  } catch (err) {
    console.warn("Unable to record user login:", err.message);
  }
}

function getRecentNonAdminLogins(limit = 5) {
  return db.prepare(
    `SELECT display_name, username, role, user_type, logged_at
     FROM user_login_logs
     WHERE LOWER(COALESCE(role, '')) <> 'admin'
       AND LOWER(COALESCE(user_type, '')) <> 'admin'
     ORDER BY logged_at DESC, id DESC
     LIMIT ?`
  ).all(Number(limit) || 5);
}

function getUserLoginReportRows(limit = 200) {
  return db.prepare(
    `SELECT ull.id, ull.user_id, ull.username, ull.display_name, ull.role, ull.user_type,
            ull.logged_at, ull.ip_address, ull.user_agent
     FROM user_login_logs ull
     ORDER BY ull.logged_at DESC, ull.id DESC
     LIMIT ?`
  ).all(Number(limit) || 200);
}

module.exports = {
  recordUserLogin,
  getRecentNonAdminLogins,
  getUserLoginReportRows
};
