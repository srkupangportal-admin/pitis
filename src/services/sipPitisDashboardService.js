const dayjs = require("dayjs");
const { db } = require("../db/init");

const SCHOOL_DAY_NUMBERS = new Set([1, 2, 3, 4, 6]);
const SCHOOL_DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Saturday"];
const TERM_TARGETS_DEFAULT = { 1: 11, 2: 13, 3: 15, 4: 17 };
const DEFAULT_EXCLUDED_USERNAMES = ["portaladmin"];
const DEFAULT_TEACHER_TARGET_TOTAL = 19;

const SCHOOL_TERMS_2026 = [
  { term: 1, start: "2026-01-03", end: "2026-03-12" },
  { term: 2, start: "2026-03-30", end: "2026-05-28" },
  { term: 3, start: "2026-06-08", end: "2026-08-06" },
  { term: 4, start: "2026-08-24", end: "2026-11-30" }
];

const TERM_HOLIDAYS_2026 = [
  { title: "Term Holiday 1", start: "2026-03-13", end: "2026-03-29" },
  { title: "Term Holiday 2", start: "2026-05-29", end: "2026-06-07" },
  { title: "Term Holiday 3", start: "2026-08-07", end: "2026-08-23" },
  { title: "Term Holiday 4", start: "2026-12-01", end: "2026-12-31" }
];

const PUBLIC_HOLIDAYS_2026 = [
  { title: "New Year's Day", start: "2026-01-01", end: "2026-01-01" },
  { title: "Isra' and Mi'raj", start: "2026-01-16", end: "2026-01-17" },
  { title: "Chinese New Year", start: "2026-02-17", end: "2026-02-17" },
  { title: "National Day", start: "2026-02-23", end: "2026-02-23" },
  { title: "First Day of Ramadan", start: "2026-03-01", end: "2026-03-01" },
  { title: "Nuzul Al-Quran", start: "2026-03-07", end: "2026-03-07" },
  { title: "Hari Raya Aidilfitri", start: "2026-03-20", end: "2026-03-24" },
  { title: "Hari Raya Aidiladha", start: "2026-05-27", end: "2026-05-27" },
  { title: "Royal Brunei Armed Forces Day", start: "2026-05-31", end: "2026-05-31" },
  { title: "Islamic New Year", start: "2026-06-17", end: "2026-06-17" },
  { title: "His Majesty the Sultan's Birthday", start: "2026-07-15", end: "2026-07-15" },
  { title: "Prophet Muhammad's Birthday", start: "2026-08-25", end: "2026-08-25" },
  { title: "Christmas Day", start: "2026-12-25", end: "2026-12-25" }
];

