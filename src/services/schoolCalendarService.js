const dayjs = require("dayjs");
const { db } = require("../db/init");

const SCHOOL_CALENDAR_YEAR = 2026;
const SCHOOL_DAY_NUMBERS = new Set([1, 2, 3, 4, 6]);

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
  { title: "New Year's Day", start: "2026-01-01", end: "2026-01-01", editable: 0 },
  { title: "Isra' and Mi'raj", start: "2026-01-16", end: "2026-01-17", editable: 1 },
  { title: "Chinese New Year", start: "2026-02-17", end: "2026-02-17", editable: 0 },
  { title: "National Day", start: "2026-02-23", end: "2026-02-23", editable: 0 },
  { title: "First Day of Ramadan", start: "2026-03-01", end: "2026-03-01", editable: 1 },
  { title: "Nuzul Al-Quran", start: "2026-03-07", end: "2026-03-07", editable: 1 },
  { title: "Hari Raya Aidilfitri", start: "2026-03-20", end: "2026-03-24", editable: 1 },
  { title: "Hari Raya Aidiladha", start: "2026-05-27", end: "2026-05-27", editable: 1 },
  { title: "Royal Brunei Armed Forces Day", start: "2026-05-31", end: "2026-05-31", editable: 0 },
  { title: "Islamic New Year", start: "2026-06-17", end: "2026-06-17", editable: 1 },
  { title: "His Majesty the Sultan's Birthday", start: "2026-07-15", end: "2026-07-15", editable: 0 },
  { title: "Prophet Muhammad's Birthday", start: "2026-08-25", end: "2026-08-25", editable: 1 },
  { title: "Christmas Day", start: "2026-12-25", end: "2026-12-25", editable: 0 }
];

function dateRange(start, end) {
  const dates = [];
  let cursor = dayjs(start);
  const last = dayjs(end);
  while (!cursor.isAfter(last, "day")) {
    dates.push(cursor.format("YYYY-MM-DD"));
    cursor = cursor.add(1, "day");
  }
  return dates;
}

function findTerm(date) {
  return SCHOOL_TERMS_2026.find((term) => !dayjs(date).isBefore(dayjs(term.start), "day") && !dayjs(date).isAfter(dayjs(term.end), "day")) || null;
}

function findRangeItem(items, date) {
  return items.find((item) => !dayjs(date).isBefore(dayjs(item.start), "day") && !dayjs(date).isAfter(dayjs(item.end), "day")) || null;
}

function getMondayKey(date) {
  const d = dayjs(date);
  return d.subtract((d.day() + 6) % 7, "day").format("YYYY-MM-DD");
}

