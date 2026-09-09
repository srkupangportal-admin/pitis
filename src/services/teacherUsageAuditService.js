const dayjs = require("dayjs");
const { db } = require("../db/init");

const SCHOOL_DAY_OFFSETS = [0, 1, 2, 3, 5];
const AUDIT_DAY_OF_WEEK = 6;
const AUDIT_TIME = "15:00";

let auditTimer = null;
let auditInProgress = false;

function parseIsoDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed : null;
}

function getMondayForDate(date) {
  return date.subtract((date.day() + 6) % 7, "day").startOf("day");
}

function getTeacherUsageDateBounds() {
  const row = db.prepare(`
    SELECT MIN(activity_date) AS first_date, MAX(activity_date) AS last_date
    FROM (
      SELECT date(logged_at) AS activity_date
      FROM user_login_logs
      WHERE user_id IS NOT NULL
      UNION ALL
      SELECT date(awarded_at) AS activity_date
      FROM point_logs
      WHERE awarded_by IS NOT NULL
    )
    WHERE activity_date IS NOT NULL
  `).get() || {};

  const today = dayjs().format("YYYY-MM-DD");
  return {
    first_date: row.first_date || today,
    last_date: row.last_date || today
  };
}

function getAuditUsers() {
  return db.prepare(`
    SELECT id, username, display_name
    FROM users
    WHERE COALESCE(is_active, 1) = 1
      AND LOWER(COALESCE(role, '')) <> 'admin'
      AND LOWER(COALESCE(user_type, '')) <> 'admin'
    ORDER BY display_name ASC, username ASC
  `).all();
}

function getPublicHolidayDateSet(rangeStart, rangeEnd) {
  const rows = db.prepare(`
    SELECT ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date
    FROM calendar_events ce
    JOIN calendar_event_labels cel ON cel.event_id = ce.id
    JOIN calendar_labels cl ON cl.id = cel.label_id
    WHERE ce.is_deleted = 0
      AND LOWER(cl.name) = 'public holiday'
      AND date(COALESCE(ce.end_date, ce.event_date)) >= date(?)
      AND date(ce.event_date) <= date(?)
  `).all(rangeStart, rangeEnd);

  const dates = new Set();
  rows.forEach((row) => {
    let start = parseIsoDate(row.event_date);
    let end = parseIsoDate(row.end_date || row.event_date);
    if (!start || !end) return;
    if (end.isBefore(start, "day")) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    let cursor = start;
    while (!cursor.isAfter(end, "day")) {
      dates.add(cursor.format("YYYY-MM-DD"));
      cursor = cursor.add(1, "day");
    }
  });
  return dates;
}

function buildWeeks(dateFrom, dateTo, holidayDates) {
  const weeks = [];
  let cursor = getMondayForDate(dateFrom);
  const lastWeek = getMondayForDate(dateTo);
  while (!cursor.isAfter(lastWeek, "day")) {
    const days = SCHOOL_DAY_OFFSETS.map((offset) => {
      const date = cursor.add(offset, "day").format("YYYY-MM-DD");
      return {
        date,
        is_school_day: !holidayDates.has(date)
      };
    });
    const schoolDayCount = days.filter((day) => day.is_school_day).length;
    weeks.push({
      start: cursor.format("YYYY-MM-DD"),
      end: cursor.add(5, "day").format("YYYY-MM-DD"),
      days,
      school_day_count: schoolDayCount,
      required_days: schoolDayCount > 0 ? Math.ceil(schoolDayCount * 0.6) : 0
    });
    cursor = cursor.add(7, "day");
  }
  return weeks;
}

function mapRowsByUserDate(rows, dateKey) {
  const map = new Map();
  rows.forEach((row) => {
    map.set(`${Number(row.user_id)}:${String(row[dateKey] || "")}`, row);
  });
  return map;
}