function parseJson(value, fallback) {
  try {
    if (value == null || value === "") return fallback;
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function getSetting(key, fallback) {
  const row = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(key);
  return row ? row.setting_value : fallback;
}

function setSetting(key, value, updatedBy) {
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(key, String(value), dayjs().toISOString(), updatedBy || null);
}

function normalizeIsoDate(value, fallback) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : fallback;
}

function getLatestLivePitisLogDate() {
  const row = db.prepare(`
    SELECT MAX(date(awarded_at, '+8 hours')) AS latest_date
    FROM point_logs
    WHERE awarded_at IS NOT NULL
  `).get() || {};
  return normalizeIsoDate(row.latest_date, dayjs().format("YYYY-MM-DD"));
}

function resolveDashboardAsOfDate(value) {
  const raw = String(value || "").trim();
  if (raw) return normalizeIsoDate(raw, getLatestLivePitisLogDate());
  return getLatestLivePitisLogDate();
}

function getMondayKey(dateValue) {
  const date = dayjs(dateValue);
  return date.subtract((date.day() + 6) % 7, "day").format("YYYY-MM-DD");
}

function expandRanges(items) {
  const map = new Map();
  items.forEach((item) => {
    let cursor = dayjs(item.start);
    const end = dayjs(item.end || item.start);
    while (!cursor.isAfter(end, "day")) {
      map.set(cursor.format("YYYY-MM-DD"), item.title);
      cursor = cursor.add(1, "day");
    }
  });
  return map;
}

const PUBLIC_HOLIDAY_DATES = expandRanges(PUBLIC_HOLIDAYS_2026);
const TERM_HOLIDAY_DATES = expandRanges(TERM_HOLIDAYS_2026);

function getSchoolCalendarDayMap() {
  const rows = db.prepare(`
    SELECT calendar_date, term_number, is_school_day, is_public_holiday,
           is_term_holiday, is_available_for_pitis, event_type,
           holiday_name, exclusion_reason, notes, source
    FROM calendar_school_days
    WHERE calendar_year = 2026
  `).all();
  return new Map(rows.map((row) => [String(row.calendar_date), row]));
}

function findTerm(dateValue) {
  return SCHOOL_TERMS_2026.find((term) => (
    !dayjs(dateValue).isBefore(dayjs(term.start), "day")
    && !dayjs(dateValue).isAfter(dayjs(term.end), "day")
  )) || null;
}

function classifyDate(dateValue, todayValue, schoolCalendarDays = null) {
  const date = dayjs(dateValue);
  const calendarDay = schoolCalendarDays ? schoolCalendarDays.get(dateValue) : null;
  const configuredTerm = Number(calendarDay && calendarDay.term_number ? calendarDay.term_number : 0);
  const term = configuredTerm
    ? SCHOOL_TERMS_2026.find((item) => Number(item.term) === configuredTerm)
    : findTerm(dateValue);
  const dayNumber = date.day();
  const publicHoliday = calendarDay && Number(calendarDay.is_public_holiday) === 1
    ? (calendarDay.holiday_name || calendarDay.exclusion_reason || "Public Holiday")
    : PUBLIC_HOLIDAY_DATES.get(dateValue);
  const termHoliday = calendarDay && Number(calendarDay.is_term_holiday) === 1
    ? (calendarDay.holiday_name || calendarDay.exclusion_reason || "Term Holiday")
    : TERM_HOLIDAY_DATES.get(dateValue);
  let type = "non_school_day";
  let label = dayNumber === 5 ? "Friday" : dayNumber === 0 ? "Sunday" : "Outside Term";
  if (termHoliday) {
    type = "term_holiday";
    label = termHoliday;
  } else if (publicHoliday) {
    type = "public_holiday";
    label = publicHoliday;
  } else if (calendarDay && Number(calendarDay.is_school_day) === 1 && Number(calendarDay.is_available_for_pitis) !== 1) {
    label = String(calendarDay.exclusion_reason || calendarDay.notes || "Excluded school day").trim();
    type = /exam|assessment/i.test(label) ? "exam_day" : "excluded_school_day";
  } else if (calendarDay && Number(calendarDay.is_school_day) === 1 && Number(calendarDay.is_available_for_pitis) === 1) {
    type = "school_day";
    label = "Normal School Day";
  } else if (term && SCHOOL_DAY_NUMBERS.has(dayNumber)) {
    type = "school_day";
    label = "Normal School Day";
  }
  return {
    date: dateValue,
    label: date.format("dddd"),
    shortLabel: date.format("ddd"),
    term: term ? Number(term.term) : null,
    type,
    exclusionReason: type === "school_day" ? "" : label,
    calendarSource: calendarDay ? String(calendarDay.source || "school_calendar") : "official_fallback",
    isFuture: dayjs(dateValue).isAfter(dayjs(todayValue), "day")
  };
}

function buildOfficialWeeks(todayValue = dayjs().format("YYYY-MM-DD")) {
  const weekMap = new Map();
  const schoolCalendarDays = getSchoolCalendarDayMap();
  SCHOOL_TERMS_2026.forEach((term) => {
    let cursor = dayjs(getMondayKey(term.start));
    const last = dayjs(getMondayKey(term.end));
    while (!cursor.isAfter(last, "day")) {
      const weekKey = cursor.format("YYYY-MM-DD");
      if (!weekMap.has(weekKey)) {
        weekMap.set(weekKey, {
          weekKey,
          start: weekKey,
          end: cursor.add(5, "day").format("YYYY-MM-DD"),
          term: Number(term.term),
          days: []
        });
      }
      const week = weekMap.get(weekKey);
      week.days = [0, 1, 2, 3, 5].map((offset) => classifyDate(
        cursor.add(offset, "day").format("YYYY-MM-DD"),
        todayValue,
        schoolCalendarDays
      ));
      cursor = cursor.add(7, "day");
    }
  });

  const weeks = Array.from(weekMap.values())
    .filter((week) => week.days.some((day) => day.term === week.term || day.type === "term_holiday"))
    .sort((a, b) => a.start.localeCompare(b.start));

  const termCounters = new Map();
  weeks.forEach((week, index) => {
    termCounters.set(week.term, Number(termCounters.get(week.term) || 0) + 1);
    const availableDays = week.days.filter((day) => day.type === "school_day");
    week.weekNumber = index + 1;
    week.termWeekNumber = termCounters.get(week.term);
    week.availableSchoolDays = availableDays.length;
    week.requiredDays = availableDays.length > 0 ? Math.ceil(availableDays.length * 0.6) : 0;
    week.rangeLabel = `${dayjs(week.start).format("DD MMM")} - ${dayjs(week.end).format("DD MMM YYYY")}`;
  });
  return weeks;
}

function getSipPitisSettings() {
  const targets = parseJson(getSetting("sip_pitis_term_targets", ""), TERM_TARGETS_DEFAULT);
  const excluded = parseJson(getSetting("sip_pitis_excluded_usernames", ""), DEFAULT_EXCLUDED_USERNAMES);
  const selectedTeacherIds = parseJson(getSetting("sip_pitis_teacher_user_ids", ""), null);
  const teacherTargetTotal = Number(getSetting("sip_pitis_teacher_target_total", DEFAULT_TEACHER_TARGET_TOTAL)) || DEFAULT_TEACHER_TARGET_TOTAL;
  return {
    termTargets: { ...TERM_TARGETS_DEFAULT, ...targets },
    excludedUsernames: Array.isArray(excluded) ? excluded.map((name) => String(name).trim().toLowerCase()).filter(Boolean) : DEFAULT_EXCLUDED_USERNAMES,
    selectedTeacherIds: Array.isArray(selectedTeacherIds) ? selectedTeacherIds.map(Number).filter(Number.isInteger) : null,
    teacherTargetTotal
  };
}

function getAllPortalTeacherCandidates() {
  return db.prepare(`
    SELECT id, username, display_name, role,
           COALESCE(user_type, CASE WHEN role = 'staff' THEN 'staff' ELSE role END) AS user_type
    FROM users
    WHERE COALESCE(is_active, 1) = 1
      AND LOWER(COALESCE(role, '')) <> 'admin'
      AND LOWER(COALESCE(user_type, '')) <> 'admin'
    ORDER BY display_name COLLATE NOCASE ASC, username COLLATE NOCASE ASC
  `).all().map((row) => ({
    id: Number(row.id),
    username: String(row.username || "").trim(),
    display_name: String(row.display_name || row.username || "User").trim(),
    role: String(row.role || "").trim(),
    user_type: String(row.user_type || row.role || "").trim()
  }));
}

function getSipTeacherUsers(settings = getSipPitisSettings()) {
  const candidates = getAllPortalTeacherCandidates();
  const excluded = new Set(settings.excludedUsernames || DEFAULT_EXCLUDED_USERNAMES);
  const selected = settings.selectedTeacherIds ? new Set(settings.selectedTeacherIds) : null;
  return candidates.filter((user) => {
    if (excluded.has(String(user.username || "").toLowerCase())) return false;
    return selected ? selected.has(Number(user.id)) : true;
  });
}

function saveSipPitisSettings(body, adminUserId) {
  const targets = {};
  [1, 2, 3, 4].forEach((term) => {
    const value = Number.parseInt(String(body[`target_term_${term}`] || ""), 10);
    targets[term] = Number.isInteger(value) && value >= 0 ? value : TERM_TARGETS_DEFAULT[term];
  });
  const excludedUsernames = String(body.excluded_usernames || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const teacherIds = (Array.isArray(body.teacher_user_ids) ? body.teacher_user_ids : [body.teacher_user_ids])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const teacherTargetTotal = Number.parseInt(String(body.teacher_target_total || ""), 10);
  setSetting("sip_pitis_term_targets", JSON.stringify(targets), adminUserId);
  setSetting("sip_pitis_excluded_usernames", JSON.stringify(excludedUsernames.length ? excludedUsernames : DEFAULT_EXCLUDED_USERNAMES), adminUserId);
  setSetting("sip_pitis_teacher_user_ids", JSON.stringify(Array.from(new Set(teacherIds))), adminUserId);
  setSetting("sip_pitis_teacher_target_total", Number.isInteger(teacherTargetTotal) && teacherTargetTotal > 0 ? teacherTargetTotal : DEFAULT_TEACHER_TARGET_TOTAL, adminUserId);
  return getSipPitisSettings();
}

function fetchActivityRows(userIds, startDate, endDate) {
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT awarded_by AS user_id,
           date(awarded_at, '+8 hours') AS activity_date,
           COUNT(*) AS transaction_count,
           COUNT(DISTINCT student_id) AS students_rewarded,
           COALESCE(SUM(points), 0) AS points_awarded,
           COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 0 END), 0) AS positive_points_awarded
    FROM point_logs
    WHERE awarded_by IN (${placeholders})
      AND date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    GROUP BY awarded_by, date(awarded_at, '+8 hours')
    ORDER BY date(awarded_at, '+8 hours') ASC
  `).all(...userIds, startDate, endDate);
}

function activityMap(rows) {
  const map = new Map();
  rows.forEach((row) => map.set(`${Number(row.user_id)}:${row.activity_date}`, row));
  return map;
}

function getWeeklyStatus(week, activeDays, todayValue) {
  if (week.availableSchoolDays <= 0) return "Excluded";
  const today = dayjs(todayValue);
  if (week.days.filter((day) => day.type === "school_day").every((day) => dayjs(day.date).isAfter(today, "day"))) return "Future";
  if (activeDays >= week.requiredDays) return "Met";
  const ended = dayjs(week.end).isBefore(today, "day");
  if (ended) return "Missed";
  const remaining = week.days.filter((day) => day.type === "school_day" && !dayjs(day.date).isBefore(today, "day")).length;
  return activeDays + remaining >= week.requiredDays ? "Still Possible" : "At Risk";
}

function streaks(weeks) {
  let current = 0;
  let longest = 0;
  weeks.forEach((week) => {
    if (week.status === "Met") {
      current += 1;
      longest = Math.max(longest, current);
    } else if (week.status === "Missed") {
      current = 0;
    }
  });
  return { current, longest };
}

function trendForWeeks(weeks) {
  const completed = weeks.filter((week) => week.status === "Met" || week.status === "Missed");
  if (completed.length < 4) return "Steady";
  const midpoint = Math.floor(completed.length / 2);
  const first = completed.slice(0, midpoint);
  const second = completed.slice(midpoint);
  const firstRate = first.filter((week) => week.status === "Met").length / Math.max(1, first.length);
  const secondRate = second.filter((week) => week.status === "Met").length / Math.max(1, second.length);
  if (secondRate - firstRate >= 0.15) return "Improving";
  if (firstRate - secondRate >= 0.15) return "Declining";
  return "Steady";
}

function buildTeacherWeeks(teacher, weeks, activityByDate, todayValue) {
  const weekly = weeks.map((week) => {
    const days = week.days.map((day) => {
      const activity = activityByDate.get(`${teacher.id}:${day.date}`) || {};
      const transactions = Number(activity.transaction_count || 0);
      const counted = day.type === "school_day" && transactions > 0;
      return {
        ...day,
        transactionCount: transactions,
        studentsRewarded: Number(activity.students_rewarded || 0),
        pointsAwarded: Number(activity.points_awarded || 0),
        positivePointsAwarded: Number(activity.positive_points_awarded || 0),
        counted,
        dailyStatus: day.isFuture ? "Future" : counted ? "PITIS Awarded" : day.type === "school_day" ? "No PITIS" : day.exclusionReason
      };
    });
    const activeDays = days.filter((day) => day.counted).length;
    const usageDayDetails = days.filter((day) => day.transactionCount > 0).map((day) => ({
      date: day.date,
      label: day.label,
      shortLabel: day.shortLabel,
      transactionCount: day.transactionCount,
      studentsRewarded: day.studentsRewarded,
      pointsAwarded: day.pointsAwarded,
      counted: day.counted,
      exclusionReason: day.counted ? "" : day.exclusionReason
    }));
    const status = getWeeklyStatus(week, activeDays, todayValue);
    return {
      ...week,
      days,
      activeDays,
      usageDays: usageDayDetails.length,
      usageDayDetails,
      totalTransactions: days.reduce((sum, day) => sum + day.transactionCount, 0),
      totalStudentsRewarded: days.reduce((sum, day) => sum + day.studentsRewarded, 0),
      totalPointsAwarded: days.reduce((sum, day) => sum + day.pointsAwarded, 0),
      excludedUsageDays: usageDayDetails.filter((day) => !day.counted).length,
      status,
      achievementRate: week.requiredDays > 0 ? Math.min(100, Math.round((activeDays / week.requiredDays) * 100)) : 0
    };
  });
  const completed = weekly.filter((week) => week.status === "Met" || week.status === "Missed");
  const metCompleted = completed.filter((week) => week.status === "Met").length;
  const teacherStreaks = streaks(weekly);
  return {
    ...teacher,
    weeks: weekly,
    completedWeeks: completed.length,
    metCompletedWeeks: metCompleted,
    termPercentage: completed.length ? Math.round((metCompleted / completed.length) * 100) : 0,
    currentStreak: teacherStreaks.current,
    longestStreak: teacherStreaks.longest,
    trend: trendForWeeks(weekly)
  };
}

function filterWeeks(weeks, filters) {
  let filtered = weeks;
  if (filters.term && filters.term !== "all") filtered = filtered.filter((week) => Number(week.term) === Number(filters.term));
  if (filters.weekLimit && filters.weekLimit !== "all") filtered = filtered.slice(-Number(filters.weekLimit));
  return filtered;
}

function parseTeacherIdFilter(rawTeacherIds, allowedIds) {
  const values = Array.isArray(rawTeacherIds) ? rawTeacherIds : [rawTeacherIds];
  const ids = values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isInteger(id) && allowedIds.has(id));
  return Array.from(new Set(ids));
}

function buildSipPitisDashboard(query = {}) {
  const settings = getSipPitisSettings();
  const todayValue = resolveDashboardAsOfDate(query.asOf);
  const allWeeks = buildOfficialWeeks(todayValue);
  const allTeachers = query.includeAllTeachers
    ? getAllPortalTeacherCandidates().filter((user) => (
      String(user.role || "").toLowerCase() === "teacher"
      && String(user.user_type || "").toLowerCase() === "teacher"
    ))
    : getSipTeacherUsers(settings);
  const allowedTeacherIds = new Set(allTeachers.map((teacher) => Number(teacher.id)));
  const filteredTeacherIds = parseTeacherIdFilter(query.teacherIds, allowedTeacherIds);
  const hasTeacherFilter = Object.prototype.hasOwnProperty.call(query, "teacherFilter") || Object.prototype.hasOwnProperty.call(query, "teacherIds");
  const selectedTeacherIds = hasTeacherFilter ? filteredTeacherIds : allTeachers.map((teacher) => Number(teacher.id));
  const selectedTeacherIdSet = new Set(selectedTeacherIds);
  const teachers = allTeachers.filter((teacher) => selectedTeacherIdSet.has(Number(teacher.id)));
  const userIds = teachers.map((user) => Number(user.id));
  const firstDate = allWeeks[0] ? allWeeks[0].start : "2026-01-01";
  const lastDate = allWeeks[allWeeks.length - 1] ? allWeeks[allWeeks.length - 1].end : "2026-12-31";
  const activityRows = fetchActivityRows(userIds, firstDate, lastDate);
  const activity = activityMap(activityRows);
  const currentWeek = allWeeks.find((week) => !dayjs(todayValue).isBefore(dayjs(week.start), "day") && !dayjs(todayValue).isAfter(dayjs(week.end), "day"))
    || allWeeks.find((week) => week.days.some((day) => day.date === todayValue));
  const currentTerm = currentWeek ? currentWeek.term : (SCHOOL_TERMS_2026.find((term) => !dayjs(todayValue).isBefore(dayjs(term.start), "day") && !dayjs(todayValue).isAfter(dayjs(term.end), "day")) || {}).term || 1;
  const selectedTerm = String(query.term || currentTerm) === "all" ? currentTerm : Number(query.term || currentTerm);
  const selectedTermRange = SCHOOL_TERMS_2026.find((term) => Number(term.term) === Number(selectedTerm)) || SCHOOL_TERMS_2026[0];
  const filteredWeeks = filterWeeks(allWeeks, {
    term: selectedTerm,
    weekLimit: query.weeks || "all"
  });
  const termPitisByTeacher = new Map();
  activityRows.forEach((row) => {
    if (dayjs(row.activity_date).isBefore(dayjs(selectedTermRange.start), "day") || dayjs(row.activity_date).isAfter(dayjs(selectedTermRange.end), "day")) return;
    const userId = Number(row.user_id);
    termPitisByTeacher.set(userId, Number(termPitisByTeacher.get(userId) || 0) + Number(row.positive_points_awarded || 0));
  });
  const teacherReports = teachers.map((teacher) => ({
    ...buildTeacherWeeks(teacher, filteredWeeks, activity, todayValue),
    termPitisAwarded: Number(termPitisByTeacher.get(Number(teacher.id)) || 0)
  }));
  const completedTermWeeks = filteredWeeks.filter((week) => dayjs(week.end).isBefore(dayjs(todayValue), "day") && week.availableSchoolDays > 0);
  const onTrack = teacherReports.filter((teacher) => {
    const completed = teacher.weeks.filter((week) => (week.status === "Met" || week.status === "Missed") && completedTermWeeks.some((w) => w.weekKey === week.weekKey));
    if (!completed.length) return false;
    return completed.filter((week) => week.status === "Met").length / completed.length >= 0.8;
  }).length;
  const target = Number(settings.termTargets[selectedTerm] || 0);
  const totalCompletedTeacherWeeks = teacherReports.reduce((sum, teacher) => sum + teacher.weeks.filter((week) => week.status === "Met" || week.status === "Missed").length, 0);
  const metCompletedTeacherWeeks = teacherReports.reduce((sum, teacher) => sum + teacher.weeks.filter((week) => week.status === "Met").length, 0);
  const weeklyChart = filteredWeeks.map((week) => {
    const meeting = teacherReports.filter((teacher) => (teacher.weeks.find((w) => w.weekKey === week.weekKey) || {}).status === "Met").length;
    const missing = teacherReports.filter((teacher) => {
      const status = (teacher.weeks.find((w) => w.weekKey === week.weekKey) || {}).status;
      return status === "Missed" || status === "At Risk";
    }).length;
    return { ...week, meeting, missing, total: teachers.length };
  });
  const calendarExclusions = filteredWeeks.flatMap((week) => week.days
    .filter((day) => day.term === week.term && day.type !== "school_day")
    .map((day) => ({
      date: day.date,
      day: day.label,
      type: day.type,
      reason: day.exclusionReason,
      weekNumber: week.weekNumber
    })));
  const statusFilter = String(query.status || "all");
  const minUsage = String(query.usageDays || "all");
  let visibleTeacherReports = teacherReports;
  if (statusFilter !== "all") {
    visibleTeacherReports = visibleTeacherReports.filter((teacher) => teacher.weeks.some((week) => week.status.toLowerCase().replace(/\s+/g, "_") === statusFilter));
  }
  if (minUsage !== "all" && minUsage !== "") {
    const min = Number(minUsage);
    visibleTeacherReports = visibleTeacherReports.filter((teacher) => teacher.weeks.some((week) => week.activeDays >= min));
  }
  return {
    settings,
    allTeachers,
    teachers,
    teacherReports: visibleTeacherReports,
    allTeacherReports: teacherReports,
    weeks: filteredWeeks,
    weeklyChart,
    calendarExclusions,
    currentTerm,
    currentWeek,
    filters: {
      term: String(selectedTerm),
      weeks: String(query.weeks || "all"),
      status: statusFilter,
      usageDays: minUsage,
      asOf: todayValue,
      teacherFilter: "1",
      teacherIds: selectedTeacherIds
    },
    kpis: {
      currentTerm: `Term ${currentTerm}`,
      currentWeek: currentWeek ? `Week ${currentWeek.weekNumber}` : "Outside Term",
      currentSipTarget: `${target} of ${settings.teacherTargetTotal}`,
      teachersOnTrack: onTrack,
      teachersNeedingSupport: Math.max(0, teachers.length - onTrack),
      schoolConsistency: totalCompletedTeacherWeeks ? Math.round((metCompletedTeacherWeeks / totalCompletedTeacherWeeks) * 100) : 0
    },
    sipTarget: {
      term: selectedTerm,
      target,
      denominator: settings.teacherTargetTotal,
      current: onTrack,
      status: onTrack >= target ? "Achieved" : onTrack >= Math.max(0, target - 2) ? "Nearly Achieved" : "Needs Support"
    },
    pdfInterpretation: "The maintained 2026 school calendar determines available PITIS days. Public holidays, term holidays, examinations, and other administrator-marked exclusions do not count toward the 60% weekly requirement."
  };
}

function buildSipPitisTeacherJourney(userId, query = {}) {
  const dashboard = buildSipPitisDashboard(query);
  const teacher = dashboard.allTeacherReports.find((row) => Number(row.id) === Number(userId));
  return teacher ? { dashboard, teacher } : null;
}

function dateWeekLookup(weeks) {
  const byDate = new Map();
  const byWeekKey = new Map();
  weeks.forEach((week) => {
    byWeekKey.set(week.weekKey, week);
    week.days.forEach((day) => byDate.set(day.date, { week, day }));
  });
  return { byDate, byWeekKey };
}

function buildSipPitisRawAudit(query = {}) {
  const settings = getSipPitisSettings();
  const todayValue = normalizeIsoDate(query.asOf, dayjs().format("YYYY-MM-DD"));
  const weeks = buildOfficialWeeks(todayValue);
  const teachers = getSipTeacherUsers(settings);
  const teacherMap = new Map(teachers.map((teacher) => [Number(teacher.id), teacher]));
  const startDate = normalizeIsoDate(query.from, weeks[0] ? weeks[0].start : "2026-01-01");
  const endDate = normalizeIsoDate(query.to, weeks[weeks.length - 1] ? weeks[weeks.length - 1].end : "2026-12-31");
  const rows = fetchActivityRows(teachers.map((teacher) => teacher.id), startDate, endDate);
  const lookup = dateWeekLookup(weeks);
  const schoolCalendarDays = getSchoolCalendarDayMap();
  const auditRows = rows.map((row) => {
    const directMatch = lookup.byDate.get(row.activity_date);
    const matchedWeek = directMatch ? directMatch.week : lookup.byWeekKey.get(getMondayKey(row.activity_date));
    const match = matchedWeek ? { week: matchedWeek, day: directMatch ? directMatch.day : classifyDate(row.activity_date, todayValue, schoolCalendarDays) } : null;
    const teacher = teacherMap.get(Number(row.user_id)) || {};
    const counted = !!(match && match.day.type === "school_day");
    return {
      teacher: teacher.display_name || teacher.username || `User ${row.user_id}`,
      username: teacher.username || "",
      date: row.activity_date,
      day: dayjs(row.activity_date).format("dddd"),
      weekNumber: match ? match.week.weekNumber : "",
      term: match ? match.week.term : "",
      transactionCount: Number(row.transaction_count || 0),
      studentsRewarded: Number(row.students_rewarded || 0),
      pointsAwarded: Number(row.points_awarded || 0),
      counted,
      exclusionReason: counted ? "" : (match ? match.day.exclusionReason : "Outside official school term")
    };
  });
  return { rows: auditRows, teachers, settings, filters: { from: startDate, to: endDate } };
}

function csv(rows, headers) {
  return [headers.map((h) => h.label), ...rows.map((row) => headers.map((h) => row[h.key]))]
    .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`).join(","))
    .join("\n");
}

