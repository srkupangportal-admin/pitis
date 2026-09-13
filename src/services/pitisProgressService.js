const dayjs = require("dayjs");
const { db } = require("../db/init");
const { buildOfficialWeeks, buildSipPitisDashboard } = require("./sipPitisDashboardService");

function initializePitisProgressTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS pitis_progress_views (
    user_id INTEGER PRIMARY KEY,
    last_daily_summary_date TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
}

function isTeacherUser(user) {
  return Boolean(user)
    && String(user.role || "").toLowerCase() === "teacher"
    && String(user.userType || user.user_type || "").toLowerCase() === "teacher";
}

function buildTeacherProgressSummary(userId, options = {}) {
  const asOf = String(options.asOf || dayjs().format("YYYY-MM-DD"));
  const dashboard = buildSipPitisDashboard({ includeAllTeachers: true, asOf });
  const currentWeek = dashboard.currentWeek || null;
  const currentWeekKey = currentWeek ? currentWeek.weekKey : "";
  const teachers = dashboard.allTeacherReports.map((teacher) => {
    const week = teacher.weeks.find((item) => item.weekKey === currentWeekKey) || null;
    return {
      id: Number(teacher.id),
      displayName: teacher.display_name || teacher.username || "Teacher",
      activeDays: week ? Number(week.activeDays || 0) : 0,
      requiredDays: week ? Number(week.requiredDays || 0) : 0,
      availableSchoolDays: week ? Number(week.availableSchoolDays || 0) : 0,
      percentage: week ? Number(week.achievementRate || 0) : 0,
      status: week ? String(week.status || "") : "Outside Term",
      pointsAwarded: week ? week.days.reduce((sum, item) => sum + Number(item.positivePointsAwarded || 0), 0) : 0,
      studentsRewarded: week ? week.days.reduce((sum, item) => sum + Number(item.studentsRewarded || 0), 0) : 0,
      days: week ? week.days.map((item) => ({
        date: item.date, label: item.label, shortLabel: item.shortLabel, type: item.type,
        counted: Boolean(item.counted), isFuture: Boolean(item.isFuture), isToday: item.date === asOf,
        exclusionReason: item.exclusionReason || "", dailyStatus: item.dailyStatus || ""
      })) : []
    };
  }).sort((a, b) => b.percentage - a.percentage || b.activeDays - a.activeDays || a.displayName.localeCompare(b.displayName))
    .map((teacher, index) => ({ ...teacher, rank: index + 1 }));
  return {
    term: Number(dashboard.currentTerm || dashboard.filters.term || 1),
    weekNumber: currentWeek ? Number(currentWeek.weekNumber || 0) : null,
    weekKey: currentWeekKey,
    weekRange: currentWeek ? currentWeek.rangeLabel : "Outside the school term",
    schoolConsistency: Number(dashboard.kpis.schoolConsistency || 0),
    teachers,
    currentTeacher: teachers.find((teacher) => teacher.id === Number(userId)) || null
  };
}

function shouldShowDailySummary(userId, date = dayjs().format("YYYY-MM-DD")) {
  initializePitisProgressTables();
  const row = db.prepare("SELECT last_daily_summary_date FROM pitis_progress_views WHERE user_id = ?").get(Number(userId));
  return !row || row.last_daily_summary_date !== date;
}

function markDailySummaryShown(userId, date = dayjs().format("YYYY-MM-DD")) {
  initializePitisProgressTables();
  db.prepare(`INSERT INTO pitis_progress_views(user_id,last_daily_summary_date,updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_daily_summary_date=excluded.last_daily_summary_date,updated_at=excluded.updated_at`)
    .run(Number(userId), date, dayjs().toISOString());
}

function buildWeeklySummary(userId, options = {}) {
  const asOf = String(options.asOf || dayjs().format("YYYY-MM-DD"));
  const completed = buildOfficialWeeks(asOf).filter((week) => dayjs(week.end).isBefore(dayjs(asOf), "day"));
  const week = completed[completed.length - 1] || null;
  // Weekly summaries are timely updates, not old alerts after a long holiday.
  if (!week || dayjs(asOf).diff(dayjs(week.end), "day") > 7) return null;
  const dashboard = buildSipPitisDashboard({ includeAllTeachers: true, asOf, term: week.term });
  const teacher = dashboard.allTeacherReports.find((item) => Number(item.id) === Number(userId)) || null;
  const report = teacher && week ? teacher.weeks.find((item) => item.weekKey === week.weekKey) : null;
  if (!week || !report) return null;
  return {
    weekKey: week.weekKey,
    entityId: Number(String(week.start || "").replace(/-/g, "")) || Number(week.weekNumber || 0),
    term: Number(week.term || dashboard.currentTerm || 1), weekNumber: Number(week.weekNumber || 0),
    rangeLabel: week.rangeLabel, activeDays: Number(report.activeDays || 0),
    requiredDays: Number(report.requiredDays || 0), percentage: Number(report.achievementRate || 0),
    status: String(report.status || ""),
    pointsAwarded: report.days.reduce((sum, item) => sum + Number(item.positivePointsAwarded || 0), 0),
    studentsRewarded: report.days.reduce((sum, item) => sum + Number(item.studentsRewarded || 0), 0)
  };
}

module.exports = { initializePitisProgressTables, isTeacherUser, buildTeacherProgressSummary, shouldShowDailySummary, markDailySummaryShown, buildWeeklySummary };
