const dayjs = require("dayjs");
const { db } = require("../db/init");
const { SCHOOL_TERMS_2026, buildSipPitisDashboard } = require("./sipPitisDashboardService");
const { buildStudentRecognitionCoverageReport } = require("./studentRecognitionCoverageService");

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function normalizeAsOf(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && dayjs(raw).isValid() ? raw : dayjs().format("YYYY-MM-DD");
}

function buildLeadershipTermSummary(query = {}) {
  const asOf = normalizeAsOf(query.asOf);
  const inferred = SCHOOL_TERMS_2026.find((item) => !dayjs(asOf).isBefore(dayjs(item.start), "day") && !dayjs(asOf).isAfter(dayjs(item.end), "day"));
  const requestedTerm = Number(query.term || (inferred && inferred.term) || 1);
  const term = SCHOOL_TERMS_2026.find((item) => Number(item.term) === requestedTerm) || SCHOOL_TERMS_2026[0];
  const reportEnd = dayjs(asOf).isBefore(dayjs(term.start), "day") ? term.start : dayjs(asOf).isAfter(dayjs(term.end), "day") ? term.end : asOf;
  const dashboard = buildSipPitisDashboard({ asOf, term: term.term });
  const coverage = buildStudentRecognitionCoverageReport({ classId: "all", from: term.start, to: reportEnd });
  const totals = db.prepare(`
    SELECT COUNT(*) AS transactions,
           SUM(CASE WHEN points > 0 THEN points ELSE 0 END) AS awarded,
           ABS(SUM(CASE WHEN points < 0 THEN points ELSE 0 END)) AS deducted,
           COUNT(DISTINCT CASE WHEN points > 0 THEN student_id END) AS recognised_students,
           COUNT(DISTINCT awarded_by) AS active_teachers
    FROM point_logs WHERE date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
  `).get(term.start, reportEnd);
  const teacherRows = dashboard.allTeacherReports.map((teacher) => ({
    id: Number(teacher.id), name: teacher.display_name, username: teacher.username,
    completedWeeks: Number(teacher.completedWeeks || 0), metWeeks: Number(teacher.metCompletedWeeks || 0),
    consistency: Number(teacher.termPercentage || 0), currentStreak: Number(teacher.currentStreak || 0),
    termPitisAwarded: Number(teacher.termPitisAwarded || 0)
  })).sort((a, b) => a.consistency - b.consistency || a.name.localeCompare(b.name));
  const classRows = coverage.classRows.slice().sort((a, b) => a.coverage - b.coverage || a.name.localeCompare(b.name));
  const completedWeeks = dashboard.weeks.filter((week) => dayjs(week.end).isBefore(dayjs(asOf), "day"));
  return {
    asOf, term, reportEnd, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"), dashboard,
    summary: {
      sipStatus: dashboard.sipTarget.status,
      teachersOnTrack: dashboard.kpis.teachersOnTrack,
      teachersTotal: dashboard.teachers.length,
      schoolConsistency: dashboard.kpis.schoolConsistency,
      recognitionCoverage: coverage.summary.coverage,
      recognisedStudents: coverage.summary.recognisedStudents,
      students: coverage.summary.students,
      transactions: Number(totals.transactions || 0), awarded: Number(totals.awarded || 0),
      deducted: Number(totals.deducted || 0), activeTeachers: Number(totals.active_teachers || 0),
      completedWeeks: completedWeeks.length
    },
    teacherPriorities: teacherRows.filter((row) => row.consistency < 80),
    teacherRows, classPriorities: classRows.filter((row) => row.coverage < 80), classRows,
    weeklyRows: dashboard.weeklyChart
      .filter((week) => !dayjs(week.start).isAfter(dayjs(asOf), "day"))
      .map((week) => ({ weekNumber: week.weekNumber, start: week.start, meeting: week.meeting, missing: week.missing, total: week.total }))
  };
}