function ensureCalendarLabel(name, color, description, createdBy = null) {
  const existing = db.prepare("SELECT id FROM calendar_labels WHERE name = ?").get(name);
  if (existing) return Number(existing.id);
  const info = db.prepare(`
    INSERT INTO calendar_labels (name, color, description, created_by, is_system, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(name, color, description, createdBy, dayjs().toISOString());
  return Number(info.lastInsertRowid);
}

function insertCalendarEventIfMissing(item, eventType, labelId, createdBy) {
  const existing = db.prepare(`
    SELECT id FROM calendar_events
    WHERE is_deleted = 0
      AND event_source = 'moe_2026'
      AND event_type = ?
      AND title = ?
      AND event_date = ?
      AND COALESCE(end_date, event_date) = ?
    LIMIT 1
  `).get(eventType, item.title, item.start, item.end);
  if (existing) return Number(existing.id);

  const now = dayjs().toISOString();
  const info = db.prepare(`
    INSERT INTO calendar_events
      (title, details, event_date, end_date, event_source, created_by, created_at, is_deleted,
       event_type, is_school_day, is_available_for_pitis, editable_flag, notes)
    VALUES (?, ?, ?, ?, 'moe_2026', ?, ?, 0, ?, 0, 0, ?, ?)
  `).run(
    item.title,
    eventType === "public_holiday"
      ? "Official 2026 Brunei public holiday"
      : eventType === "school_term"
        ? "Official 2026 MOE school term"
        : "Official 2026 MOE term holiday",
    item.start,
    item.end,
    createdBy,
    now,
    eventType,
    item.editable == null ? 1 : Number(item.editable),
    "Seeded from official 2026 school calendar"
  );
  const eventId = Number(info.lastInsertRowid);
  db.prepare("INSERT OR IGNORE INTO calendar_event_labels (event_id, label_id) VALUES (?, ?)").run(eventId, labelId);
  return eventId;
}

function recomputeSchoolWeeks() {
  const rows = db.prepare(`
    SELECT calendar_date, term_number, is_school_day, is_public_holiday, is_term_holiday,
           is_available_for_pitis
    FROM calendar_school_days
    WHERE calendar_year = ?
    ORDER BY calendar_date ASC
  `).all(SCHOOL_CALENDAR_YEAR);

  const update = db.prepare(`
    UPDATE calendar_school_days
    SET school_week_number = ?
    WHERE calendar_date = ?
  `);

  let weekNumber = 0;
  let activeWeekKey = "";
  const tx = db.transaction(() => {
    rows.forEach((row) => {
      const available = Number(row.is_school_day) === 1
        && Number(row.is_public_holiday) !== 1
        && Number(row.is_term_holiday) !== 1
        && Number(row.is_available_for_pitis) === 1
        && Number(row.term_number || 0) > 0;
      if (!available) {
        update.run(null, row.calendar_date);
        return;
      }
      const weekKey = `${row.term_number}:${getMondayKey(row.calendar_date)}`;
      if (weekKey !== activeWeekKey) {
        weekNumber += 1;
        activeWeekKey = weekKey;
      }
      update.run(weekNumber, row.calendar_date);
    });
  });
  tx();
}

function seedOfficialSchoolCalendar2026() {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) {
    console.warn("Official school calendar seed deferred until an administrator account exists.");
    return false;
  }
  const createdBy = Number(admin.id);
  const publicHolidayLabelId = ensureCalendarLabel("Public Holiday", "#d9534f", "Official public holiday", createdBy);
  const schoolTermLabelId = ensureCalendarLabel("School Term", "#2f855a", "Official school term", createdBy);
  const termHolidayLabelId = ensureCalendarLabel("Term Holiday", "#f0ad4e", "Official school term holiday", createdBy);
  ensureCalendarLabel(
    "School Closure",
    "#7c3aed",
    "An announced non-school day that is excluded from PITIS reporting and reminders",
    createdBy
  );

  PUBLIC_HOLIDAYS_2026.forEach((holiday) => insertCalendarEventIfMissing(holiday, "public_holiday", publicHolidayLabelId, createdBy));
  SCHOOL_TERMS_2026.forEach((term) => insertCalendarEventIfMissing({
    title: `School Term ${term.term}`,
    start: term.start,
    end: term.end,
    editable: 0
  }, "school_term", schoolTermLabelId, createdBy));
  TERM_HOLIDAYS_2026.forEach((holiday) => insertCalendarEventIfMissing({ ...holiday, editable: 0 }, "term_holiday", termHolidayLabelId, createdBy));

  const insertDay = db.prepare(`
    INSERT INTO calendar_school_days
      (calendar_date, calendar_year, day_name, term_number, school_week_number, is_school_day,
       is_public_holiday, is_term_holiday, is_available_for_pitis, event_type, holiday_name,
       exclusion_reason, notes, editable_flag, source, updated_at, updated_by)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'moe_2026', ?, ?)
    ON CONFLICT(calendar_date) DO UPDATE SET
      calendar_year = excluded.calendar_year,
      day_name = excluded.day_name,
      term_number = CASE WHEN calendar_school_days.source = 'moe_2026' THEN excluded.term_number ELSE calendar_school_days.term_number END,
      is_school_day = CASE WHEN calendar_school_days.source = 'moe_2026' THEN excluded.is_school_day ELSE calendar_school_days.is_school_day END,
      is_public_holiday = excluded.is_public_holiday,
      is_term_holiday = excluded.is_term_holiday,
      event_type = excluded.event_type,
      holiday_name = excluded.holiday_name,
      editable_flag = excluded.editable_flag
  `);

  const tx = db.transaction(() => {
    dateRange("2026-01-01", "2026-12-31").forEach((date) => {
      const d = dayjs(date);
      const term = findTerm(date);
      const publicHoliday = findRangeItem(PUBLIC_HOLIDAYS_2026, date);
      const termHoliday = findRangeItem(TERM_HOLIDAYS_2026, date);
      const isSchoolDay = !!term && SCHOOL_DAY_NUMBERS.has(d.day()) ? 1 : 0;
      const isPublicHoliday = publicHoliday ? 1 : 0;
      const isTermHoliday = termHoliday ? 1 : 0;
      const available = isSchoolDay && !isPublicHoliday && !isTermHoliday ? 1 : 0;
      const eventType = publicHoliday ? "public_holiday" : (termHoliday ? "term_holiday" : (isSchoolDay ? "normal_school_day" : "non_school_day"));
      const holidayName = publicHoliday ? publicHoliday.title : (termHoliday ? termHoliday.title : null);
      const editableFlag = publicHoliday ? Number(publicHoliday.editable) : 1;
      insertDay.run(
        date,
        SCHOOL_CALENDAR_YEAR,
        d.format("dddd"),
        term ? term.term : null,
        isSchoolDay,
        isPublicHoliday,
        isTermHoliday,
        available,
        eventType,
        holidayName,
        "Official 2026 school calendar",
        editableFlag,
        dayjs().toISOString(),
        createdBy
      );
    });
  });
  tx();
  synchronizeManualNonSchoolEvents(createdBy);
  return true;
}

function getOfficialDayValues(calendarDate) {
  const date = dayjs(calendarDate);
  const term = findTerm(calendarDate);
  const publicHoliday = findRangeItem(PUBLIC_HOLIDAYS_2026, calendarDate);
  const termHoliday = findRangeItem(TERM_HOLIDAYS_2026, calendarDate);
  const isSchoolDay = !!term && SCHOOL_DAY_NUMBERS.has(date.day()) ? 1 : 0;
  const isPublicHoliday = publicHoliday ? 1 : 0;
  const isTermHoliday = termHoliday ? 1 : 0;
  const isAvailable = isSchoolDay && !isPublicHoliday && !isTermHoliday ? 1 : 0;
  return {
    termNumber: term ? term.term : null,
    isSchoolDay,
    isPublicHoliday,
    isTermHoliday,
    isAvailable,
    eventType: publicHoliday
      ? "public_holiday"
      : termHoliday
        ? "term_holiday"
        : isSchoolDay
          ? "normal_school_day"
          : "non_school_day",
    holidayName: publicHoliday ? publicHoliday.title : (termHoliday ? termHoliday.title : null),
    editableFlag: publicHoliday ? Number(publicHoliday.editable) : 1
  };
}

function synchronizeManualNonSchoolEvents(updatedBy = null) {
  const eventRows = db.prepare(`
    SELECT ce.id, ce.title, ce.details, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date,
           ce.created_by, LOWER(TRIM(cl.name)) AS label_name
    FROM calendar_events ce
    JOIN users creator ON creator.id = ce.created_by AND creator.role = 'admin'
    JOIN calendar_event_labels cel ON cel.event_id = ce.id
    JOIN calendar_labels cl ON cl.id = cel.label_id
    WHERE ce.is_deleted = 0
      AND ce.event_source = 'manual'
      AND LOWER(TRIM(cl.name)) IN ('school closure', 'public holiday', 'term holiday', 'cuti penggal')
    ORDER BY CASE LOWER(TRIM(cl.name))
      WHEN 'public holiday' THEN 1
      WHEN 'term holiday' THEN 2
      WHEN 'cuti penggal' THEN 2
      ELSE 3
    END DESC, ce.id ASC
  `).all();

  const resetRows = db.prepare(`
    SELECT calendar_date
    FROM calendar_school_days
    WHERE calendar_year = ? AND source = 'calendar_event'
  `).all(SCHOOL_CALENDAR_YEAR);
  const resetDay = db.prepare(`
    UPDATE calendar_school_days
    SET term_number = ?, is_school_day = ?, is_public_holiday = ?, is_term_holiday = ?,
        is_available_for_pitis = ?, event_type = ?, holiday_name = ?, exclusion_reason = NULL,
        notes = 'Official 2026 school calendar', editable_flag = ?, source = 'moe_2026',
        updated_at = ?, updated_by = ?
    WHERE calendar_date = ? AND source = 'calendar_event'
  `);
  const applyEvent = db.prepare(`
    UPDATE calendar_school_days
    SET is_public_holiday = ?, is_term_holiday = ?, is_available_for_pitis = 0,
        event_type = ?, holiday_name = ?, exclusion_reason = ?, notes = ?,
        source = 'calendar_event', updated_at = ?, updated_by = ?
    WHERE calendar_date = ? AND calendar_year = ? AND source <> 'admin'
  `);
  const now = dayjs().toISOString();
  let affectedDays = 0;

  db.transaction(() => {
    resetRows.forEach(({ calendar_date: calendarDate }) => {
      const official = getOfficialDayValues(calendarDate);
      resetDay.run(
        official.termNumber,
        official.isSchoolDay,
        official.isPublicHoliday,
        official.isTermHoliday,
        official.isAvailable,
        official.eventType,
        official.holidayName,
        official.editableFlag,
        now,
        updatedBy || null,
        calendarDate
      );
    });

    eventRows.forEach((event) => {
      const isPublicHoliday = event.label_name === "public holiday" ? 1 : 0;
      const isTermHoliday = ["term holiday", "cuti penggal"].includes(event.label_name) ? 1 : 0;
      const eventType = isPublicHoliday ? "public_holiday" : (isTermHoliday ? "term_holiday" : "school_closure");
      dateRange(event.event_date, event.end_date).forEach((calendarDate) => {
        const result = applyEvent.run(
          isPublicHoliday,
          isTermHoliday,
          eventType,
          event.title,
          event.title,
          event.details || `Applied from calendar event #${event.id}`,
          now,
          updatedBy || event.created_by || null,
          calendarDate,
          SCHOOL_CALENDAR_YEAR
        );
        affectedDays += result.changes;
      });
    });
  })();

  recomputeSchoolWeeks();
  return { events: eventRows.length, affectedDays };
}