function runTeacherUsageAudit(options = {}) {
  if (auditInProgress) {
    throw new Error("Teacher usage audit is already running");
  }

  auditInProgress = true;
  const triggerType = options.trigger_type === "manual" ? "manual" : "auto";
  const bounds = getTeacherUsageDateBounds();
  const requestedFrom = parseIsoDate(options.date_from || bounds.first_date);
  const requestedTo = parseIsoDate(options.date_to || bounds.last_date);
  const dateFrom = requestedFrom || parseIsoDate(bounds.first_date) || dayjs();
  const dateTo = requestedTo && !requestedTo.isBefore(dateFrom, "day") ? requestedTo : dayjs();
  const queryStart = getMondayForDate(dateFrom).format("YYYY-MM-DD");
  const queryEnd = getMondayForDate(dateTo).add(5, "day").format("YYYY-MM-DD");
  const users = getAuditUsers();
  const startedAt = dayjs().toISOString();

  const runInfo = db.prepare(`
    INSERT INTO teacher_usage_audit_runs
      (trigger_type, date_from, date_to, started_at, finished_at, status, error_message)
    VALUES (?, ?, ?, ?, NULL, 'failed', NULL)
  `).run(triggerType, dateFrom.format("YYYY-MM-DD"), dateTo.format("YYYY-MM-DD"), startedAt);
  const runId = Number(runInfo.lastInsertRowid);

  try {
    const holidayDates = getPublicHolidayDateSet(queryStart, queryEnd);
    const weeks = buildWeeks(dateFrom, dateTo, holidayDates);
    const userIds = users.map((user) => Number(user.id));
    const placeholders = userIds.map(() => "?").join(",");
    const loginRows = userIds.length ? db.prepare(`
      SELECT user_id, date(logged_at) AS activity_date, COUNT(*) AS login_count
      FROM user_login_logs
      WHERE user_id IN (${placeholders})
        AND date(logged_at) BETWEEN ? AND ?
      GROUP BY user_id, date(logged_at)
    `).all(...userIds, queryStart, queryEnd) : [];
    const awardRows = userIds.length ? db.prepare(`
      SELECT awarded_by AS user_id, date(awarded_at) AS activity_date,
             COUNT(*) AS award_count,
             COUNT(DISTINCT student_id) AS student_count
      FROM point_logs
      WHERE awarded_by IN (${placeholders})
        AND date(awarded_at) BETWEEN ? AND ?
      GROUP BY awarded_by, date(awarded_at)
    `).all(...userIds, queryStart, queryEnd) : [];

    const loginByUserDate = mapRowsByUserDate(loginRows, "activity_date");
    const awardByUserDate = mapRowsByUserDate(awardRows, "activity_date");
    const insertWeekly = db.prepare(`
      INSERT INTO teacher_usage_weekly_audits
        (run_id, user_id, username, display_name, week_start, week_end, school_day_count,
         required_days, valid_days, target_met, total_logins, total_awards, students_awarded, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      users.forEach((user) => {
        weeks.forEach((week) => {
          let validDays = 0;
          let totalLogins = 0;
          let totalAwards = 0;
          let studentsAwarded = 0;
          week.days.forEach((day) => {
            const key = `${Number(user.id)}:${day.date}`;
            const loginCount = Number((loginByUserDate.get(key) || {}).login_count || 0);
            const award = awardByUserDate.get(key) || {};
            const awardCount = Number(award.award_count || 0);
            totalLogins += loginCount;
            totalAwards += awardCount;
            studentsAwarded += Number(award.student_count || 0);
            if (day.is_school_day && loginCount > 0 && awardCount > 0) validDays += 1;
          });
          insertWeekly.run(
            runId,
            Number(user.id),
            String(user.username || ""),
            String(user.display_name || user.username || "User"),
            week.start,
            week.end,
            week.school_day_count,
            week.required_days,
            validDays,
            validDays >= week.required_days ? 1 : 0,
            totalLogins,
            totalAwards,
            studentsAwarded,
            startedAt
          );
        });
      });
    });
    tx();

    const finishedAt = dayjs().toISOString();
    db.prepare("UPDATE teacher_usage_audit_runs SET finished_at = ?, status = 'success', error_message = NULL WHERE id = ?")
      .run(finishedAt, runId);
    return {
      id: runId,
      trigger_type: triggerType,
      date_from: dateFrom.format("YYYY-MM-DD"),
      date_to: dateTo.format("YYYY-MM-DD"),
      started_at: startedAt,
      finished_at: finishedAt,
      status: "success",
      user_count: users.length,
      week_count: weeks.length
    };
  } catch (error) {
    db.prepare("UPDATE teacher_usage_audit_runs SET finished_at = ?, status = 'failed', error_message = ? WHERE id = ?")
      .run(dayjs().toISOString(), error.message || String(error), runId);
    throw error;
  } finally {
    auditInProgress = false;
  }
}

function getLatestTeacherUsageAudit() {
  return db.prepare(`
    SELECT id, trigger_type, date_from, date_to, started_at, finished_at, status, error_message
    FROM teacher_usage_audit_runs
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `).get() || null;
}

function shouldRunAutomaticAudit(now = dayjs()) {
  if (now.day() !== AUDIT_DAY_OF_WEEK) return false;
  const [hour, minute] = AUDIT_TIME.split(":").map(Number);
  const dueAt = now.hour(hour).minute(minute).second(0).millisecond(0);
  if (now.isBefore(dueAt)) return false;
  const todayKey = now.format("YYYY-MM-DD");
  const existing = db.prepare(`
    SELECT id
    FROM teacher_usage_audit_runs
    WHERE trigger_type = 'auto' AND status = 'success' AND substr(started_at, 1, 10) = ?
    LIMIT 1
  `).get(todayKey);
  return !existing;
}

function checkAutomaticTeacherUsageAudit() {
  if (auditInProgress || !shouldRunAutomaticAudit()) return;
  try {
    runTeacherUsageAudit({ trigger_type: "auto" });
  } catch (error) {
    console.error("Teacher usage audit failed:", error.message || error);
  }
}

function initializeTeacherUsageAuditScheduler() {
  if (auditTimer) clearInterval(auditTimer);
  auditTimer = setInterval(checkAutomaticTeacherUsageAudit, 30 * 60 * 1000);
  setTimeout(checkAutomaticTeacherUsageAudit, 5000);
}

module.exports = {
  AUDIT_TIME,
  getLatestTeacherUsageAudit,
  getTeacherUsageDateBounds,
  initializeTeacherUsageAuditScheduler,
  runTeacherUsageAudit
};
