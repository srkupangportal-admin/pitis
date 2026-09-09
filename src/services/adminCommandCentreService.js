const dayjs = require("dayjs");
const { db } = require("../db/init");

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params) || {};
  return Number(row.value || 0);
}

function getAdminCommandCentre(options = {}) {
  const today = dayjs().format("YYYY-MM-DD");
  const backup = options.backupDashboard || {};
  const rollover = options.academicYearRollover || {};
  const activeStudents = scalar(`
    SELECT COUNT(*) AS value FROM students s
    JOIN classes c ON c.id = s.class_id
    WHERE UPPER(c.name) NOT LIKE 'ALUMNI %'
  `);
  const activeTeachers = scalar(`
    SELECT COUNT(*) AS value FROM users
    WHERE COALESCE(is_active, 1) = 1 AND LOWER(COALESCE(user_type, role)) = 'teacher'
  `);
  const totalClasses = scalar("SELECT COUNT(*) AS value FROM classes WHERE UPPER(name) NOT LIKE 'ALUMNI %'");
  const attendance = db.prepare(`
    SELECT COUNT(DISTINCT ar.student_id) AS recorded,
           COUNT(DISTINCT CASE WHEN ar.is_present = 1 THEN ar.student_id END) AS present,
           COUNT(DISTINCT ans.class_id) AS classes_recorded
    FROM attendance_sessions ans
    LEFT JOIN attendance_records ar ON ar.session_id = ans.id
    JOIN classes c ON c.id = ans.class_id
    WHERE ans.attendance_date = ? AND UPPER(c.name) NOT LIKE 'ALUMNI %'
  `).get(today) || {};
  const recorded = Number(attendance.recorded || 0);
  const present = Number(attendance.present || 0);
  const classesRecorded = Number(attendance.classes_recorded || 0);
  const failedActions = scalar(`
    SELECT COUNT(*) AS value FROM admin_action_logs
    WHERE result = 'failed' AND created_at >= ?
  `, dayjs().subtract(7, "day").toISOString());
  const attentionDevices = scalar(`
    SELECT COUNT(*) AS value FROM school_inventory
    WHERE LOWER(COALESCE(status, '')) IN ('maintenance','unavailable','inactive')
       OR LOWER(COALESCE(item_condition, '')) IN ('damaged','poor','needs repair')
  `);
  const upcomingEvents = db.prepare(`
    SELECT title, event_date, COALESCE(end_date, event_date) AS end_date
    FROM calendar_events
    WHERE is_deleted = 0 AND event_date >= ?
    ORDER BY event_date ASC, id ASC LIMIT 3
  `).all(today);
  const latestBackupAt = backup.latest?.finished_at || backup.latest?.started_at || backup.settings?.last_run_at || null;
  const backupAgeHours = latestBackupAt && dayjs(latestBackupAt).isValid()
    ? dayjs().diff(dayjs(latestBackupAt), "hour", true)
    : null;
  const backupHealthy = Boolean(
    latestBackupAt && backupAgeHours <= 72
    && String(backup.latest?.status || backup.settings?.last_status || "").toLowerCase() === "success"
    && !backup.status?.warning
  );

  const alerts = [];
  if (!backupHealthy) {
    alerts.push({ severity: "high", title: "Backup needs attention", detail: backup.status?.warning || (latestBackupAt ? "No successful backup in the last 72 hours." : "No completed backup is recorded."), action: "backup" });
  }
  if (failedActions > 0) {
    alerts.push({ severity: "medium", title: `${failedActions} failed administrator action${failedActions === 1 ? "" : "s"}`, detail: "Review failures recorded during the last 7 days.", action: "audit" });
  }
  if (attentionDevices > 0) {
    alerts.push({ severity: "medium", title: `${attentionDevices} inventory item${attentionDevices === 1 ? "" : "s"} need attention`, detail: "Maintenance, unavailable, inactive, damaged, or poor-condition items were found.", action: "devices" });
  }
  if (classesRecorded < totalClasses) {
    alerts.push({ severity: "low", title: `Attendance pending for ${Math.max(totalClasses - classesRecorded, 0)} class${totalClasses - classesRecorded === 1 ? "" : "es"}`, detail: `${classesRecorded} of ${totalClasses} active classes have an attendance session for today.`, action: "attendance" });
  }

  return {
    generatedAt: dayjs().format("DD MMM YYYY, hh:mm A"),
    metrics: {
      activeStudents,
      activeTeachers,
      totalClasses,
      attendanceRecorded: recorded,
      attendancePresent: present,
      attendancePercentage: recorded ? Math.round((present / recorded) * 100) : 0,
      classesRecorded,
      failedActions,
      attentionDevices
    },
    backup: {
      healthy: backupHealthy,
      latestAt: latestBackupAt,
      message: backupHealthy ? "Protected within the last 72 hours" : "Needs administrator attention"
    },
    rollover: {
      ready: Boolean(rollover.ready),
      targetYear: rollover.targetYear,
      totalStudents: rollover.totalStudents || 0
    },
    upcomingEvents,
    alerts
  };
}

module.exports = { getAdminCommandCentre };