function leadershipTermSummaryToCsv(report) {
  const rows = [["section", "name", "metric", "value", "support_priority"]];
  report.teacherRows.forEach((row) => rows.push(["Teacher consistency", row.name, "Consistency", `${row.consistency}%`, row.consistency < 80 ? "Yes" : "No"]));
  report.classRows.forEach((row) => rows.push(["Class coverage", row.name, "Recognition coverage", `${row.coverage}%`, row.coverage < 80 ? "Yes" : "No"]));
  report.weeklyRows.forEach((row) => rows.push(["Weekly trend", `Week ${row.weekNumber}`, "Teachers meeting target", `${row.meeting}/${row.total}`, row.missing ? "Review" : ""]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function buildPwaAdoptionReport() {
  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, COALESCE(u.user_type, u.role) AS user_type,
           (SELECT MAX(logged_at) FROM user_login_logs l WHERE l.user_id = u.id) AS last_login_at,
           (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.enabled = 1) AS active_devices,
           (SELECT MAX(ps.last_seen_at) FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.enabled = 1) AS push_last_seen_at,
           (SELECT COUNT(*) FROM notifications n WHERE n.user_id = u.id AND n.type = 'pitis_app_invite') AS invite_count,
           (SELECT MAX(n.created_at) FROM notifications n WHERE n.user_id = u.id AND n.type = 'pitis_app_invite') AS last_invited_at,
           (SELECT MAX(n.read_at) FROM notifications n WHERE n.user_id = u.id AND n.type = 'pitis_app_invite') AS invite_read_at,
           p.first_seen_at AS pwa_first_seen_at, p.last_seen_at AS pwa_last_seen_at,
           COALESCE(p.page_views, 0) AS page_views, COALESCE(p.scan_count, 0) AS scan_count,
           COALESCE(p.transaction_count, 0) AS pwa_transactions, c.name AS last_class_name
    FROM users u
    LEFT JOIN pwa_user_activity p ON p.user_id = u.id
    LEFT JOIN classes c ON c.id = p.last_class_id
    WHERE COALESCE(u.is_active, 1) = 1 AND u.role IN ('teacher', 'staff', 'admin')
    ORDER BY pwa_last_seen_at DESC, u.display_name COLLATE NOCASE
  `).all().map((row) => ({
    id: Number(row.id), username: row.username, name: row.display_name, role: row.user_type,
    lastLoginAt: row.last_login_at || "Never", activeDevices: Number(row.active_devices),
    pushLastSeenAt: row.push_last_seen_at || "Never", inviteCount: Number(row.invite_count),
    lastInvitedAt: row.last_invited_at || "Not invited", inviteReadAt: row.invite_read_at || "Not read",
    pwaFirstSeenAt: row.pwa_first_seen_at || "Not recorded", pwaLastSeenAt: row.pwa_last_seen_at || "Not recorded",
    pageViews: Number(row.page_views), scanCount: Number(row.scan_count), pwaTransactions: Number(row.pwa_transactions),
    lastClassName: row.last_class_name || "None",
    status: Number(row.pwa_transactions) > 0 ? "Active PWA user" : row.pwa_last_seen_at ? "Opened PWA" : Number(row.active_devices) > 0 ? "Push enabled" : Number(row.invite_count) > 0 ? "Invited" : "Not started"
  }));
  const deliveryRows = db.prepare(`
    SELECT status, COUNT(*) AS total FROM notification_delivery_log GROUP BY status ORDER BY status
  `).all().map((row) => ({ status: row.status, total: Number(row.total) }));
  return {
    generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"), users, deliveryRows,
    summary: {
      users: users.length,
      invited: users.filter((row) => row.inviteCount > 0).length,
      inviteRead: users.filter((row) => row.inviteReadAt !== "Not read").length,
      pushEnabled: users.filter((row) => row.activeDevices > 0).length,
      pwaOpened: users.filter((row) => row.pwaLastSeenAt !== "Not recorded").length,
      pwaTransacting: users.filter((row) => row.pwaTransactions > 0).length,
      activeDevices: users.reduce((sum, row) => sum + row.activeDevices, 0),
      pwaTransactions: users.reduce((sum, row) => sum + row.pwaTransactions, 0),
      scans: users.reduce((sum, row) => sum + row.scanCount, 0)
    }
  };
}

function pwaAdoptionReportToCsv(report) {
  const rows = [["user", "username", "role", "status", "invites", "last_invited", "invite_read", "active_push_devices", "pwa_first_seen", "pwa_last_seen", "pwa_views", "qr_scans", "pwa_transactions", "last_class"]];
  report.users.forEach((row) => rows.push([row.name, row.username, row.role, row.status, row.inviteCount, row.lastInvitedAt, row.inviteReadAt, row.activeDevices, row.pwaFirstSeenAt, row.pwaLastSeenAt, row.pageViews, row.scanCount, row.pwaTransactions, row.lastClassName]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

module.exports = { buildLeadershipTermSummary, leadershipTermSummaryToCsv, buildPwaAdoptionReport, pwaAdoptionReportToCsv };