function getSchoolCalendarFilters(query = {}) {
  const month = String(query.sip_month || "").trim();
  const term = Number(query.sip_term || 0);
  const type = String(query.sip_type || "all").trim();
  return {
    month: /^\d{4}-\d{2}$/.test(month) ? month : "",
    term: Number.isInteger(term) && term >= 1 && term <= 4 ? term : 0,
    type: ["all", "school_day", "public_holiday", "term_holiday", "available", "excluded"].includes(type) ? type : "all"
  };
}

function getSchoolCalendarDashboard(filters = {}) {
  const where = ["calendar_year = ?"];
  const params = [SCHOOL_CALENDAR_YEAR];
  if (filters.month) {
    where.push("substr(calendar_date, 1, 7) = ?");
    params.push(filters.month);
  }
  if (filters.term) {
    where.push("term_number = ?");
    params.push(filters.term);
  }
  if (filters.type === "school_day") where.push("is_school_day = 1");
  if (filters.type === "public_holiday") where.push("is_public_holiday = 1");
  if (filters.type === "term_holiday") where.push("is_term_holiday = 1");
  if (filters.type === "available") where.push("is_available_for_pitis = 1");
  if (filters.type === "excluded") where.push("is_school_day = 1 AND is_available_for_pitis = 0");

  const days = db.prepare(`
    SELECT *
    FROM calendar_school_days
    WHERE ${where.join(" AND ")}
    ORDER BY calendar_date ASC
  `).all(...params);

  const weeks = db.prepare(`
    SELECT school_week_number AS week_number,
           MIN(calendar_date) AS start_date,
           MAX(calendar_date) AS end_date,
           COUNT(*) AS available_school_days
    FROM calendar_school_days
    WHERE calendar_year = ?
      AND school_week_number IS NOT NULL
      ${filters.term ? "AND term_number = ?" : ""}
    GROUP BY school_week_number
    ORDER BY school_week_number ASC
  `).all(...(filters.term ? [SCHOOL_CALENDAR_YEAR, filters.term] : [SCHOOL_CALENDAR_YEAR]));

  return {
    year: SCHOOL_CALENDAR_YEAR,
    filters,
    days,
    weeks,
    terms: SCHOOL_TERMS_2026,
    termHolidays: TERM_HOLIDAYS_2026,
    summary: {
      totalDays: days.length,
      schoolDays: days.filter((day) => Number(day.is_school_day) === 1).length,
      publicHolidays: days.filter((day) => Number(day.is_public_holiday) === 1).length,
      termHolidays: days.filter((day) => Number(day.is_term_holiday) === 1).length,
      availableDays: days.filter((day) => Number(day.is_available_for_pitis) === 1).length,
      excludedDays: days.filter((day) => Number(day.is_school_day) === 1 && Number(day.is_available_for_pitis) !== 1).length
    }
  };
}