function sipDashboardToCsv(dashboard) {
  const rows = [];
  dashboard.allTeacherReports.forEach((teacher) => {
    teacher.weeks.forEach((week) => rows.push({
      teacher: teacher.display_name,
      username: teacher.username,
      term: week.term,
      week: week.weekNumber,
      range: week.rangeLabel,
      available: week.availableSchoolDays,
      required: week.requiredDays,
      active: week.activeDays,
      usageDays: week.usageDays,
      usageDates: week.usageDayDetails.map((day) => `${day.shortLabel} ${day.date}${day.counted ? "" : ` (excluded: ${day.exclusionReason})`}`).join("; "),
      transactions: week.totalTransactions,
      studentsRewarded: week.totalStudentsRewarded,
      pointsAwarded: week.totalPointsAwarded,
      status: week.status,
      termPercentage: `${teacher.termPercentage}%`,
      termPitisAwarded: teacher.termPitisAwarded,
      currentStreak: teacher.currentStreak,
      longestStreak: teacher.longestStreak
    }));
  });
  return csv(rows, [
    { key: "teacher", label: "Teacher" },
    { key: "username", label: "Username" },
    { key: "term", label: "Term" },
    { key: "week", label: "Week Number" },
    { key: "range", label: "Week Range" },
    { key: "available", label: "Available School Days" },
    { key: "required", label: "Required Days" },
    { key: "active", label: "Teacher Active Days" },
    { key: "usageDays", label: "Days PITIS Was Used" },
    { key: "usageDates", label: "PITIS Usage Days and Dates" },
    { key: "transactions", label: "PITIS Transactions" },
    { key: "studentsRewarded", label: "Student Recipients (Daily Total)" },
    { key: "pointsAwarded", label: "PITIS Points Awarded" },
    { key: "status", label: "Status" },
    { key: "termPercentage", label: "Term %" },
    { key: "termPitisAwarded", label: "Term PITIS Awarded" },
    { key: "currentStreak", label: "Current Streak" },
    { key: "longestStreak", label: "Longest Streak" }
  ]);
}

function sipRawAuditToCsv(audit) {
  return csv(audit.rows, [
    { key: "teacher", label: "Teacher" },
    { key: "username", label: "Username" },
    { key: "date", label: "Date" },
    { key: "day", label: "Day" },
    { key: "weekNumber", label: "Week Number" },
    { key: "term", label: "Term" },
    { key: "transactionCount", label: "Number of PITIS transactions" },
    { key: "studentsRewarded", label: "Students rewarded" },
    { key: "pointsAwarded", label: "Points awarded" },
    { key: "counted", label: "Counted" },
    { key: "exclusionReason", label: "Exclusion reason" }
  ]);
}

module.exports = {
  SCHOOL_TERMS_2026,
  TERM_HOLIDAYS_2026,
  PUBLIC_HOLIDAYS_2026,
  buildOfficialWeeks,
  buildSipPitisDashboard,
  buildSipPitisTeacherJourney,
  buildSipPitisRawAudit,
  getAllPortalTeacherCandidates,
  getSipPitisSettings,
  saveSipPitisSettings,
  sipDashboardToCsv,
  sipRawAuditToCsv
};
