const dayjs = require("dayjs");
const { db } = require("../db/init");

function recordPhotoActivity(req, user, activity) {
  const payload = activity && typeof activity === "object" ? activity : {};
  const actor = user && typeof user === "object" ? user : {};

  try {
    db.prepare(
      `INSERT INTO photo_activity_logs
        (user_id, username, display_name, activity_type, target_type, target_label, folder_id, file_id, details, created_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Number(actor.id) || null,
      String(actor.username || "").trim(),
      String(actor.displayName || actor.display_name || actor.username || "User").trim(),
      String(payload.activityType || "").trim() || "unknown",
      String(payload.targetType || "").trim() || "library",
      String(payload.targetLabel || "").trim(),
      Number(payload.folderId) || null,
      Number(payload.fileId) || null,
      String(payload.details || "").trim(),
      dayjs().toISOString(),
      String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip || "")).split(",")[0].trim(),
      String(req.headers["user-agent"] || "").trim()
    );
  } catch (error) {
    console.warn("Unable to record photo activity:", error.message);
  }
}

function getPhotoActivityReportRows(limit = 200) {
  return db.prepare(
    `SELECT pal.id, pal.user_id, pal.username, pal.display_name, pal.activity_type, pal.target_type, pal.target_label,
            pal.folder_id, pal.file_id, pal.details, pal.created_at, pal.ip_address, pal.user_agent
     FROM photo_activity_logs pal
     ORDER BY pal.created_at DESC, pal.id DESC
     LIMIT ?`
  ).all(Number(limit) || 200);
}

module.exports = {
  recordPhotoActivity,
  getPhotoActivityReportRows
};