function updateSchoolCalendarDay(input, updatedBy) {
  const calendarDate = String(input.calendar_date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate) || !dayjs(calendarDate).isValid()) {
    throw new Error("Valid calendar date is required");
  }
  const target = db.prepare("SELECT * FROM calendar_school_days WHERE calendar_date = ?").get(calendarDate);
  if (!target) throw new Error("Calendar date not found");

  const isAvailable = input.is_available_for_pitis ? 1 : 0;
  const exclusionReason = String(input.exclusion_reason || "").trim();
  const notes = String(input.notes || "").trim();
  const holidayName = String(input.holiday_name || "").trim();
  const observedDate = String(input.observed_date || calendarDate).trim();
  const now = dayjs().toISOString();

  if (Number(target.is_public_holiday) === 1 && Number(target.editable_flag) === 1 && observedDate !== calendarDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate) || !dayjs(observedDate).isValid()) {
      throw new Error("Valid observed date is required");
    }
    const destination = db.prepare("SELECT * FROM calendar_school_days WHERE calendar_date = ?").get(observedDate);
    if (!destination) throw new Error("Observed date must be inside the seeded 2026 calendar");

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE calendar_school_days
        SET is_public_holiday = 0,
            holiday_name = NULL,
            event_type = CASE WHEN is_term_holiday = 1 THEN 'term_holiday' WHEN is_school_day = 1 THEN 'normal_school_day' ELSE 'non_school_day' END,
            is_available_for_pitis = CASE WHEN is_school_day = 1 AND is_term_holiday = 0 THEN 1 ELSE 0 END,
            exclusion_reason = NULL,
            notes = ?,
            source = 'admin',
            updated_at = ?,
            updated_by = ?
        WHERE calendar_date = ?
      `).run("Public holiday moved by administrator", now, updatedBy || null, calendarDate);

      db.prepare(`
        UPDATE calendar_school_days
        SET is_public_holiday = 1,
            holiday_name = ?,
            event_type = 'public_holiday',
            is_available_for_pitis = 0,
            exclusion_reason = ?,
            notes = ?,
            source = 'admin',
            updated_at = ?,
            updated_by = ?
        WHERE calendar_date = ?
      `).run(
        holidayName || target.holiday_name || "Public Holiday",
        exclusionReason || null,
        notes || "Public holiday moved by administrator",
        now,
        updatedBy || null,
        observedDate
      );

      db.prepare(`
        UPDATE calendar_events
        SET event_date = ?, end_date = ?, title = ?
        WHERE event_source = 'moe_2026'
          AND event_type = 'public_holiday'
          AND title = ?
          AND event_date = ?
      `).run(
        observedDate,
        observedDate,
        holidayName || target.holiday_name || "Public Holiday",
        target.holiday_name || "Public Holiday",
        calendarDate
      );
    });
    tx();
    recomputeSchoolWeeks();
    return;
  }

  db.prepare(`
    UPDATE calendar_school_days
    SET is_available_for_pitis = ?,
        exclusion_reason = ?,
        notes = ?,
        holiday_name = CASE WHEN is_public_holiday = 1 THEN ? ELSE holiday_name END,
        source = 'admin',
        updated_at = ?,
        updated_by = ?
    WHERE calendar_date = ?
  `).run(
    isAvailable,
    exclusionReason || null,
    notes || null,
    holidayName || target.holiday_name || null,
    now,
    updatedBy || null,
    calendarDate
  );
  recomputeSchoolWeeks();
}

module.exports = {
  PUBLIC_HOLIDAYS_2026,
  SCHOOL_TERMS_2026,
  TERM_HOLIDAYS_2026,
  getSchoolCalendarDashboard,
  getSchoolCalendarFilters,
  recomputeSchoolWeeks,
  seedOfficialSchoolCalendar2026,
  synchronizeManualNonSchoolEvents,
  updateSchoolCalendarDay
};
