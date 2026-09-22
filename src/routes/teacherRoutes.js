const express = require("express");
const dayjs = require("dayjs");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { db, updateDailySnapshot } = require("../db/init");
const { requireRole } = require("../middleware/auth");
const { notifyUser, scheduleEvent } = require("../services/notificationService");
const { isTeacherUser, buildTeacherProgressSummary } = require("../services/pitisProgressService");
const { buildStudentQrPayload, generateStudentQrDataUrl, parseStudentQrPayload } = require("../services/qrCodeService");
const {
  getLatestTeacherUsageAudit,
  getTeacherUsageDateBounds
} = require("../services/teacherUsageAuditService");
const {
  buildSipPitisDashboard,
  buildSipPitisTeacherJourney,
  buildSipPitisRawAudit,
  getAllPortalTeacherCandidates,
  getSipPitisSettings,
  saveSipPitisSettings,
  sipDashboardToCsv,
  sipRawAuditToCsv
} = require("../services/sipPitisDashboardService");
const {
  STUDENT_TEMPLATE_COLUMNS,
  normalizeClassName,
  normalizeDateValue,
  normalizeGender,
  normalizeOptionalText
} = require("../services/studentSchema");
const {
  buildPitisIntegrityReport,
  pitisIntegrityReportToCsv
} = require("../services/pitisIntegrityReportService");
const {
  buildWeeklyPitisActionReport,
  weeklyPitisActionReportToCsv
} = require("../services/weeklyPitisActionReportService");
const {
  buildStudentRecognitionCoverageReport,
  studentRecognitionCoverageToCsv
} = require("../services/studentRecognitionCoverageService");
const {
  buildStudentStatement,
  studentStatementToCsv,
  buildClassWeeklyDigest,
  classWeeklyDigestToCsv
} = require("../services/phaseFourPitisReportsService");
const {
  buildLeadershipTermSummary,
  leadershipTermSummaryToCsv,
  buildPwaAdoptionReport,
  pwaAdoptionReportToCsv
} = require("../services/phaseFivePitisReportsService");

const router = express.Router();
router.use(requireRole(["teacher", "staff", "admin"]));

const STUDENT_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "students");
if (!fs.existsSync(STUDENT_UPLOAD_DIR)) {
  fs.mkdirSync(STUDENT_UPLOAD_DIR, { recursive: true });
}

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STUDENT_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeId = String(req.params.studentId || req.body.student_id || "student").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeSlot = String(req.params.slot || "1").replace(/[^0-9]/g, "") || "1";
    cb(null, `${safeId}-slot${safeSlot}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image files are allowed"));
  }
});

function removeManagedPhotoIfExists(photoPath) {
  const rel = String(photoPath || "").trim();
  if (!rel || !rel.startsWith("/uploads/students/")) return;
  const abs = path.join(__dirname, "..", "..", "public", rel.replace(/^\//, ""));
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (_) {}
  }
}

function normalizePhotoPath(file) {
  if (!file) return "";
  const rel = path.join("uploads", "students", file.filename).replace(/\\/g, "/");
  return `/${rel}`;
}

function getPhotoColumnForSlot(slot) {
  return Number(slot) === 1 ? "photo_path" : `photo_${Number(slot)}_path`;
}

function getPhotoUploadedAtColumnForSlot(slot) {
  return Number(slot) === 1 ? "photo_uploaded_at" : `photo_${Number(slot)}_uploaded_at`;
}

function getPhotoUploadedByColumnForSlot(slot) {
  return Number(slot) === 1 ? "photo_uploaded_by" : `photo_${Number(slot)}_uploaded_by`;
}

function formatUploadedDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : raw;
}

function getStudentPhotoSlots(student) {
  const uploaderIds = Array.from(
    new Set(
      Array.from({ length: 6 }, (_, index) => Number(student[getPhotoUploadedByColumnForSlot(index + 1)] || 0))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  const uploaderNameById = new Map();
  if (uploaderIds.length) {
    const placeholders = uploaderIds.map(() => "?").join(", ");
    db.prepare(`SELECT id, display_name FROM users WHERE id IN (${placeholders})`).all(...uploaderIds).forEach((row) => {
      uploaderNameById.set(Number(row.id), String(row.display_name || "").trim());
    });
  }
  return Array.from({ length: 6 }, (_, index) => {
    const slot = index + 1;
    const src = String(student[slot === 1 ? "photo_path" : `photo_${slot}_path`] || "").trim();
    const uploadedAtRaw = slot === 1
      ? String(student.photo_uploaded_at || "").trim()
      : String(student[`photo_${slot}_uploaded_at`] || "").trim();
    const uploadedById = Number(student[getPhotoUploadedByColumnForSlot(slot)] || 0);
    return {
      slot,
      src,
      uploadedAt: formatUploadedDate(uploadedAtRaw),
      uploadedBy: uploaderNameById.get(uploadedById) || ""
    };
  });
}

function normalizeHexColor(input, fallback = "#3f6fae") {
  const raw = String(input || "").trim();
  const shortMatch = raw.match(/^#([0-9a-fA-F]{3})$/);
  if (shortMatch) {
    const m = shortMatch[1];
    return `#${m[0]}${m[0]}${m[1]}${m[1]}${m[2]}${m[2]}`.toLowerCase();
  }
  const longMatch = raw.match(/^#([0-9a-fA-F]{6})$/);
  if (longMatch) return `#${longMatch[1].toLowerCase()}`;
  return fallback;
}

function parseLabelIds(raw) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = values
    .flatMap((v) => String(v).split(","))
    .map((v) => Number(String(v).trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
  return Array.from(new Set(ids));
}

function includesBirthdayLabel(labelIds) {
  if (!labelIds.length) return false;
  const placeholders = labelIds.map(() => "?").join(",");
  return !!db.prepare(`SELECT 1 FROM calendar_labels WHERE id IN (${placeholders}) AND LOWER(name)='birthday' LIMIT 1`).get(...labelIds);
}

function eventMatchesSelectedLabels(event, selectedLabelIds) {
  if (!selectedLabelIds || !selectedLabelIds.length) return true;
  const eventLabelIds = new Set((event.labels || []).map((lb) => Number(lb.id)).filter((id) => Number.isInteger(id) && id > 0));
  return selectedLabelIds.some((id) => eventLabelIds.has(Number(id)));
}

function parseLabelsRaw(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = [];
  for (const chunk of s.split("||")) {
    const [id, name, color, description] = chunk.split("::");
    if (!id || !name) continue;
    out.push({
      id: Number(id),
      name,
      color: normalizeHexColor(color, "#3f6fae"),
      description: description || ""
    });
  }
  return out;
}

function parseTaggedUsersRaw(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = [];
  for (const chunk of s.split("||")) {
    const parts = chunk.split("::");
    if (parts.length < 4) continue;
    const id = Number(parts[0]);
    const userId = parts[1];
    const displayName = parts[2];
    const role = parts[3];
    if (!id || !userId) continue;
    out.push({ id, user_id: userId, display_name: displayName || userId, role: role || "teacher" });
  }
  return out;
}

function listStaffUsers() {
  return db
    .prepare(
      `SELECT id, username AS user_id, email, display_name, CASE WHEN role = 'teacher' AND COALESCE(user_type, 'teacher') = 'staff' THEN 'staff' ELSE role END AS role
       FROM users
       WHERE (role = 'teacher' OR role = 'staff') AND COALESCE(is_active, 1) = 1
       ORDER BY display_name ASC, username ASC`
    )
    .all();
}

function getTaggableUserSets() {
  const rows = db
    .prepare(
      `SELECT id, role, COALESCE(user_type, CASE WHEN role = 'staff' THEN 'staff' WHEN role = 'admin' THEN 'admin' ELSE 'teacher' END) AS user_type
       FROM users
       WHERE (role = 'teacher' OR role = 'staff') AND COALESCE(is_active, 1) = 1`
    )
    .all();

  const allIds = [];
  const teacherIds = [];
  const staffIds = [];

  for (const r of rows) {
    const id = Number(r.id);
    if (!id) continue;
    allIds.push(id);
    if (String(r.user_type || 'teacher') === 'staff') {
      staffIds.push(id);
    } else {
      teacherIds.push(id);
    }
  }

  return {
    allIds,
    teacherIds,
    staffIds,
    allSet: new Set(allIds),
    teacherSet: new Set(teacherIds),
    staffSet: new Set(staffIds)
  };
}

function resolveTaggedUserIds(scopeRaw, teacherRaw, staffRaw) {
  const scope = String(scopeRaw || '').trim().toLowerCase();
  const teacherPicked = parseLabelIds(teacherRaw);
  const staffPicked = parseLabelIds(staffRaw);
  const sets = getTaggableUserSets();

  if (scope === 'all') return sets.allIds;
  if (scope === 'all_teachers') return sets.teacherIds;
  if (scope === 'all_staffs') return sets.staffIds;
  if (scope === 'teachers') return teacherPicked.filter((id) => sets.teacherSet.has(id));
  if (scope === 'staffs') return staffPicked.filter((id) => sets.staffSet.has(id));
  return [];
}
function assignEventTaggedUsers(eventId, userIds) {
  const ids = Array.from(new Set((userIds || []).filter((v) => Number.isInteger(v) && v > 0)));
  const previous = new Set(db.prepare("SELECT user_id FROM calendar_event_users WHERE event_id = ?").all(eventId).map(row => Number(row.user_id)));
  const del = db.prepare("DELETE FROM calendar_event_users WHERE event_id = ?");
  const ins = db.prepare("INSERT INTO calendar_event_users (event_id, user_id) VALUES (?, ?)");

  const tx = db.transaction(() => {
    del.run(eventId);
    if (!ids.length) return;

    const placeholders = ids.map(() => "?").join(",");
    const valid = db
      .prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND role IN ('teacher','staff')`)
      .all(...ids)
      .map((r) => Number(r.id));

    for (const userId of valid) {
      ins.run(eventId, userId);
    }
  });

  tx();
  return ids.filter(id => !previous.has(id));
}

function listCalendarLabels() {
  return db
    .prepare(
      `SELECT id, name, color, COALESCE(description, '') AS description, is_system
       FROM calendar_labels
       ORDER BY is_system DESC, name ASC`
    )
    .all()
    .map((l) => ({ ...l, color: normalizeHexColor(l.color, "#3f6fae") }));
}

function assignEventLabels(eventId, labelIds) {
  const ids = Array.from(new Set((labelIds || []).filter((v) => Number.isInteger(v) && v > 0)));
  const del = db.prepare("DELETE FROM calendar_event_labels WHERE event_id = ?");
  const ins = db.prepare("INSERT INTO calendar_event_labels (event_id, label_id) VALUES (?, ?)");

  const tx = db.transaction(() => {
    del.run(eventId);
    if (!ids.length) return;

    const placeholders = ids.map(() => "?").join(",");
    const valid = db
      .prepare(`SELECT id FROM calendar_labels WHERE id IN (${placeholders})`)
      .all(...ids)
      .map((r) => Number(r.id));

    for (const labelId of valid) {
      ins.run(eventId, labelId);
    }
  });

  tx();
}

function getCalendarRange(monthQuery) {
  const monthStr = String(monthQuery || "").trim();
  const isMonthQueryValid = /^\d{4}-\d{2}$/.test(monthStr);
  const monthBase = isMonthQueryValid ? dayjs(`${monthStr}-01`) : dayjs().startOf("month");
  const monthStart = monthBase.isValid() ? monthBase.startOf("month") : dayjs().startOf("month");

  const offsetFromMonday = (monthStart.day() + 6) % 7;
  const gridStart = monthStart.subtract(offsetFromMonday, "day");
  const gridEnd = gridStart.add(41, "day");

  return { monthStart, gridStart, gridEnd };
}

function parseStudentDobDayMonth(rawDob) {
  const dob = String(rawDob || "").trim();
  if (!dob) return null;

  let day;
  let month;

  let m = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    day = Number(m[1]);
    month = Number(m[2]);
  } else {
    m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    month = Number(m[2]);
    day = Number(m[3]);
  }

  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { day, month };
}

function fetchManualEvents({ rangeStart, rangeEnd, allActive = false }) {
  const baseQuery = `
    SELECT
      ce.id,
      ce.title,
      ce.details,
      ce.event_date,
      COALESCE(ce.end_date, ce.event_date) AS end_date,
      ce.event_source,
      ce.created_by,
      ce.created_at,
      u.display_name AS creator_name,
      COALESCE((
        SELECT GROUP_CONCAT(
          cl.id || '::' || cl.name || '::' || cl.color || '::' || COALESCE(cl.description, ''),
          '||'
        )
        FROM calendar_event_labels cel
        JOIN calendar_labels cl ON cl.id = cel.label_id
        WHERE cel.event_id = ce.id
      ), '') AS labels_raw,
      COALESCE((
        SELECT GROUP_CONCAT(
          usr.id || '::' || usr.username || '::' || usr.display_name || '::' || usr.role,
          '||'
        )
        FROM calendar_event_users ceu
        JOIN users usr ON usr.id = ceu.user_id
        WHERE ceu.event_id = ce.id
      ), '') AS tagged_users_raw
    FROM calendar_events ce
    JOIN users u ON u.id = ce.created_by
    WHERE ce.is_deleted = 0
      AND ce.event_source IN ('manual', 'moe_2026')
      ${allActive ? "" : "AND date(COALESCE(ce.end_date, ce.event_date)) >= date(?) AND date(ce.event_date) <= date(?)"}
    ORDER BY ce.event_date ASC, ce.created_at ASC`;

  const rows = allActive
    ? db.prepare(baseQuery).all()
    : db.prepare(baseQuery).all(rangeStart.format("YYYY-MM-DD"), rangeEnd.format("YYYY-MM-DD"));

  return rows.map((ev) => ({
    ...ev,
    labels: parseLabelsRaw(ev.labels_raw),
    tagged_users: parseTaggedUsersRaw(ev.tagged_users_raw),
    is_system: String(ev.event_source || "manual") !== "manual"
  }));
}
function fetchBirthdayEvents({ rangeStart, rangeEnd, birthdayLabel }) {
  const label = birthdayLabel || { id: null, name: "Birthday", color: "#f1c40f", description: "Student birthday" };
  const students = db
    .prepare(
      `SELECT s.id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, s.dob, c.name AS class_name
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE dob IS NOT NULL AND TRIM(dob) <> ''`
    )
    .all();

  const startYear = rangeStart.year();
  const endYear = rangeEnd.year();
  const events = [];

  for (const st of students) {
    const dm = parseStudentDobDayMonth(st.dob);
    if (!dm) continue;

    for (let y = startYear; y <= endYear; y += 1) {
      const dateStr = `${y}-${String(dm.month).padStart(2, "0")}-${String(dm.day).padStart(2, "0")}`;
      const d = dayjs(dateStr);
      if (!d.isValid()) continue;
      if (d.isBefore(rangeStart, "day") || d.isAfter(rangeEnd, "day")) continue;

      const displayName = String(st.nickname || st.full_name || "Student").trim();
      const className = String(st.class_name || "").trim();
      const displayLabel = className ? `${displayName} (${className})` : displayName;
      events.push({
        id: `birthday-${st.id}-${y}`,
        title: `Birthday: ${displayLabel}`,
        details: `Auto-generated from student DOB (${st.dob})`,
        event_date: d.format("YYYY-MM-DD"),
        end_date: d.format("YYYY-MM-DD"),
        event_source: "system_birthday",
        created_at: "",
        creator_name: "System",
        labels: [label],
        tagged_users: [],
        is_system: true,
        source_student_id: st.id
      });
    }
  }

  events.sort((a, b) => {
    if (a.event_date < b.event_date) return -1;
    if (a.event_date > b.event_date) return 1;
    return String(a.title).localeCompare(String(b.title));
  });

  return events;
}

function fetchDeviceBookingCalendarEvents({ rangeStart, rangeEnd, allActive = false, bookingLabel }) {
  const label = bookingLabel || { id: null, name: "Device Booking", color: "#3498db", description: "Booked school multimedia device" };
  const baseQuery = `
    SELECT
      b.id,
      b.booking_date AS event_date,
      b.booking_date AS end_date,
      b.planned_start_time,
      b.planned_end_time,
      b.actual_start_time,
      b.actual_end_time,
      b.took_from_hub_at,
      b.returned_to_hub_at,
      b.class_name,
      b.subject,
      b.lesson_topic,
      b.venue,
      b.purpose,
      b.remarks,
      b.status,
      d.name AS device_name,
      d.code AS device_code,
      u.display_name AS creator_name
    FROM device_bookings b
    JOIN devices d ON d.id = b.device_id
    JOIN users u ON u.id = b.user_id
    WHERE b.status <> 'cancelled'
      ${allActive ? "" : "AND date(b.booking_date) BETWEEN date(?) AND date(?)"}
    ORDER BY b.booking_date ASC, b.planned_start_time ASC, b.created_at ASC
  `;

  const rows = allActive
    ? db.prepare(baseQuery).all()
    : db.prepare(baseQuery).all(rangeStart.format("YYYY-MM-DD"), rangeEnd.format("YYYY-MM-DD"));

  return rows.map((row) => {
    const statusLabel = String(row.status || "").replace(/_/g, " ");
    const details = [
      `Subject: ${row.subject}`,
      `Lesson Topic: ${row.lesson_topic}`,
      `Venue: ${row.venue}`,
      `Planned Time: ${row.planned_start_time} - ${row.planned_end_time}`,
      `Purpose: ${row.purpose}`,
      `Status: ${statusLabel}`,
      row.actual_start_time ? `Actual Start: ${row.actual_start_time}` : "",
      row.actual_end_time ? `Actual End: ${row.actual_end_time}` : "",
      row.took_from_hub_at ? `Taken From Hub: ${row.took_from_hub_at}` : "",
      row.returned_to_hub_at ? `Returned To Hub: ${row.returned_to_hub_at}` : "",
      row.remarks ? `Remarks: ${row.remarks}` : ""
    ].filter(Boolean).join(" | ");

    return {
      id: `device-booking-${row.id}`,
      title: `${row.device_name} (${row.device_code}) - ${row.class_name}`,
      details,
      event_date: row.event_date,
      end_date: row.end_date,
      event_source: "device_booking",
      created_at: row.event_date,
      creator_name: row.creator_name,
      labels: [label],
      tagged_users: [],
      is_system: true,
      booking_id: row.id,
      booking_status: row.status
    };
  });
}

function buildCalendarWeeks(monthStart, eventsForGrid) {
  const offsetFromMonday = (monthStart.day() + 6) % 7;
  const gridStart = monthStart.subtract(offsetFromMonday, "day");
  const colorPalette = ["#6aa84f", "#e0b525", "#6a4fa3", "#3f6fae", "#b33771", "#f39c12", "#2a9d8f"];

  const normalizedEvents = eventsForGrid.map((ev, idx) => {
    let start = dayjs(ev.event_date);
    let end = dayjs(ev.end_date || ev.event_date);
    if (end.isBefore(start, "day")) {
      const t = start;
      start = end;
      end = t;
    }

    const primaryLabel = ev.labels && ev.labels.length ? ev.labels[0] : null;
    const fallbackColor = colorPalette[idx % colorPalette.length];
    return {
      ...ev,
      start,
      end,
      color: primaryLabel ? normalizeHexColor(primaryLabel.color, fallbackColor) : fallbackColor
    };
  });

  const weeks = [];
  for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
    const weekStart = gridStart.add(weekIndex * 7, "day");
    const weekEnd = weekStart.add(6, "day");

    const days = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const d = weekStart.add(dayIndex, "day");
      const isoDate = d.format("YYYY-MM-DD");
      days.push({
        isoDate,
        dayOfMonth: d.format("DD"),
        isCurrentMonth: d.month() === monthStart.month(),
        isToday: isoDate === dayjs().format("YYYY-MM-DD")
      });
    }

    const weekEvents = normalizedEvents
      .filter((ev) => !(ev.end.isBefore(weekStart, "day") || ev.start.isAfter(weekEnd, "day")))
      .sort((a, b) => {
        if (a.start.isBefore(b.start, "day")) return -1;
        if (a.start.isAfter(b.start, "day")) return 1;
        return b.end.diff(b.start, "day") - a.end.diff(a.start, "day");
      });

    const laneEndByIndex = [];
    const spans = [];

    for (const ev of weekEvents) {
      const segStart = ev.start.isBefore(weekStart, "day") ? weekStart : ev.start;
      const segEnd = ev.end.isAfter(weekEnd, "day") ? weekEnd : ev.end;
      const startIdx = segStart.diff(weekStart, "day");
      const endIdx = segEnd.diff(weekStart, "day");

      let lane = laneEndByIndex.findIndex((endAt) => endAt < startIdx);
      if (lane === -1) {
        lane = laneEndByIndex.length;
        laneEndByIndex.push(endIdx);
      } else {
        laneEndByIndex[lane] = endIdx;
      }

      spans.push({
        id: ev.id,
        title: ev.title,
        details: ev.details,
        createdBy: ev.creator_name,
        color: ev.color,
        labels: ev.labels || [],
        taggedUsers: ev.tagged_users || [],
        tag_scope: ev.tag_scope || "",
        isSystem: !!ev.is_system,
        lane,
        startCol: startIdx + 1,
        endCol: endIdx + 2,
        continuesLeft: ev.start.isBefore(weekStart, "day"),
        continuesRight: ev.end.isAfter(weekEnd, "day")
      });
    }

    weeks.push({
      days,
      spans,
      laneCount: Math.max(laneEndByIndex.length, 1)
    });
  }

  return weeks;
}

function normalizeQrQuizAnswer(value) {
  const answer = String(value || "").trim().toUpperCase();
  return ["A", "B", "C"].includes(answer) ? answer : "";
}

function normalizePositiveInteger(value, fallback = 0) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function generateQrQuizToken() {
  return crypto.randomBytes(16).toString("hex");
}

function buildRequestOrigin(req) {
  const protocol = req.secure ? "https" : "http";
  const host = req.get("host") || "localhost:3000";
  return `${protocol}://${host}`;
}

function getQrQuizAccessUrl(req, quiz) {
  return `${buildRequestOrigin(req)}/qr-quiz/${encodeURIComponent(quiz.access_token)}`;
}

async function buildQrQuizCardData(req, quiz) {
  const accessUrl = getQrQuizAccessUrl(req, quiz);
  return {
    ...quiz,
    accessUrl,
    qrCodeImage: quiz.status === "active"
      ? await QRCode.toDataURL(accessUrl, { type: "image/png", errorCorrectionLevel: "M", margin: 1, width: 280 })
      : ""
  };
}

function fetchQrQuizList() {
  return db.prepare(`
    SELECT q.*, c.name AS class_name, u.display_name AS created_by_name,
           COALESCE((
             SELECT GROUP_CONCAT(qtc.class_name, ', ')
             FROM qr_quiz_target_classes qtc
             WHERE qtc.quiz_id = q.id
           ), c.name) AS target_class_names,
           COUNT(DISTINCT qq.id) AS question_count,
           COUNT(DISTINCT r.id) AS response_count,
           COALESCE(SUM(r.score), 0) AS total_correct,
           COALESCE(SUM(r.pitis_awarded), 0) AS total_pitis_awarded
    FROM qr_quizzes q
    LEFT JOIN classes c ON c.id = q.target_class_id
    LEFT JOIN users u ON u.id = q.created_by
    LEFT JOIN qr_quiz_questions qq ON qq.quiz_id = q.id
    LEFT JOIN qr_quiz_responses r ON r.quiz_id = q.id
    WHERE q.status <> 'archived'
    GROUP BY q.id
    ORDER BY CASE q.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END,
             q.updated_at DESC, q.id DESC
  `).all();
}

function getQrQuizForTeacher(quizId) {
  const quiz = db.prepare(`
    SELECT q.*, c.name AS class_name, u.display_name AS created_by_name,
           COALESCE((
             SELECT GROUP_CONCAT(qtc.class_name, ', ')
             FROM qr_quiz_target_classes qtc
             WHERE qtc.quiz_id = q.id
           ), c.name) AS target_class_names
    FROM qr_quizzes q
    LEFT JOIN classes c ON c.id = q.target_class_id
    LEFT JOIN users u ON u.id = q.created_by
    WHERE q.id = ?
  `).get(quizId);
  if (!quiz) return null;
  quiz.questions = db.prepare("SELECT * FROM qr_quiz_questions WHERE quiz_id = ? ORDER BY position ASC").all(quizId);
  quiz.targetClasses = db.prepare(`
    SELECT COALESCE(c.id, qtc.class_id) AS id, qtc.class_name AS name
    FROM qr_quiz_target_classes qtc
    LEFT JOIN classes c ON c.name = qtc.class_name
    WHERE qtc.quiz_id = ?
    ORDER BY qtc.class_name ASC
  `).all(quizId);
  if (!quiz.targetClasses.length && quiz.class_name) {
    quiz.targetClasses = [{ id: quiz.target_class_id, name: quiz.class_name }];
    quiz.target_class_names = quiz.class_name;
  }
  quiz.response_count = Number(db.prepare("SELECT COUNT(*) AS total FROM qr_quiz_responses WHERE quiz_id = ?").get(quizId).total || 0);
  return quiz;
}

function fetchQrQuizResults(quizId) {
  return db.prepare(`
    SELECT r.*, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, s.student_id AS external_student_id,
           c.name AS class_name
    FROM qr_quiz_responses r
    JOIN students s ON s.id = r.student_id
    JOIN classes c ON c.id = r.class_id
    WHERE r.quiz_id = ?
    ORDER BY r.submitted_at DESC, s.full_name ASC
  `).all(quizId);
}

function parseQrQuizQuestions(body) {
  const count = Math.min(Math.max(normalizePositiveInteger(body.question_count, 1), 1), 10);
  const questions = [];
  for (let index = 0; index < count; index += 1) {
    const position = index + 1;
    const question = String(body[`question_${position}`] || "").trim();
    const optionA = String(body[`option_a_${position}`] || "").trim();
    const optionB = String(body[`option_b_${position}`] || "").trim();
    const optionC = String(body[`option_c_${position}`] || "").trim();
    const correct = normalizeQrQuizAnswer(body[`correct_${position}`]);
    if (!question || !optionA || !optionB || !optionC || !correct) {
      throw new Error(`Complete question ${position}, all three options, and the correct answer.`);
    }
    questions.push({ position, question, optionA, optionB, optionC, correct });
  }
  return questions;
}

function parseQrQuizTargetClasses(body) {
  let rawValues = Array.isArray(body.target_classes)
    ? body.target_classes
    : (body.target_classes ? [body.target_classes] : []);
  const fallbackIds = Array.isArray(body.target_class_ids)
    ? body.target_class_ids
    : (body.target_class_ids ? [body.target_class_ids] : []);
  if (!rawValues.length && fallbackIds.length) {
    const ids = Array.from(new Set(fallbackIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)));
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      rawValues = db.prepare(`SELECT name FROM classes WHERE id IN (${placeholders}) ORDER BY name ASC`).all(...ids).map((cls) => cls.name);
    }
  }
  const selectedNames = Array.from(new Set(rawValues
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
  if (!selectedNames.length) {
    throw new Error("Select at least one target class");
  }

  const available = db.prepare("SELECT id, name FROM classes ORDER BY name ASC").all();
  const availableByName = new Map(available.map((cls) => [String(cls.name || "").trim(), cls]));
  const selected = selectedNames.map((name) => availableByName.get(name)).filter(Boolean);
  if (selected.length !== selectedNames.length) {
    throw new Error("Select valid target classes");
  }
  return selected.map((cls) => ({ id: Number(cls.id), name: String(cls.name || "").trim() }));
}

function buildQrQuizSheetPayload(quiz, student, sheetPage = null, sheetSlot = null) {
  return JSON.stringify({
    t: "qqas",
    q: Number(quiz.id || 0),
    a: String(quiz.access_token || "").trim(),
    s: Number(student.id || 0),
    p: sheetPage == null ? null : Number(sheetPage),
    l: sheetSlot == null ? null : Number(sheetSlot)
  });
}

function parseQrQuizSheetPayload(raw) {
  const parsed = JSON.parse(String(raw || "").trim());
  if (!parsed || (parsed.t !== "qqas" && parsed.type !== "qr_quiz_answer_sheet")) {
    throw new Error("QR code is not a QR Quiz answer sheet");
  }
  return {
    quizId: Number(parsed.q || parsed.quiz_id || 0),
    accessToken: String(parsed.a || parsed.access_token || "").trim(),
    studentId: Number(parsed.s || parsed.student_id || 0),
    sheetPage: Number(parsed.p || parsed.sheet_page || 0),
    sheetSlot: Number(parsed.l || parsed.sheet_slot || 0)
  };
}

function fetchQrQuizTargetStudents(quiz) {
  if (quiz.target_type === "class") {
    const targetClassNames = (quiz.targetClasses && quiz.targetClasses.length
      ? quiz.targetClasses
      : db.prepare("SELECT class_name AS name FROM qr_quiz_target_classes WHERE quiz_id = ?").all(quiz.id)
    ).map((row) => String(row.name || row.class_name || "").trim()).filter(Boolean);
    if (!targetClassNames.length) return [];
    const placeholders = targetClassNames.map(() => "?").join(",");
    return db.prepare(`
      SELECT s.id, s.student_id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
             s.class_id, c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE c.name IN (${placeholders})
      ORDER BY c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC
    `).all(...targetClassNames);
  }

  return db.prepare(`
    SELECT s.id, s.student_id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
           s.class_id, c.name AS class_name
    FROM students s
    JOIN classes c ON c.id = s.class_id
    ORDER BY c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC
  `).all();
}

function getQrQuizTargetClassIds(quiz) {
  if (!quiz || quiz.target_type !== "class") return [];
  const rows = db.prepare(`
    SELECT COALESCE(c.id, qtc.class_id) AS class_id
    FROM qr_quiz_target_classes qtc
    LEFT JOIN classes c ON c.name = qtc.class_name
    WHERE qtc.quiz_id = ?
  `).all(quiz.id);
  return rows.map((row) => Number(row.class_id)).filter(Boolean);
}

function studentMatchesQrQuizTarget(quiz, student) {
  if (!quiz || quiz.target_type !== "class") return true;
  const targetNames = (quiz.targetClasses || [])
    .map((cls) => String(cls.name || cls.class_name || "").trim())
    .filter(Boolean);
  if (targetNames.length && student.class_name) {
    return targetNames.includes(String(student.class_name || "").trim());
  }
  return getQrQuizTargetClassIds(quiz).includes(Number(student.class_id));
}

function escapePdfText(value) {
  return String(value == null ? "" : value)
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function createSimplePdf(pages) {
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const contentIds = pages.map((page) => addObject(`<< /Length ${Buffer.byteLength(page.content, "binary")} >>\nstream\n${page.content}\nendstream`));
  const pageIds = contentIds.map((contentId) => addObject(`<< /Type /Page /Parent __PAGES__ 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  const pagesId = addObject(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  for (const pageId of pageIds) {
    objects[pageId - 1] = objects[pageId - 1].replace("__PAGES__", String(pagesId));
  }

  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(""), "binary"));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(""), "binary");
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  });
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "binary");
}

function pdfText(x, y, text, size = 11) {
  return `BT /F1 ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfText(text)}) Tj ET\n`;
}

function pdfRect(x, y, w, h, mode = "S") {
  return `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${mode}\n`;
}

function pdfLineWidth(width) {
  return `${width.toFixed(2)} w\n`;
}

function pdfStrokeGray(value) {
  return `${value.toFixed(2)} G\n`;
}

function pdfCircle(x, y, r, mode = "S") {
  const k = 0.5522847498;
  const c = r * k;
  return [
    `${(x + r).toFixed(2)} ${y.toFixed(2)} m`,
    `${(x + r).toFixed(2)} ${(y + c).toFixed(2)} ${(x + c).toFixed(2)} ${(y + r).toFixed(2)} ${x.toFixed(2)} ${(y + r).toFixed(2)} c`,
    `${(x - c).toFixed(2)} ${(y + r).toFixed(2)} ${(x - r).toFixed(2)} ${(y + c).toFixed(2)} ${(x - r).toFixed(2)} ${y.toFixed(2)} c`,
    `${(x - r).toFixed(2)} ${(y - c).toFixed(2)} ${(x - c).toFixed(2)} ${(y - r).toFixed(2)} ${x.toFixed(2)} ${(y - r).toFixed(2)} c`,
    `${(x + c).toFixed(2)} ${(y - r).toFixed(2)} ${(x + r).toFixed(2)} ${(y - c).toFixed(2)} ${(x + r).toFixed(2)} ${y.toFixed(2)} c`,
    mode
  ].join("\n") + "\n";
}

function wrapPdfText(text, maxChars) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }
    if ((current.length + word.length + 1) <= maxChars) {
      current += ` ${word}`;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function pdfTextLines(x, y, lines, size = 11, lineHeight = 14) {
  return lines.reduce((out, line, index) => out + pdfText(x, y - (index * lineHeight), line, size), "");
}

function drawQrToPdf(payload, x, y, size) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const moduleCount = qr.modules.size;
  const quietModules = 4;
  const moduleSize = size / (moduleCount + (quietModules * 2));
  let out = "0 0 0 rg\n";
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.modules.data[row * moduleCount + col]) {
        out += pdfRect(
          x + (col + quietModules) * moduleSize,
          y + (moduleCount - row - 1 + quietModules) * moduleSize,
          moduleSize,
          moduleSize,
          "f"
        );
      }
    }
  }
  return out;
}

const QR_QUIZ_SHEET = {
  pageWidth: 595.28,
  pageHeight: 841.89,
  qrX: 90,
  qrY: 700,
  qrSize: 78,
  textX: 170,
  titleY: 772,
  metaY: 735,
  gridHeaderY: 642,
  firstRowY: 602,
  rowStep: 42,
  rowsPerColumn: 10,
  columnsPerPage: 1,
  bubbleRadius: 11,
  columnX: [220],
  answerOffsets: [0, 58, 116],
  fiducialSize: 44,
  fiducials: [
    { x: 42, y: 756 },
    { x: 509, y: 756 },
    { x: 42, y: 42 },
    { x: 509, y: 42 }
  ]
};
QR_QUIZ_SHEET.rowsPerPage = QR_QUIZ_SHEET.rowsPerColumn * QR_QUIZ_SHEET.columnsPerPage;

function drawFiducialToPdf(x, y, size) {
  const inset = size * 0.28;
  const centerInset = size * 0.40;
  return [
    "0 g",
    pdfRect(x, y, size, size, "f"),
    "1 g",
    pdfRect(x + inset, y + inset, size - (inset * 2), size - (inset * 2), "f"),
    "0 g",
    pdfRect(x + centerInset, y + centerInset, size - (centerInset * 2), size - (centerInset * 2), "f")
  ].join("\n") + "\n";
}

function getQrQuizSheetEntryPosition(localIndex) {
  const columnIndex = Math.floor(localIndex / QR_QUIZ_SHEET.rowsPerColumn);
  const rowIndex = localIndex % QR_QUIZ_SHEET.rowsPerColumn;
  return {
    columnX: QR_QUIZ_SHEET.columnX[columnIndex],
    rowY: QR_QUIZ_SHEET.firstRowY - (rowIndex * QR_QUIZ_SHEET.rowStep)
  };
}

function buildQrQuizAnswerSheetPdf(quiz, students) {
  const panels = [];
  students.forEach((student) => {
    const pageCount = Math.max(1, Math.ceil(quiz.questions.length / QR_QUIZ_SHEET.rowsPerPage));

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageQuestions = quiz.questions.slice(
        pageIndex * QR_QUIZ_SHEET.rowsPerPage,
        (pageIndex + 1) * QR_QUIZ_SHEET.rowsPerPage
      );
      panels.push({ student, pageIndex, pageCount, questions: pageQuestions });
    }
  });

  const pages = [];
  for (let panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
    const panel = panels[panelIndex];
    let content = "";
    const qrPayload = buildQrQuizSheetPayload(quiz, panel.student, panel.pageIndex + 1, 1);
    content += "0 G\n0 g\n";
    content += pdfLineWidth(0.8);
    content += pdfRect(18, 18, QR_QUIZ_SHEET.pageWidth - 36, QR_QUIZ_SHEET.pageHeight - 36, "S");
    QR_QUIZ_SHEET.fiducials.forEach((marker) => {
      content += drawFiducialToPdf(marker.x, marker.y, QR_QUIZ_SHEET.fiducialSize);
    });
    content += drawQrToPdf(qrPayload, QR_QUIZ_SHEET.qrX, QR_QUIZ_SHEET.qrY, QR_QUIZ_SHEET.qrSize);
    content += pdfText(QR_QUIZ_SHEET.textX, QR_QUIZ_SHEET.titleY, "QR Quiz Answer Sheet", 20);
    content += pdfText(QR_QUIZ_SHEET.textX, QR_QUIZ_SHEET.metaY, String(panel.student.full_name || "").slice(0, 48), 12);
    content += pdfText(QR_QUIZ_SHEET.textX, QR_QUIZ_SHEET.metaY - 18, String(quiz.title || "Untitled quiz").slice(0, 40), 12);
    content += pdfText(QR_QUIZ_SHEET.textX, QR_QUIZ_SHEET.metaY - 36, String(panel.student.class_name || "").slice(0, 28), 12);
    if (panel.pageCount > 1) {
      content += pdfText(QR_QUIZ_SHEET.textX, QR_QUIZ_SHEET.metaY - 54, `Answer page ${panel.pageIndex + 1} of ${panel.pageCount}`, 10);
    }

    QR_QUIZ_SHEET.columnX.forEach((columnX) => {
      ["A", "B", "C"].forEach((letter, index) => {
        content += pdfText(columnX + QR_QUIZ_SHEET.answerOffsets[index] - 6, QR_QUIZ_SHEET.gridHeaderY, letter, 18);
      });
    });

    panel.questions.forEach((question, localIndex) => {
      const pos = getQrQuizSheetEntryPosition(localIndex);
      content += pdfText(pos.columnX - 48, pos.rowY - 8, String(question.position), 18);
      content += pdfLineWidth(1.0);
      content += pdfStrokeGray(0.45);
      QR_QUIZ_SHEET.answerOffsets.forEach((offset) => {
        content += pdfCircle(pos.columnX + offset, pos.rowY, QR_QUIZ_SHEET.bubbleRadius, "S");
      });
      content += pdfStrokeGray(0);
    });
    pages.push({ content });
  }
  return createSimplePdf(pages);
}

function sortScanCorners(points) {
  const copy = points.slice();
  const topLeft = copy.reduce((best, point) => (point.x + point.y < best.x + best.y ? point : best), copy[0]);
  const bottomRight = copy.reduce((best, point) => (point.x + point.y > best.x + best.y ? point : best), copy[0]);
  const topRight = copy.reduce((best, point) => (point.x - point.y > best.x - best.y ? point : best), copy[0]);
  const bottomLeft = copy.reduce((best, point) => (point.x - point.y < best.x - best.y ? point : best), copy[0]);
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function solveScanLinearSystem(matrix, values) {
  const n = values.length;
  const rows = matrix.map((row, index) => row.slice().concat(values[index]));
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    if (Math.abs(rows[pivot][col]) < 1e-9) return null;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    for (let c = col; c <= n; c += 1) rows[col][c] /= divisor;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = rows[r][col];
      for (let cc = col; cc <= n; cc += 1) rows[r][cc] -= factor * rows[col][cc];
    }
  }
  return rows.map((row) => row[n]);
}

function buildScanHomography(source, target) {
  const matrix = [];
  const values = [];
  source.forEach((src, index) => {
    const dst = target[index];
    matrix.push([src.x, src.y, 1, 0, 0, 0, -dst.x * src.x, -dst.x * src.y]);
    values.push(dst.x);
    matrix.push([0, 0, 0, src.x, src.y, 1, -dst.y * src.x, -dst.y * src.y]);
    values.push(dst.y);
  });
  const h = solveScanLinearSystem(matrix, values);
  return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}

function transformScanPoint(h, point) {
  const denom = h[6] * point.x + h[7] * point.y + h[8];
  if (!denom) return null;
  return {
    x: (h[0] * point.x + h[1] * point.y + h[2]) / denom,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / denom
  };
}

function pdfScanPoint(x, y) {
  return { x, y: QR_QUIZ_SHEET.pageHeight - y };
}

function getScanFiducialSource() {
  return [
    QR_QUIZ_SHEET.fiducials[0],
    QR_QUIZ_SHEET.fiducials[1],
    QR_QUIZ_SHEET.fiducials[3],
    QR_QUIZ_SHEET.fiducials[2]
  ].map((marker) => pdfScanPoint(
    marker.x + (QR_QUIZ_SHEET.fiducialSize / 2),
    marker.y + (QR_QUIZ_SHEET.fiducialSize / 2)
  ));
}

function getCaptureDarkness(gray, width, height, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return null;
  return 1 - (gray[iy * width + ix] / 255);
}

function findCaptureFiducialHomography(gray, width, height) {
  const maxDim = 260;
  const scale = Math.max(width, height) / maxDim;
  const smallW = Math.max(1, Math.floor(width / scale));
  const smallH = Math.max(1, Math.floor(height / scale));
  const dark = new Uint8Array(smallW * smallH);
  const visited = new Uint8Array(smallW * smallH);
  for (let y = 0; y < smallH; y += 1) {
    for (let x = 0; x < smallW; x += 1) {
      const darkness = getCaptureDarkness(gray, width, height, (x + 0.5) * scale, (y + 0.5) * scale) || 0;
      dark[y * smallW + x] = darkness > 0.55 ? 1 : 0;
    }
  }

  const components = [];
  const queueX = [];
  const queueY = [];
  for (let sy = 0; sy < smallH; sy += 1) {
    for (let sx = 0; sx < smallW; sx += 1) {
      const startIndex = sy * smallW + sx;
      if (!dark[startIndex] || visited[startIndex]) continue;
      queueX.length = 0;
      queueY.length = 0;
      queueX.push(sx);
      queueY.push(sy);
      visited[startIndex] = 1;
      let head = 0;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let area = 0;
      while (head < queueX.length) {
        const cx = queueX[head];
        const cy = queueY[head];
        head += 1;
        area += 1;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= smallW || ny >= smallH) return;
          const ni = ny * smallW + nx;
          if (!dark[ni] || visited[ni]) return;
          visited[ni] = 1;
          queueX.push(nx);
          queueY.push(ny);
        });
      }
      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const ratio = boxW / Math.max(1, boxH);
      const fill = area / Math.max(1, boxW * boxH);
      if (boxW >= 6 && boxH >= 6 && ratio >= 0.65 && ratio <= 1.55 && fill >= 0.18) {
        components.push({
          x: ((minX + maxX + 1) / 2) * scale,
          y: ((minY + maxY + 1) / 2) * scale,
          width: boxW * scale,
          height: boxH * scale,
          area,
          fill
        });
      }
    }
  }

  if (components.length < 4) return null;
  const minMarkerSize = Math.min(width, height) * 0.025;
  let candidates = components.filter((component) => component.width >= minMarkerSize && component.height >= minMarkerSize);
  if (candidates.length < 4) candidates = components;
  const corners = sortScanCorners(candidates);
  const unique = [];
  corners.forEach((point) => {
    const isDuplicate = unique.some((existing) => {
      const dx = existing.x - point.x;
      const dy = existing.y - point.y;
      return Math.sqrt((dx * dx) + (dy * dy)) < Math.max(point.width || 12, point.height || 12) * 0.6;
    });
    if (!isDuplicate) unique.push(point);
  });
  if (unique.length < 4) return null;
  return buildScanHomography(getScanFiducialSource(), sortScanCorners(unique.slice(0, 4)));
}

function estimateCaptureRadius(homography, center, pdfRadius) {
  const edge = transformScanPoint(homography, { x: center.x + pdfRadius, y: center.y });
  const imageCenter = transformScanPoint(homography, center);
  if (!edge || !imageCenter) return 4;
  const dx = edge.x - imageCenter.x;
  const dy = edge.y - imageCenter.y;
  return Math.max(3, Math.min(28, Math.sqrt((dx * dx) + (dy * dy))));
}

function sampleCaptureBubble(gray, width, height, homography, bubble) {
  const pageCenter = pdfScanPoint(bubble.x, bubble.y);
  const imageCenter = transformScanPoint(homography, pageCenter);
  if (!imageCenter) return null;
  const imageRadius = estimateCaptureRadius(homography, pageCenter, bubble.radius);
  const sampleRadius = Math.max(2, imageRadius * 0.62);
  let total = 0;
  let darkCount = 0;
  let count = 0;
  const step = Math.max(1, sampleRadius / 4);
  for (let yy = -sampleRadius; yy <= sampleRadius; yy += step) {
    for (let xx = -sampleRadius; xx <= sampleRadius; xx += step) {
      if ((xx * xx) + (yy * yy) > sampleRadius * sampleRadius) continue;
      const darkness = getCaptureDarkness(gray, width, height, imageCenter.x + xx, imageCenter.y + yy);
      if (darkness == null) continue;
      total += darkness;
      if (darkness >= 0.38) darkCount += 1;
      count += 1;
    }
  }
  if (!count) return null;
  const average = total / count;
  const darkRatio = darkCount / count;
  return {
    score: (darkRatio * 0.78) + (average * 0.22),
    average,
    darkRatio
  };
}

function getQrQuizSheetEntries(questions) {
  return questions.slice(0, QR_QUIZ_SHEET.rowsPerPage).map((question, index) => {
    const pos = getQrQuizSheetEntryPosition(index);
    return {
      question,
      boxes: ["A", "B", "C"].map((letter, answerIndex) => ({
        letter,
        x: pos.columnX + QR_QUIZ_SHEET.answerOffsets[answerIndex],
        y: pos.rowY,
        radius: QR_QUIZ_SHEET.bubbleRadius
      }))
    };
  });
}

function processQrQuizCaptureImage(quiz, parsed, image) {
  const width = Number(image && image.width);
  const height = Number(image && image.height);
  const grayBase64 = String((image && image.gray_base64) || "");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || height < 240 || !grayBase64) {
    throw new Error("Capture image is missing or too small");
  }
  const gray = Buffer.from(grayBase64, "base64");
  if (gray.length !== width * height) throw new Error("Capture image data is invalid");
  const homography = findCaptureFiducialHomography(gray, width, height);
  if (!homography) {
    return { complete: false, message: "Could not align the sheet. Capture the full page with all four black corner markers visible.", debugRows: [] };
  }

  const startIndex = Math.max(0, ((Number(parsed.sheetPage || 1) - 1) * QR_QUIZ_SHEET.rowsPerPage));
  const pageQuestions = quiz.questions.slice(startIndex, startIndex + QR_QUIZ_SHEET.rowsPerPage);
  const answers = {};
  const debugRows = [];
  let confident = 0;
  getQrQuizSheetEntries(pageQuestions).forEach((entry) => {
    const scores = entry.boxes.map((box) => {
      const mark = sampleCaptureBubble(gray, width, height, homography, box);
      return {
        letter: box.letter,
        score: mark ? mark.score : null,
        darkRatio: mark ? mark.darkRatio : 0
      };
    }).filter((score) => score.score != null).sort((a, b) => b.score - a.score);
    if (scores.length < 3) return;
    const [best, second, third] = scores;
    const gap = best.score - second.score;
    const spread = best.score - third.score;
    const rowDebug = { position: entry.question.position, selected: "", scores: { A: 0, B: 0, C: 0 } };
    scores.forEach((score) => {
      rowDebug.scores[score.letter] = Number(score.score || 0);
    });
    if ((best.score >= 0.22 && gap >= 0.075) || (best.darkRatio >= 0.30 && gap >= 0.045 && spread >= 0.06)) {
      answers[entry.question.id] = best.letter;
      rowDebug.selected = best.letter;
      confident += 1;
    }
    debugRows.push(rowDebug);
  });

  const complete = confident >= pageQuestions.length && pageQuestions.length > 0;
  return {
    complete,
    answers,
    debugRows,
    message: complete
      ? `Detected ${confident} / ${pageQuestions.length} answers.`
      : `Detected ${confident} / ${pageQuestions.length} answers. Recapture with better lighting and a flatter page.`
  };
}

function gradeQrQuizResponse({ quiz, student, selectedAnswers, awardedBy }) {
  const questions = db.prepare("SELECT id, correct_answer FROM qr_quiz_questions WHERE quiz_id = ? ORDER BY position ASC").all(quiz.id);
  if (!questions.length) throw new Error("This quiz has no questions");

  const existing = db.prepare("SELECT * FROM qr_quiz_responses WHERE quiz_id = ? AND student_id = ?").get(quiz.id, student.id);
  if (existing) {
    return { duplicate: true, response: existing };
  }

  const answers = questions.map((question) => {
    const selected = normalizeQrQuizAnswer(selectedAnswers[question.id]);
    if (!selected) throw new Error("Select an answer for every question");
    return {
      questionId: Number(question.id),
      selected,
      isCorrect: selected === question.correct_answer ? 1 : 0
    };
  });
  const score = answers.reduce((sum, answer) => sum + Number(answer.isCorrect || 0), 0);
  const pitisAwarded = Number(quiz.award_enabled) === 1 ? score * Number(quiz.points_per_correct || 0) : 0;
  const now = dayjs().toISOString();

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO qr_quiz_responses
        (quiz_id, student_id, class_id, score, total_questions, pitis_awarded, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(quiz.id, student.id, student.class_id, score, questions.length, pitisAwarded, now);
    const responseId = Number(info.lastInsertRowid);
    const insertAnswer = db.prepare(`
      INSERT INTO qr_quiz_response_answers (response_id, question_id, selected_answer, is_correct)
      VALUES (?, ?, ?, ?)
    `);
    answers.forEach((answer) => {
      insertAnswer.run(responseId, answer.questionId, answer.selected, answer.isCorrect);
    });
    if (pitisAwarded > 0) {
      db.prepare(`
        INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(student.id, student.class_id, pitisAwarded, `QR Quiz: ${quiz.title}`, awardedBy, now);
      updateDailySnapshot(student.id);
    }
    return db.prepare("SELECT * FROM qr_quiz_responses WHERE id = ?").get(responseId);
  });

  return { duplicate: false, response: tx() };
}

router.get("/dashboard", (req, res) => {
  const pitisProgress = isTeacherUser(req.session.user)
    ? buildTeacherProgressSummary(req.session.user.id)
    : null;
  res.render("teacher-dashboard", { user: req.session.user, pitisProgress });
});
router.get("/tools", (req, res) => {
  res.render("teacher-tools", {
    user: req.session.user,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/qr-tools", (req, res) => {
  res.render("teacher-qr-tools", {
    user: req.session.user,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.all(/^\/tools\/qr-quiz(?:\/.*)?$/, (req, res) => {
  if (req.accepts("html")) return res.status(404).send("QR Quiz has been removed from teacher tools.");
  return res.status(404).json({ success: false, error: "QR Quiz has been removed from teacher tools." });
});

router.get("/tools/qr-quiz", async (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const quizzes = await Promise.all(fetchQrQuizList().map((quiz) => buildQrQuizCardData(req, quiz)));
  res.render("teacher-qr-quiz", {
    user: req.session.user,
    classes,
    quizzes,
    editingQuiz: null,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/tools/qr-quiz", (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    if (!title) {
      return res.redirect(`/teacher/tools/qr-quiz?error=${encodeURIComponent("Quiz title is required")}`);
    }

    const targetType = "class";
    const selectedClasses = parseQrQuizTargetClasses(req.body);
    const classId = selectedClasses[0] ? selectedClasses[0].id : null;

    const questions = parseQrQuizQuestions(req.body);
    const awardEnabled = String(req.body.award_enabled || "") === "1" ? 1 : 0;
    const pointsPerCorrect = awardEnabled ? normalizePositiveInteger(req.body.points_per_correct, 1) : 0;
    const requestedAction = String(req.body.quiz_action || "draft").trim();
    const status = requestedAction === "activate" ? "active" : "draft";
    const now = dayjs().toISOString();
    const token = generateQrQuizToken();

    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO qr_quizzes
          (title, target_type, target_class_id, status, award_enabled, points_per_correct, access_token, created_by, created_at, updated_at, activated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        title,
        targetType,
        classId,
        status,
        awardEnabled,
        pointsPerCorrect,
        token,
        req.session.user.id,
        now,
        now,
        status === "active" ? now : null
      );
      const quizId = Number(info.lastInsertRowid);
      const insertQuestion = db.prepare(`
        INSERT INTO qr_quiz_questions
          (quiz_id, position, question_text, option_a, option_b, option_c, correct_answer)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      questions.forEach((question) => {
        insertQuestion.run(quizId, question.position, question.question, question.optionA, question.optionB, question.optionC, question.correct);
      });
      const insertTargetClass = db.prepare("INSERT INTO qr_quiz_target_classes (quiz_id, class_name, class_id) VALUES (?, ?, ?)");
      selectedClasses.forEach((targetClass) => {
        insertTargetClass.run(quizId, targetClass.name, targetClass.id);
      });
      return quizId;
    });

    const quizId = tx();
    const message = status === "active" ? "QR Quiz created and activated" : "QR Quiz saved as draft";
    return res.redirect(`/teacher/tools/qr-quiz/${quizId}?success=${encodeURIComponent(message)}`);
  } catch (error) {
    return res.redirect(`/teacher/tools/qr-quiz?error=${encodeURIComponent(error.message || "Unable to save QR Quiz")}`);
  }
});

router.get("/tools/qr-quiz/:quizId/edit", async (req, res) => {
  const quizId = Number(req.params.quizId || 0);
  const quiz = getQrQuizForTeacher(quizId);
  if (!quiz) return res.status(404).send("QR Quiz not found");
  if (quiz.status !== "draft") {
    return res.redirect(`/teacher/tools/qr-quiz/${quizId}?error=${encodeURIComponent("Only draft quizzes can be edited")}`);
  }
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const quizzes = await Promise.all(fetchQrQuizList().map((row) => buildQrQuizCardData(req, row)));
  res.render("teacher-qr-quiz", {
    user: req.session.user,
    classes,
    quizzes,
    editingQuiz: quiz,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/tools/qr-quiz/:quizId/edit", (req, res) => {
  const quizId = Number(req.params.quizId || 0);
  try {
    const quiz = getQrQuizForTeacher(quizId);
    if (!quiz) return res.status(404).send("QR Quiz not found");
    if (quiz.status !== "draft") {
      return res.redirect(`/teacher/tools/qr-quiz/${quizId}?error=${encodeURIComponent("Only draft quizzes can be edited")}`);
    }

    const title = String(req.body.title || "").trim();
    if (!title) {
      return res.redirect(`/teacher/tools/qr-quiz/${quizId}/edit?error=${encodeURIComponent("Quiz title is required")}`);
    }

    const selectedClasses = parseQrQuizTargetClasses(req.body);
    const questions = parseQrQuizQuestions(req.body);
    const awardEnabled = String(req.body.award_enabled || "") === "1" ? 1 : 0;
    const pointsPerCorrect = awardEnabled ? normalizePositiveInteger(req.body.points_per_correct, 1) : 0;
    const requestedAction = String(req.body.quiz_action || "draft").trim();
    const status = requestedAction === "activate" ? "active" : "draft";
    const now = dayjs().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE qr_quizzes
        SET title = ?, target_type = 'class', target_class_id = ?, status = ?,
            award_enabled = ?, points_per_correct = ?, updated_at = ?,
            activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, ?) ELSE activated_at END
        WHERE id = ?
      `).run(
        title,
        selectedClasses[0] ? selectedClasses[0].id : null,
        status,
        awardEnabled,
        pointsPerCorrect,
        now,
        status,
        now,
        quizId
      );
      db.prepare("DELETE FROM qr_quiz_questions WHERE quiz_id = ?").run(quizId);
      db.prepare("DELETE FROM qr_quiz_target_classes WHERE quiz_id = ?").run(quizId);

      const insertQuestion = db.prepare(`
        INSERT INTO qr_quiz_questions
          (quiz_id, position, question_text, option_a, option_b, option_c, correct_answer)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      questions.forEach((question) => {
        insertQuestion.run(quizId, question.position, question.question, question.optionA, question.optionB, question.optionC, question.correct);
      });

      const insertTargetClass = db.prepare("INSERT INTO qr_quiz_target_classes (quiz_id, class_name, class_id) VALUES (?, ?, ?)");
      selectedClasses.forEach((targetClass) => {
        insertTargetClass.run(quizId, targetClass.name, targetClass.id);
      });
    })();

    const message = status === "active" ? "QR Quiz updated and activated" : "QR Quiz draft updated";
    return res.redirect(`/teacher/tools/qr-quiz/${quizId}?success=${encodeURIComponent(message)}`);
  } catch (error) {
    return res.redirect(`/teacher/tools/qr-quiz/${quizId}/edit?error=${encodeURIComponent(error.message || "Unable to update QR Quiz")}`);
  }
});

router.get("/tools/qr-quiz/:quizId", async (req, res) => {
  const quizId = Number(req.params.quizId || 0);
  const quiz = getQrQuizForTeacher(quizId);
  if (!quiz) return res.status(404).send("QR Quiz not found");
  const quizCard = await buildQrQuizCardData(req, quiz);
  const results = fetchQrQuizResults(quizId);
  res.render("teacher-qr-quiz-results", {
    user: req.session.user,
    quiz: quizCard,
    results,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/tools/qr-quiz/:quizId/answer-sheets.pdf", (req, res) => {
  const quizId = Number(req.params.quizId || 0);
  const quiz = getQrQuizForTeacher(quizId);
  if (!quiz) return res.status(404).send("QR Quiz not found");
  const students = fetchQrQuizTargetStudents(quiz);
  if (!students.length) return res.status(404).send("No students found for this quiz target");
  const pdf = buildQrQuizAnswerSheetPdf(quiz, students);
  const safeName = String(quiz.title || "qr-quiz").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "qr-quiz";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${safeName}-answer-sheets.pdf`);
  return res.send(pdf);
});

router.get("/tools/qr-quiz/:quizId/scan-sheets", (req, res) => {
  return res.status(404).send("QR Quiz answer sheet scanning has been removed.");
  const quizId = Number(req.params.quizId || 0);
  const quiz = getQrQuizForTeacher(quizId);
  if (!quiz) return res.status(404).send("QR Quiz not found");
  res.render("teacher-qr-quiz-scan", {
    user: req.session.user,
    quiz,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/tools/qr-quiz/:quizId/scan-sheet/lookup", (req, res) => {
  return res.status(404).json({ success: false, error: "QR Quiz answer sheet scanning has been removed." });
  try {
    const quizId = Number(req.params.quizId || 0);
    const quiz = getQrQuizForTeacher(quizId);
    if (!quiz) return res.status(404).json({ success: false, error: "QR Quiz not found" });

    const parsed = parseQrQuizSheetPayload(req.body.qr_text);
    if (parsed.quizId !== Number(quiz.id) || parsed.accessToken !== String(quiz.access_token || "")) {
      return res.status(400).json({ success: false, error: "This answer sheet belongs to another quiz" });
    }

    const student = db.prepare(`
      SELECT s.id, s.class_id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE s.id = ?
    `).get(parsed.studentId);
    if (!student) return res.status(404).json({ success: false, error: "Student not found" });
    if (!studentMatchesQrQuizTarget(quiz, student)) {
      return res.status(400).json({ success: false, error: "This student is not in the quiz target class" });
    }

    const existing = db.prepare("SELECT * FROM qr_quiz_responses WHERE quiz_id = ? AND student_id = ?").get(quiz.id, student.id);
    const qrPayload = buildQrQuizSheetPayload(quiz, student, parsed.sheetPage || null, parsed.sheetSlot || null);
    return res.json({
      success: true,
      student,
      existing: existing || null,
      sheet_page: parsed.sheetPage || null,
      sheet_slot: parsed.sheetSlot || null,
      qr_module_count: QRCode.create(qrPayload, { errorCorrectionLevel: "M" }).modules.size,
      questions: quiz.questions.map((question) => ({
        id: question.id,
        position: question.position,
        question_text: question.question_text,
        option_a: question.option_a,
        option_b: question.option_b,
        option_c: question.option_c
      }))
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to read answer sheet QR" });
  }
});

router.post("/tools/qr-quiz/:quizId/scan-sheet/process-image", (req, res) => {
  return res.status(404).json({ success: false, error: "QR Quiz answer sheet scanning has been removed." });
  try {
    const quizId = Number(req.params.quizId || 0);
    const quiz = getQrQuizForTeacher(quizId);
    if (!quiz) return res.status(404).json({ success: false, error: "QR Quiz not found" });

    const parsed = parseQrQuizSheetPayload(req.body.qr_text);
    if (parsed.quizId !== Number(quiz.id) || parsed.accessToken !== String(quiz.access_token || "")) {
      return res.status(400).json({ success: false, error: "This answer sheet belongs to another quiz" });
    }

    const student = db.prepare(`
      SELECT s.id, s.class_id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE s.id = ?
    `).get(parsed.studentId);
    if (!student) return res.status(404).json({ success: false, error: "Student not found" });
    if (!studentMatchesQrQuizTarget(quiz, student)) {
      return res.status(400).json({ success: false, error: "This student is not in the quiz target class" });
    }

    const existing = db.prepare("SELECT * FROM qr_quiz_responses WHERE quiz_id = ? AND student_id = ?").get(quiz.id, student.id);
    if (existing) {
      return res.json({
        success: true,
        complete: true,
        duplicate: true,
        student,
        response: existing,
        message: "This student was already graded"
      });
    }

    const detection = processQrQuizCaptureImage(quiz, parsed, req.body.image || {});
    if (!detection.complete) {
      return res.json({
        success: true,
        complete: false,
        student,
        message: detection.message,
        debugRows: detection.debugRows || []
      });
    }

    const result = gradeQrQuizResponse({
      quiz,
      student,
      selectedAnswers: detection.answers,
      awardedBy: Number(req.session.user.id)
    });

    return res.json({
      success: true,
      complete: true,
      duplicate: result.duplicate,
      student,
      response: result.response,
      message: detection.message,
      debugRows: detection.debugRows || []
    });
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return res.status(409).json({ success: false, error: "This student has already been graded for this quiz" });
    }
    return res.status(400).json({ success: false, error: error.message || "Unable to process answer sheet image" });
  }
});

router.post("/tools/qr-quiz/:quizId/scan-sheet/grade", (req, res) => {
  return res.status(404).json({ success: false, error: "QR Quiz answer sheet scanning has been removed." });
  try {
    const quizId = Number(req.params.quizId || 0);
    const quiz = getQrQuizForTeacher(quizId);
    if (!quiz) return res.status(404).json({ success: false, error: "QR Quiz not found" });

    const studentId = Number(req.body.student_id || 0);
    const student = db.prepare(`
      SELECT s.id, s.class_id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE s.id = ?
    `).get(studentId);
    if (!student) return res.status(404).json({ success: false, error: "Student not found" });
    if (!studentMatchesQrQuizTarget(quiz, student)) {
      return res.status(400).json({ success: false, error: "This student is not in the quiz target class" });
    }

    const selectedAnswers = {};
    Object.keys(req.body || {}).forEach((key) => {
      const match = key.match(/^answer_(\d+)$/);
      if (match) selectedAnswers[Number(match[1])] = req.body[key];
    });

    const result = gradeQrQuizResponse({
      quiz,
      student,
      selectedAnswers,
      awardedBy: Number(req.session.user.id)
    });

    return res.json({
      success: true,
      duplicate: result.duplicate,
      student,
      response: result.response
    });
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return res.status(409).json({ success: false, error: "This student has already been graded for this quiz" });
    }
    return res.status(400).json({ success: false, error: error.message || "Unable to grade answer sheet" });
  }
});

router.post("/tools/qr-quiz/:quizId/status", (req, res) => {
  const quizId = Number(req.params.quizId || 0);
  const action = String(req.body.action || "").trim();
  const quiz = getQrQuizForTeacher(quizId);
  if (!quiz) return res.status(404).send("QR Quiz not found");

  const now = dayjs().toISOString();
  if (action === "activate") {
    if (!quiz.questions.length) {
      return res.redirect(`/teacher/tools/qr-quiz/${quizId}?error=${encodeURIComponent("Add questions before activating")}`);
    }
    if (!quiz.targetClasses || !quiz.targetClasses.length) {
      return res.redirect(`/teacher/tools/qr-quiz/${quizId}?error=${encodeURIComponent("Select at least one target class before activating")}`);
    }
    db.prepare("UPDATE qr_quizzes SET status = 'active', activated_at = COALESCE(activated_at, ?), closed_at = NULL, updated_at = ? WHERE id = ?")
      .run(now, now, quizId);
    return res.redirect(`/teacher/tools/qr-quiz/${quizId}?success=${encodeURIComponent("QR Quiz activated")}`);
  }

  if (action === "close") {
    db.prepare("UPDATE qr_quizzes SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(now, now, quizId);
    return res.redirect(`/teacher/tools/qr-quiz/${quizId}?success=${encodeURIComponent("QR Quiz closed")}`);
  }

  return res.redirect(`/teacher/tools/qr-quiz/${quizId}?error=${encodeURIComponent("Invalid QR Quiz action")}`);
});

router.post("/tools/qr-quiz/:quizId/delete", (req, res) => {
  const quizId = Number(req.params.quizId || 0);
  const quiz = getQrQuizForTeacher(quizId);
  if (!quiz) return res.status(404).send("QR Quiz not found");

  if (Number(quiz.response_count || 0) > 0) {
    const now = dayjs().toISOString();
    db.prepare("UPDATE qr_quizzes SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, quizId);
    return res.redirect(`/teacher/tools/qr-quiz?success=${encodeURIComponent("QR Quiz archived because responses already exist")}`);
  }

  db.transaction(() => {
    db.prepare("DELETE FROM qr_quiz_questions WHERE quiz_id = ?").run(quizId);
    db.prepare("DELETE FROM qr_quiz_target_classes WHERE quiz_id = ?").run(quizId);
    db.prepare("DELETE FROM qr_quizzes WHERE id = ?").run(quizId);
  })();
  return res.redirect(`/teacher/tools/qr-quiz?success=${encodeURIComponent("QR Quiz deleted")}`);
});

router.get("/tools/random-selector", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-tool-random", {
    user: req.session.user,
    classes,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/tools/group-maker", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-tool-groups", {
    user: req.session.user,
    classes,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/tools/random-groups", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-tool-random-groups", {
    user: req.session.user,
    classes,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/tools/class/:classId/students", (req, res) => {
  const classKey = String(req.params.classId || "").trim();
  if (!classKey) return res.status(400).json({ error: "Class is required" });

  if (classKey === "all-school") {
    const students = db
      .prepare(
        `SELECT s.id, s.student_id, s.no_sb, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, s.class_id, c.name AS class_name,
                NULLIF(s.photo_path, '') AS photo_src
         FROM students s
         JOIN classes c ON c.id = s.class_id
         ORDER BY COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC`
      )
      .all();

    return res.json({ cls: { id: "all-school", name: "All Students in School" }, students });
  }

  const classId = Number(classKey || 0);
  if (!classId) return res.status(400).json({ error: "Class is required" });

  const cls = db.prepare("SELECT id, name FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const students = db
    .prepare(
      `SELECT s.id, s.student_id, s.no_sb, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, s.class_id, c.name AS class_name,
              NULLIF(s.photo_path, '') AS photo_src
       FROM students s
       JOIN classes c ON c.id = s.class_id
       WHERE s.class_id = ?
       ORDER BY COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC`
    )
    .all(classId);

  return res.json({ cls, students });
});

router.post("/tools/random-selector/award", (req, res) => {
  const studentId = Number(req.body.student_id || 0);
  const requestedClassId = Number(req.body.class_id || 0);
  const points = Number(req.body.points || 0);

  if (!studentId) {
    return res.status(400).json({ error: "Student is required" });
  }
  if (![1, 2].includes(points)) {
    return res.status(400).json({ error: "Only +1 or +2 is allowed" });
  }

  const student = requestedClassId
    ? db.prepare("SELECT id, COALESCE(NULLIF(name, ''), full_name) AS nickname, full_name, class_id FROM students WHERE id = ? AND class_id = ?").get(studentId, requestedClassId)
    : db.prepare("SELECT id, COALESCE(NULLIF(name, ''), full_name) AS nickname, full_name, class_id FROM students WHERE id = ?").get(studentId);
  if (!student) {
    return res.status(404).json({ error: "Student not found" });
  }

  const now = dayjs().toISOString();
  const reason = `Tool: Random Selector +${points}`;

  db.prepare(
    `INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(studentId, Number(student.class_id), points, reason, req.session.user.id, now);

  updateDailySnapshot(studentId);

  return res.json({
    success: true,
    student: {
      id: student.id,
      nickname: student.nickname,
      full_name: student.full_name
    },
    points,
    reason
  });
});
router.get("/reward", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-classes", { classes, mode: "reward" });
});

router.get("/reward/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const classes = db.prepare(`
    SELECT c.id, c.name, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.name
  `).all();
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");

  const students = db
    .prepare(
      `SELECT s.id, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, s.full_name, NULLIF(s.photo_path, '') AS photo_src, COALESCE(SUM(pl.points), 0) AS total_points
       FROM students s
       LEFT JOIN point_logs pl ON pl.student_id = s.id
       WHERE s.class_id = ?
       GROUP BY s.id
       ORDER BY COALESCE(NULLIF(s.name, ''), s.full_name) ASC`
    )
    .all(classId);

  const reasons = db.prepare("SELECT id, reason, reason_type, is_custom FROM point_reasons ORDER BY reason_type ASC, reason ASC").all();
  const customReasons = reasons.filter((r) => Number(r.is_custom) === 1);
  const canAttributeAwards = req.session.user.role === "admin";
  const awardTeachers = canAttributeAwards
    ? db.prepare(
      `SELECT id, display_name, username, role
       FROM users
       WHERE role IN ('teacher', 'staff') AND COALESCE(is_active, 1) = 1
       ORDER BY LOWER(display_name), LOWER(username)`
    ).all()
    : [];
  const shortcutClasses = buildShortcutClasses(classes, classId);
  res.render("teacher-reward", {
    cls,
    classes,
    shortcutClasses,
    students,
    reasons,
    customReasons,
    canAttributeAwards,
    awardTeachers,
    defaultAwardDate: dayjs().format("YYYY-MM-DD"),
    user: req.session.user,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/reward/award", async (req, res) => {
  const pickLast = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
  const normalizeStudentIds = (value) => {
    const rawValues = Array.isArray(value) ? value : [value];
    return [...new Set(rawValues.flatMap((item) => String(item || "").split(","))
      .map((item) => Number(item.trim()))
      .filter((id) => Number.isInteger(id) && id > 0))];
  };

  const classId = Number(pickLast(req.body.class_id));
  const action = String(pickLast(req.body.point_action) || "").trim().toLowerCase();
  const amount = Number(pickLast(req.body.points));
  const studentIds = normalizeStudentIds(req.body.student_ids || req.body.student_id);

  let awardedByUserId = Number(req.session.user.id);
  let awardedByUser = req.session.user;
  let awardDate = dayjs().format("YYYY-MM-DD");

  if (req.session.user.role === "admin") {
    awardedByUserId = Number(pickLast(req.body.awarded_by_user_id) || 0);
    awardedByUser = db.prepare(
      `SELECT id, display_name, username, role
       FROM users
       WHERE id = ?
         AND role IN ('teacher', 'staff')
         AND COALESCE(is_active, 1) = 1`
    ).get(awardedByUserId);
    if (!awardedByUser) {
      return res.status(400).send("Select an active teacher or staff account for this award");
    }

    awardDate = String(pickLast(req.body.award_date) || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(awardDate) || !dayjs(awardDate).isValid() || dayjs(awardDate).format("YYYY-MM-DD") !== awardDate) {
      return res.status(400).send("Enter a valid award date");
    }
    if (dayjs(awardDate).isAfter(dayjs(), "day")) {
      return res.status(400).send("Award date cannot be in the future");
    }
  }

  if (!["award", "deduct"].includes(action)) {
    return res.status(400).send("Select Award or Deduct");
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 5) {
    return res.status(400).send("P.I.T.I.S. amount must be a whole number from 1 to 5");
  }

  const points = action === "deduct" ? -amount : amount;
  const reasonType = action === "deduct" ? "negative" : "positive";
  const reasonBase = (req.body.reason || "").trim();
  const customReason = (req.body.custom_reason || "").trim();
  const reason = customReason || reasonBase;
  if (!reason) {
    return res.status(400).send("Reason is required");
  }

  if (!studentIds.length) {
    return res.status(400).send("Select at least one student");
  }

  const now = req.session.user.role === "admin"
    ? dayjs(`${awardDate}T12:00:00`).toISOString()
    : dayjs().toISOString();

  if (reasonBase && !customReason) {
    const selectedReason = db.prepare("SELECT reason_type FROM point_reasons WHERE reason = ?").get(reasonBase);
    if (!selectedReason) {
      return res.status(400).send("Selected reason not found");
    }
    const selectedType = String(selectedReason.reason_type || "positive").toLowerCase();
    if (selectedType !== reasonType) {
      return res.status(400).send("Selected reason type does not match points sign");
    }
  }

  if (customReason) {
    const existingReason = db.prepare("SELECT id, reason_type FROM point_reasons WHERE reason = ?").get(customReason);
    if (existingReason) {
      const existingType = String(existingReason.reason_type || "positive").toLowerCase();
      if (existingType !== reasonType) {
        return res.status(400).send("Custom reason already exists with opposite type. Use a different reason text.");
      }
    } else {
      db.prepare(
        `INSERT INTO point_reasons (reason, reason_type, created_by, is_custom, created_at)
         VALUES (?, ?, ?, 1, ?)`
      ).run(customReason, reasonType, req.session.user.id, now);
    }
  }

  const placeholders = studentIds.map(() => "?").join(",");
  const students = db.prepare(`SELECT id, class_id FROM students WHERE class_id = ? AND id IN (${placeholders})`).all(classId, ...studentIds);
  if (students.length !== studentIds.length) {
    return res.status(404).send("One or more selected students were not found in this class");
  }

  const insertPointLog = db.prepare(
    `INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const progressUser = db.prepare("SELECT id,role,user_type FROM users WHERE id=?").get(awardedByUserId);
  const canReportProgress = action === "award" && isTeacherUser(progressUser);
  const positiveAwardsBefore = canReportProgress
    ? Number(db.prepare("SELECT COUNT(*) AS total FROM point_logs WHERE awarded_by=? AND points>0 AND date(awarded_at)=date(?)").get(awardedByUserId, now).total || 0)
    : 0;
  const progressBefore = canReportProgress
    ? buildTeacherProgressSummary(awardedByUserId, { asOf: awardDate }).currentTeacher
    : null;

  db.transaction(() => {
    students.forEach((student) => {
      insertPointLog.run(student.id, Number(student.class_id), points, reason, awardedByUserId, now);
      updateDailySnapshot(student.id);
    });
  })();

  const actionLabel = action === "deduct" ? "Deducted" : "Awarded";
  const attribution = req.session.user.role === "admin"
    ? ` on behalf of ${awardedByUser.display_name || awardedByUser.username} for ${awardDate}`
    : "";
  let progressMessage = "";
  if (canReportProgress) {
    const summary = buildTeacherProgressSummary(awardedByUserId, { asOf: awardDate });
    const progress = summary.currentTeacher;
    const targetWasMet = Boolean(progressBefore && progressBefore.requiredDays > 0 && progressBefore.activeDays >= progressBefore.requiredDays);
    const targetIsNowMet = Boolean(progress && progress.requiredDays > 0 && progress.activeDays >= progress.requiredDays);
    const targetJustMet = !targetWasMet && targetIsNowMet;
    const showDetailedProgress = positiveAwardsBefore === 0 || targetJustMet;
    if (progress && showDetailedProgress) {
      const remaining = Math.max(0, progress.requiredDays - progress.activeDays);
      progressMessage = progress.requiredDays > 0
        ? ` This week: ${progress.activeDays} of ${progress.requiredDays} target days (${progress.percentage}%).${remaining ? ` ${remaining} more active day${remaining === 1 ? "" : "s"} needed.` : " Weekly target met."}`
        : " PITIS activity recorded; there is no active weekly target today.";
      await notifyUser(awardedByUserId, {
        type: "pitis_progress",
        title: targetJustMet ? "Weekly PITIS target met" : "Today's PITIS progress",
        message: progress.requiredDays > 0
          ? `${actionLabel} ${Math.abs(points)} PITIS for ${students.length} student${students.length === 1 ? "" : "s"}. Week ${summary.weekNumber}: ${progress.activeDays} of ${progress.requiredDays} target days (${progress.percentage}%).`
          : `${actionLabel} ${Math.abs(points)} PITIS for ${students.length} student${students.length === 1 ? "" : "s"}. No weekly target is active today.`,
        url: "/teacher/dashboard#pitis-progress",
        entityType: "pitis_progress_day",
        entityId: Number(awardDate.replace(/-/g, "")),
        preferenceKey: "pitis_progress"
      });
    }
  }
  const message = `${actionLabel} ${Math.abs(points)} pitis for ${students.length} student${students.length === 1 ? "" : "s"}${attribution}.${progressMessage}`;
  res.redirect(`/teacher/reward/${classId}?success=${encodeURIComponent(message)}`);
});

router.post("/reasons/manage", (req, res) => {
  const requestedClassId = Number(req.body.class_id || 0);
  const reasonId = Number(req.body.reason_id || 0);
  const operation = String(req.body.operation || "").trim().toLowerCase();
  const newReason = String(req.body.new_reason || "").trim();

  const redirectBase = requestedClassId ? `/teacher/reward/${requestedClassId}` : "/teacher/reward";
  if (!reasonId) {
    return res.redirect(`${redirectBase}?error=${encodeURIComponent("Select a custom reason first")}`);
  }
  if (!["edit", "delete"].includes(operation)) {
    return res.redirect(`${redirectBase}?error=${encodeURIComponent("Invalid reason action")}`);
  }

  const target = db.prepare("SELECT id, reason, reason_type, is_custom FROM point_reasons WHERE id = ?").get(reasonId);
  if (!target || Number(target.is_custom) !== 1) {
    return res.redirect(`${redirectBase}?error=${encodeURIComponent("Only custom reasons can be managed")}`);
  }

  if (operation === "edit") {
    if (!newReason) {
      return res.redirect(`${redirectBase}?error=${encodeURIComponent("New reason text is required for edit")}`);
    }
    if (newReason === target.reason) {
      return res.redirect(`${redirectBase}?success=${encodeURIComponent("No changes applied")}`);
    }

    const existing = db.prepare("SELECT id FROM point_reasons WHERE reason = ? AND id <> ?").get(newReason, reasonId);
    if (existing) {
      return res.redirect(`${redirectBase}?error=${encodeURIComponent("Reason already exists")}`);
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE point_reasons SET reason = ? WHERE id = ? AND is_custom = 1").run(newReason, reasonId);
      db.prepare("UPDATE point_logs SET reason = ? WHERE reason = ?").run(newReason, target.reason);
    });
    tx();

    return res.redirect(`${redirectBase}?success=${encodeURIComponent("Custom reason updated")}`);
  }

  const usage = db.prepare("SELECT COUNT(*) AS total FROM point_logs WHERE reason = ?").get(target.reason);
  if (Number((usage || {}).total || 0) > 0) {
    return res.redirect(
      `${redirectBase}?error=${encodeURIComponent("Cannot delete: this reason is already used in point history. Edit it instead.")}`
    );
  }

  db.prepare("DELETE FROM point_reasons WHERE id = ? AND is_custom = 1").run(reasonId);
  return res.redirect(`${redirectBase}?success=${encodeURIComponent("Custom reason deleted")}`);
});
router.get("/students", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  res.render("teacher-classes", { classes, mode: "students" });
});


function getStudentDisplayName(student) {
  return String(student.name || student.full_name || student.nickname || "Student").trim();
}

function getStudentAgeFromDob(dob) {
  const parsed = dayjs(String(dob || "").trim(), "YYYY-MM-DD", true);
  if (!parsed.isValid()) return null;
  const years = dayjs().diff(parsed, "year");
  return years >= 0 ? years : null;
}

function withStudentDisplay(student) {
  const displayName = getStudentDisplayName(student);
  const age = getStudentAgeFromDob(student.dob);
  return {
    ...student,
    display_name: displayName,
    age,
    display_name_with_age: age == null ? displayName : `${displayName} (Age ${age})`
  };
}

const STUDENT_DETAIL_EDIT_COLUMNS = STUDENT_TEMPLATE_COLUMNS.filter((column) => {
  if (!column.key) return false;
  if (column.type === "checkbox-status") return false;
  return true;
});

const STUDENT_DETAIL_EDIT_COLUMN_BY_KEY = new Map(STUDENT_DETAIL_EDIT_COLUMNS.map((column) => [column.key, column]));

function normalizeStudentDetailEditValue(column, rawValue, classRows) {
  if (!column) return normalizeOptionalText(rawValue);
  if (column.key === "class_name") {
    const normalizedName = normalizeClassName(rawValue);
    if (!normalizedName) return null;
    const targetClass = (classRows || []).find((row) => String(row.name || "").toUpperCase() === normalizedName);
    return targetClass ? Number(targetClass.id) : null;
  }
  if (column.type === "date") return normalizeDateValue(rawValue);
  if (column.key === "gender") return normalizeGender(rawValue);
  return normalizeOptionalText(rawValue);
}

function stringifyStudentEditValue(value) {
  return value == null ? "" : String(value).trim();
}

function getStudentShortcutLabel(className) {
  const normalized = String(className || "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "PRA") return "PRA";
  const match = normalized.match(/^(?:YEAR|TAHUN)\s*([1-6])$/);
  if (!match) return null;
  return `YEAR ${match[1]}`;
}

function buildShortcutClasses(classes, activeClassId) {
  const shortcutOrder = ["PRA", "YEAR 1", "YEAR 2", "YEAR 3", "YEAR 4", "YEAR 5", "YEAR 6"];
  return shortcutOrder
    .map((label) => {
      const matching = (classes || []).filter((cls) => getStudentShortcutLabel(cls.name) === label);
      if (!matching.length) return null;
      const preferred = matching.sort((a, b) => {
        if (Number(a.id) === Number(activeClassId)) return -1;
        if (Number(b.id) === Number(activeClassId)) return 1;
        const countDiff = Number(b.student_count || 0) - Number(a.student_count || 0);
        if (countDiff !== 0) return countDiff;
        return String(a.name || "").localeCompare(String(b.name || ""));
      })[0];
      return {
        id: preferred.id,
        displayLabel: label
      };
    })
    .filter(Boolean);
}

function normalizeRewardReportRow(row) {
  const awardedAt = dayjs(row.awarded_at);
  const rawReason = String(row.reason || "").trim();
  const sourceReason = rawReason.startsWith("Kiosk attendance:")
    ? "Attendance Kiosk"
    : rawReason.startsWith("Tool: Random Selector")
      ? "Random Picker"
      : rawReason;

  return {
    date_awarded: awardedAt.isValid() ? awardedAt.format("YYYY-MM-DD") : "",
    time_awarded: awardedAt.isValid() ? awardedAt.format("HH:mm:ss") : "",
    name: String(row.nickname || row.full_name || "").trim(),
    full_name: String(row.full_name || "").trim(),
    class_name: String(row.class_name || "").trim(),
    source_reason: sourceReason,
    points_awarded: Number(row.points || 0),
    awarded_by: String(row.awarded_by || "System").trim() || "System"
  };
}

function fetchRewardReportRows(classId, dateFrom, dateTo, allTime) {
  const baseSelect = `
    SELECT pl.awarded_at, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, s.full_name, c.name AS class_name, pl.points, pl.reason,
           COALESCE(u.display_name, u.username, 'System') AS awarded_by
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    JOIN classes c ON c.id = pl.class_id
    LEFT JOIN users u ON u.id = pl.awarded_by`;

  let rows = [];
  if (classId === "all" && allTime) {
    rows = db.prepare(`${baseSelect} ORDER BY pl.awarded_at DESC`).all();
  } else if (classId === "all" && dateFrom && dateTo) {
    rows = db.prepare(`${baseSelect} WHERE date(pl.awarded_at) BETWEEN ? AND ? ORDER BY pl.awarded_at DESC`).all(dateFrom, dateTo);
  } else if (classId && allTime) {
    rows = db.prepare(`${baseSelect} WHERE pl.class_id = ? ORDER BY pl.awarded_at DESC`).all(classId);
  } else if (classId && dateFrom && dateTo) {
    rows = db.prepare(`${baseSelect} WHERE pl.class_id = ? AND date(pl.awarded_at) BETWEEN ? AND ? ORDER BY pl.awarded_at DESC`).all(classId, dateFrom, dateTo);
  }

  return rows.map(normalizeRewardReportRow);
}

function fetchStudentPitisTotalRows(classId, dateFrom, dateTo, allTime) {
  const logDateFilter = allTime ? "" : "AND date(pl.awarded_at, '+8 hours') BETWEEN ? AND ?";
  const classFilter = classId === "all" ? "" : "WHERE s.class_id = ?";
  const params = [];

  if (!allTime) params.push(dateFrom, dateTo);
  if (classId !== "all") params.push(classId);

  return db.prepare(`
    SELECT s.id AS student_id,
           COALESCE(NULLIF(s.name, ''), s.full_name) AS name,
           s.full_name,
           c.name AS class_name,
           COALESCE(SUM(CASE WHEN pl.points > 0 THEN pl.points ELSE 0 END), 0) AS pitis_collected,
           COALESCE(ABS(SUM(CASE WHEN pl.points < 0 THEN pl.points ELSE 0 END)), 0) AS pitis_deducted,
           COALESCE(SUM(pl.points), 0) AS net_pitis,
           COUNT(pl.id) AS transactions
    FROM students s
    JOIN classes c ON c.id = s.class_id
    LEFT JOIN point_logs pl
      ON pl.student_id = s.id
     ${logDateFilter}
    ${classFilter}
    GROUP BY s.id, s.name, s.full_name, c.name
    ORDER BY c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC
  `).all(...params).map((row) => ({
    student_id: Number(row.student_id),
    name: String(row.name || "").trim(),
    full_name: String(row.full_name || "").trim(),
    class_name: String(row.class_name || "").trim(),
    pitis_collected: Number(row.pitis_collected || 0),
    pitis_deducted: Number(row.pitis_deducted || 0),
    net_pitis: Number(row.net_pitis || 0),
    transactions: Number(row.transactions || 0)
  }));
}

function parseIsoDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed : null;
}

function getMondayForDate(date) {
  return date.subtract((date.day() + 6) % 7, "day").startOf("day");
}

const REPORTING_TOOL_SCHOOL_DAY_OFFSETS = [0, 1, 2, 3, 5];

function getReportingToolUsers() {
  return db.prepare(
    `SELECT id, username, display_name, role,
            COALESCE(user_type, CASE WHEN role = 'staff' THEN 'staff' ELSE role END) AS user_type
     FROM users
     WHERE COALESCE(is_active, 1) = 1
       AND LOWER(COALESCE(role, '')) <> 'admin'
       AND LOWER(COALESCE(user_type, '')) <> 'admin'
     ORDER BY display_name ASC, username ASC`
  ).all().map((row) => ({
    id: Number(row.id),
    username: String(row.username || "").trim(),
    display_name: String(row.display_name || row.username || "User").trim(),
    role: String(row.role || "").trim(),
    user_type: String(row.user_type || row.role || "").trim()
  }));
}

function parseSelectedUserIds(rawUserIds, allowedIds) {
  const rawValues = Array.isArray(rawUserIds) ? rawUserIds : [rawUserIds];
  const ids = rawValues
    .flatMap((value) => String(value || "").split(","))
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isInteger(id) && allowedIds.has(id));
  return Array.from(new Set(ids));
}

function getPublicHolidayDateSet(rangeStart, rangeEnd) {
  const rows = db.prepare(
    `SELECT ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date
     FROM calendar_events ce
     JOIN calendar_event_labels cel ON cel.event_id = ce.id
     JOIN calendar_labels cl ON cl.id = cel.label_id
     WHERE ce.is_deleted = 0
       AND LOWER(cl.name) = 'public holiday'
       AND date(COALESCE(ce.end_date, ce.event_date)) >= date(?)
       AND date(ce.event_date) <= date(?)`
  ).all(rangeStart, rangeEnd);

  const holidayDates = new Set();
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
      holidayDates.add(cursor.format("YYYY-MM-DD"));
      cursor = cursor.add(1, "day");
    }
  });
  return holidayDates;
}

function buildReportingToolWeeks(dateFrom, dateTo, holidayDates) {
  const startWeek = getMondayForDate(dateFrom);
  const endWeek = getMondayForDate(dateTo);
  const weeks = [];
  let cursor = startWeek;
  while (!cursor.isAfter(endWeek, "day")) {
    const days = REPORTING_TOOL_SCHOOL_DAY_OFFSETS.map((offset) => {
      const date = cursor.add(offset, "day");
      const isoDate = date.format("YYYY-MM-DD");
      const isHoliday = holidayDates.has(isoDate);
      return {
        date: isoDate,
        label: date.format("dddd"),
        shortLabel: date.format("ddd"),
        is_holiday: isHoliday,
        is_school_day: !isHoliday
      };
    });
    const schoolDayCount = days.filter((day) => day.is_school_day).length;
    const requiredDays = schoolDayCount > 0 ? Math.ceil(schoolDayCount * 0.6) : 0;
    weeks.push({
      start: cursor.format("YYYY-MM-DD"),
      end: cursor.add(5, "day").format("YYYY-MM-DD"),
      rangeLabel: `${cursor.format("DD MMM YYYY")} - ${cursor.add(5, "day").format("DD MMM YYYY")}`,
      days,
      school_day_count: schoolDayCount,
      required_days: requiredDays,
      requirement_label: `${requiredDays} / ${schoolDayCount} school days`
    });
    cursor = cursor.add(7, "day");
  }
  return weeks;
}

function getDateMap(rows, dateKey) {
  const map = new Map();
  rows.forEach((row) => {
    map.set(String(row[dateKey] || ""), row);
  });
  return map;
}

function buildReportingToolReport(selectedUserIds, dateFromRaw, dateToRaw) {
  const options = arguments[3] || {};
  const dateFrom = parseIsoDate(dateFromRaw);
  const dateTo = parseIsoDate(dateToRaw);
  if (!selectedUserIds.length || !dateFrom || !dateTo || dateTo.isBefore(dateFrom, "day")) {
    return null;
  }

  const users = getReportingToolUsers();
  const userMap = new Map(users.map((user) => [Number(user.id), user]));
  const selectedUsers = selectedUserIds.map((id) => userMap.get(Number(id))).filter(Boolean);
  if (!selectedUsers.length) return null;

  const queryStart = getMondayForDate(dateFrom).format("YYYY-MM-DD");
  const queryEnd = getMondayForDate(dateTo).add(5, "day").format("YYYY-MM-DD");
  const holidayDates = getPublicHolidayDateSet(queryStart, queryEnd);
  let weeks = buildReportingToolWeeks(dateFrom, dateTo, holidayDates);
  const weekLimit = Number(options.weekLimit || 0);
  if (Number.isInteger(weekLimit) && weekLimit > 0) {
    weeks = weeks.slice(-weekLimit);
  }
  const placeholders = selectedUsers.map(() => "?").join(",");
  const ids = selectedUsers.map((user) => Number(user.id));

  const loginRows = db.prepare(
    `SELECT user_id, date(logged_at) AS activity_date, COUNT(*) AS login_count
     FROM user_login_logs
     WHERE user_id IN (${placeholders})
       AND date(logged_at) BETWEEN ? AND ?
     GROUP BY user_id, date(logged_at)`
  ).all(...ids, queryStart, queryEnd);

  const awardRows = db.prepare(
    `SELECT awarded_by AS user_id, date(awarded_at) AS activity_date,
            COUNT(*) AS award_count,
            COUNT(DISTINCT student_id) AS student_count
     FROM point_logs
     WHERE awarded_by IN (${placeholders})
       AND date(awarded_at) BETWEEN ? AND ?
     GROUP BY awarded_by, date(awarded_at)`
  ).all(...ids, queryStart, queryEnd);

  const awardStudentRows = db.prepare(
    `SELECT awarded_by AS user_id, date(awarded_at) AS activity_date, student_id
     FROM point_logs
     WHERE awarded_by IN (${placeholders})
       AND date(awarded_at) BETWEEN ? AND ?`
  ).all(...ids, queryStart, queryEnd);

  const loginByUser = new Map();
  const awardByUser = new Map();
  loginRows.forEach((row) => {
    const userId = Number(row.user_id);
    if (!loginByUser.has(userId)) loginByUser.set(userId, []);
    loginByUser.get(userId).push(row);
  });
  awardRows.forEach((row) => {
    const userId = Number(row.user_id);
    if (!awardByUser.has(userId)) awardByUser.set(userId, []);
    awardByUser.get(userId).push(row);
  });
  const awardedStudentsByUserDate = new Map();
  awardStudentRows.forEach((row) => {
    const key = `${Number(row.user_id)}:${String(row.activity_date || "")}`;
    if (!awardedStudentsByUserDate.has(key)) awardedStudentsByUserDate.set(key, new Set());
    awardedStudentsByUserDate.get(key).add(Number(row.student_id));
  });

  const statusFilter = String(options.statusFilter || "all").trim();
  const minUsageDays = options.minUsageDays === "" || options.minUsageDays == null ? null : Number(options.minUsageDays);
  const teacherReports = selectedUsers.map((user) => {
    const loginMap = getDateMap(loginByUser.get(Number(user.id)) || [], "activity_date");
    const awardMap = getDateMap(awardByUser.get(Number(user.id)) || [], "activity_date");
    const weekReports = weeks.map((week) => {
      const days = week.days.map((day) => {
        const login = loginMap.get(day.date);
        const award = awardMap.get(day.date);
        const loginCount = Number(login && login.login_count ? login.login_count : 0);
        const awardCount = Number(award && award.award_count ? award.award_count : 0);
        const studentCount = Number(award && award.student_count ? award.student_count : 0);
        const counted = day.is_school_day && loginCount > 0 && awardCount > 0;
        return {
          ...day,
          login_count: loginCount,
          award_count: awardCount,
          student_count: studentCount,
          has_login: loginCount > 0,
          has_award: awardCount > 0,
          counted
        };
      });
      const validDays = days.filter((day) => day.counted).length;
      const totalLogins = days.reduce((sum, day) => sum + day.login_count, 0);
      const totalAwards = days.reduce((sum, day) => sum + day.award_count, 0);
      const studentIdsAwarded = new Set();
      days.forEach((day) => {
        const key = `${Number(user.id)}:${day.date}`;
        const studentIds = awardedStudentsByUserDate.get(key);
        if (!studentIds) return;
        studentIds.forEach((studentId) => studentIdsAwarded.add(studentId));
      });
      const studentsAwarded = studentIdsAwarded.size;
      const targetMet = validDays >= week.required_days;
      return {
        ...week,
        days,
        valid_days: validDays,
        target_met: targetMet,
        total_logins: totalLogins,
        total_awards: totalAwards,
        students_awarded: studentsAwarded,
        target_percentage: week.required_days > 0 ? Math.min(100, Math.round((validDays / week.required_days) * 100)) : 100,
        progress_percentage: week.school_day_count > 0 ? Math.min(100, Math.round((validDays / week.school_day_count) * 100)) : 100
      };
    }).filter((week) => {
      if (statusFilter === "met" && !week.target_met) return false;
      if (statusFilter === "not_met" && week.target_met) return false;
      if (statusFilter === "no_usage" && (week.total_logins > 0 || week.total_awards > 0)) return false;
      if (Number.isInteger(minUsageDays) && minUsageDays >= 0 && week.valid_days !== minUsageDays) return false;
      return true;
    });

    return {
      ...user,
      weeks: weekReports
    };
  });

  const metCount = teacherReports.reduce((sum, teacher) => sum + teacher.weeks.filter((week) => week.target_met).length, 0);
  const notMetCount = teacherReports.reduce((sum, teacher) => sum + teacher.weeks.filter((week) => !week.target_met).length, 0);
  const totalTeacherWeeks = metCount + notMetCount;
  return {
    users,
    selectedUserIds,
    dateFrom: dateFrom.format("YYYY-MM-DD"),
    dateTo: dateTo.format("YYYY-MM-DD"),
    selectedTeacherCount: selectedUsers.length,
    weekCount: weeks.length,
    visibleTeacherWeekCount: teacherReports.reduce((sum, teacher) => sum + teacher.weeks.length, 0),
    metCount,
    notMetCount,
    meetingPercentage: totalTeacherWeeks ? Math.round((metCount / totalTeacherWeeks) * 100) : 0,
    teacherReports
  };
}

function buildReportingToolVisuals(report) {
  if (!report) return null;
  const weekMap = new Map();
  const teacherSummaries = report.teacherReports.map((teacher) => {
    const totalWeeks = teacher.weeks.length;
    const metWeeks = teacher.weeks.filter((week) => week.target_met).length;
    const totalAwards = teacher.weeks.reduce((sum, week) => sum + Number(week.total_awards || 0), 0);
    const totalLogins = teacher.weeks.reduce((sum, week) => sum + Number(week.total_logins || 0), 0);
    const validDays = teacher.weeks.reduce((sum, week) => sum + Number(week.valid_days || 0), 0);
    const possibleDays = teacher.weeks.reduce((sum, week) => sum + Number(week.school_day_count || 0), 0);

    teacher.weeks.forEach((week) => {
      if (!weekMap.has(week.start)) {
        weekMap.set(week.start, {
          start: week.start,
          label: week.rangeLabel,
          met: 0,
          notMet: 0,
          awards: 0,
          logins: 0
        });
      }
      const entry = weekMap.get(week.start);
      if (week.target_met) entry.met += 1;
      else entry.notMet += 1;
      entry.awards += Number(week.total_awards || 0);
      entry.logins += Number(week.total_logins || 0);
    });

    return {
      id: teacher.id,
      display_name: teacher.display_name,
      username: teacher.username,
      totalWeeks,
      metWeeks,
      notMetWeeks: Math.max(0, totalWeeks - metWeeks),
      totalAwards,
      totalLogins,
      validDays,
      possibleDays,
      meetingPercentage: totalWeeks ? Math.round((metWeeks / totalWeeks) * 100) : 0,
      usageDayPercentage: possibleDays ? Math.round((validDays / possibleDays) * 100) : 0
    };
  }).sort((a, b) => {
    if (b.meetingPercentage !== a.meetingPercentage) return b.meetingPercentage - a.meetingPercentage;
    if (b.validDays !== a.validDays) return b.validDays - a.validDays;
    return String(a.display_name).localeCompare(String(b.display_name));
  });

  const weeklyTrend = Array.from(weekMap.values()).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const maxWeeklyTotal = weeklyTrend.reduce((max, week) => Math.max(max, week.met + week.notMet), 1);
  weeklyTrend.forEach((week) => {
    const total = week.met + week.notMet;
    week.metPercentage = total ? Math.round((week.met / total) * 100) : 0;
    week.barHeight = Math.max(8, Math.round((total / maxWeeklyTotal) * 100));
  });

  const usageBuckets = [0, 1, 2, 3, 4, 5].map((dayCount) => ({
    dayCount,
    count: report.teacherReports.reduce((sum, teacher) => (
      sum + teacher.weeks.filter((week) => Number(week.valid_days || 0) === dayCount).length
    ), 0)
  }));
  const maxBucketCount = usageBuckets.reduce((max, bucket) => Math.max(max, bucket.count), 1);
  usageBuckets.forEach((bucket) => {
    bucket.height = bucket.count ? Math.max(8, Math.round((bucket.count / maxBucketCount) * 100)) : 0;
  });

  return {
    teacherSummaries,
    weeklyTrend,
    usageBuckets
  };
}

function reportingToolReportToCsv(report) {
  const header = [
    "Teacher name",
    "Username",
    "Week start",
    "Week end",
    "Valid target days",
    "School days",
    "Target requirement",
    "Target status",
    "Total logins",
    "Total PITIS awards",
    "Number of students awarded",
    "Percentage of target completed",
    "Monday school day",
    "Monday login",
    "Monday awarded",
    "Monday awards",
    "Monday students",
    "Monday status",
    "Tuesday school day",
    "Tuesday login",
    "Tuesday awarded",
    "Tuesday awards",
    "Tuesday students",
    "Tuesday status",
    "Wednesday school day",
    "Wednesday login",
    "Wednesday awarded",
    "Wednesday awards",
    "Wednesday students",
    "Wednesday status",
    "Thursday school day",
    "Thursday login",
    "Thursday awarded",
    "Thursday awards",
    "Thursday students",
    "Thursday status",
    "Saturday school day",
    "Saturday login",
    "Saturday awarded",
    "Saturday awards",
    "Saturday students",
    "Saturday status"
  ];

  const rows = [];
  report.teacherReports.forEach((teacher) => {
    teacher.weeks.forEach((week) => {
      const values = [
        teacher.display_name,
        teacher.username,
        week.start,
        week.end,
        week.valid_days,
        week.school_day_count,
        week.requirement_label,
        week.target_met ? "Met Target" : "Not Met",
        week.total_logins,
        week.total_awards,
        week.students_awarded,
        `${week.target_percentage}%`
      ];
      week.days.forEach((day) => {
        values.push(
          day.is_school_day ? "Yes" : "No - Public Holiday",
          day.has_login ? "Yes" : "No",
          day.has_award ? "Yes" : "No",
          day.award_count,
          day.student_count,
          day.counted ? "Counted" : "Not Counted"
        );
      });
      rows.push(values);
    });
  });

  return [header, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`).join(",")).join("\n");
}

function normalizeWeekLimit(value) {
  const raw = String(value || "all").trim().toLowerCase();
  if (raw === "4" || raw === "8" || raw === "12") return Number(raw);
  return 0;
}

function normalizeUsageStatusFilter(value) {
  const raw = String(value || "all").trim().toLowerCase();
  return ["all", "met", "not_met", "no_usage"].includes(raw) ? raw : "all";
}

function normalizeUsageDayFilter(value) {
  const raw = String(value || "all").trim().toLowerCase();
  if (raw === "all" || raw === "") return "";
  const days = Number(raw);
  return Number.isInteger(days) && days >= 0 && days <= 5 ? days : "";
}

function normalizeMonthFilter(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(raw) && dayjs(`${raw}-01`).isValid() ? raw : "";
}

router.get("/students/class/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");
  const classes = db.prepare(`
    SELECT c.id, c.name, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.name
  `).all();
  const students = db
    .prepare(
      `SELECT id, name, full_name, dob, NULLIF(photo_path, '') AS photo_src
       FROM students
       WHERE class_id = ?
       ORDER BY COALESCE(NULLIF(name, ''), full_name) ASC`
    )
    .all(classId)
    .map(withStudentDisplay);
  const shortcutClasses = buildShortcutClasses(classes, classId);
  res.render("student-list", { cls, students, shortcutClasses });
});

router.get("/students/:studentId", async (req, res) => {
  const studentPk = Number(req.params.studentId);
  const student = db
    .prepare(
      `SELECT
         s.*,
         c.name AS class_name,
         COALESCE((SELECT SUM(points) FROM point_logs WHERE student_id = s.id), 0) AS total_points,
         COALESCE((
           SELECT COUNT(*)
           FROM attendance_records ar
           JOIN attendance_sessions ans ON ans.id = ar.session_id
           WHERE ar.student_id = s.id
         ), 0) AS attendance_sessions_total,
         COALESCE((
           SELECT SUM(ar.is_present)
           FROM attendance_records ar
           JOIN attendance_sessions ans ON ans.id = ar.session_id
           WHERE ar.student_id = s.id
         ), 0) AS attendance_present_sessions
       FROM students s
       JOIN classes c ON c.id = s.class_id
       WHERE s.id = ?`
    )
    .get(studentPk);
  if (!student) return res.status(404).send("Student not found");
  const studentWithDisplay = withStudentDisplay(student);
  const classes = db.prepare(`
    SELECT c.id, c.name, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.name
  `).all();
  const shortcutClasses = buildShortcutClasses(classes, studentWithDisplay.class_id);

  const groupTitles = {
    basic: "Basic Details",
    school: "School Details",
    father: "Father Details",
    mother: "Mother Details"
  };
  const studentDetailGroups = STUDENT_TEMPLATE_COLUMNS
    .filter((column) => column.key)
    .reduce((groups, column) => {
      const groupKey = column.group || "basic";
      if (!groups[groupKey]) {
        groups[groupKey] = {
          key: groupKey,
          title: groupTitles[groupKey] || "Student Details",
          fields: []
        };
      }

      const rawValue = studentWithDisplay[column.key];
      groups[groupKey].fields.push({
        key: column.key,
        label: column.label,
        type: column.type,
        options: column.options || [],
        editable: STUDENT_DETAIL_EDIT_COLUMN_BY_KEY.has(column.key),
        value: rawValue == null || String(rawValue).trim() === "" ? "-" : String(rawValue),
        editValue: column.key === "class_name" ? studentWithDisplay.class_name : (rawValue == null ? "" : String(rawValue)),
        checked: Number(rawValue || 0) === 1
      });
      return groups;
    }, {});

  const siblings = studentWithDisplay.family_id
    ? db.prepare(`
        SELECT s.id, s.student_id, s.full_name, s.level, c.name AS class_name
        FROM students s
        JOIN classes c ON c.id = s.class_id
        WHERE s.family_id = ? AND s.id <> ?
        ORDER BY s.full_name ASC
      `).all(studentWithDisplay.family_id, studentPk)
    : [];

  const photoSlots = getStudentPhotoSlots(studentWithDisplay);
  const qrCodePayload = buildStudentQrPayload(studentWithDisplay);
  const qrCodeImage = await generateStudentQrDataUrl(studentWithDisplay);

  res.render("student-detail", {
    student: studentWithDisplay,
    siblings,
    classes,
    shortcutClasses,
    studentDetailGroups: Object.values(studentDetailGroups),
    editableStudentColumns: STUDENT_DETAIL_EDIT_COLUMNS,
    photoSlots,
    qrCodePayload,
    qrCodeImage,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post("/students/:studentId/fee-status", (req, res) => {
  const studentPk = Number(req.params.studentId || 0);
  const wantsJson = String(req.headers.accept || "").includes("application/json");

  function respond(statusCode, payload) {
    if (wantsJson) return res.status(statusCode).json(payload);
    const queryKey = payload.success ? "success" : "error";
    const message = payload.message || payload.error || "Unable to update fee status";
    return res.redirect(`/teacher/students/${studentPk}?${queryKey}=${encodeURIComponent(message)}`);
  }

  if (!studentPk) {
    return respond(400, { success: false, error: "Student not found" });
  }

  const student = db.prepare("SELECT id, student_id, full_name, family_id, yiuran_sekolah_paid, yuran_pibg_paid, insuran_paid FROM students WHERE id = ?").get(studentPk);
  if (!student) {
    return respond(404, { success: false, error: "Student not found" });
  }

  const feeStatus = {
    yiuran_sekolah_paid: req.body.yiuran_sekolah_paid ? 1 : 0,
    yuran_pibg_paid: req.body.yuran_pibg_paid ? 1 : 0,
    insuran_paid: req.body.insuran_paid ? 1 : 0
  };

  const updateStudent = db.prepare(
    `UPDATE students
     SET yiuran_sekolah_paid = ?, yuran_pibg_paid = ?, insuran_paid = ?
     WHERE id = ?`
  );
  const updateFamilyPibgStatus = db.prepare("UPDATE students SET yuran_pibg_paid = ? WHERE family_id = ?");
  const insertEditLog = db.prepare(`
    INSERT INTO student_edit_logs
      (student_pk, student_id, student_full_name, field_key, field_label, old_value, new_value, edited_by, edited_by_label, edited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = dayjs().toISOString();
  const editorId = Number((req.session.user || {}).id || 0) || null;
  const editorLabel = String((req.session.user || {}).displayName || (req.session.user || {}).username || "User").trim() || "User";
  const feeLabels = {
    yiuran_sekolah_paid: "Yuran Sekolah",
    yuran_pibg_paid: "Yuran PIBG",
    insuran_paid: "Insuran"
  };
  const familyMembers = student.family_id
    ? db.prepare("SELECT id, student_id, full_name, yuran_pibg_paid FROM students WHERE family_id = ?").all(student.family_id)
    : [student];
  const feeChanges = [];
  ["yiuran_sekolah_paid", "insuran_paid"].forEach((key) => {
    if (Number(student[key] || 0) !== Number(feeStatus[key] || 0)) {
      feeChanges.push({ row: student, key, oldValue: Number(student[key] || 0), newValue: Number(feeStatus[key] || 0) });
    }
  });
  familyMembers.forEach((member) => {
    if (Number(member.yuran_pibg_paid || 0) !== Number(feeStatus.yuran_pibg_paid || 0)) {
      feeChanges.push({ row: member, key: "yuran_pibg_paid", oldValue: Number(member.yuran_pibg_paid || 0), newValue: Number(feeStatus.yuran_pibg_paid || 0) });
    }
  });

  const tx = db.transaction(() => {
    updateStudent.run(
      feeStatus.yiuran_sekolah_paid,
      feeStatus.yuran_pibg_paid,
      feeStatus.insuran_paid,
      studentPk
    );

    if (student.family_id) {
      updateFamilyPibgStatus.run(feeStatus.yuran_pibg_paid, student.family_id);
    }

    feeChanges.forEach((change) => {
      insertEditLog.run(
        change.row.id,
        change.row.student_id || "",
        change.row.full_name || "",
        change.key,
        feeLabels[change.key] || change.key,
        change.oldValue ? "Checked" : "Unchecked",
        change.newValue ? "Checked" : "Unchecked",
        editorId,
        editorLabel,
        now
      );
    });
  });

  tx();
  return respond(200, { success: true, message: "Student fee status updated. Yuran PIBG synced for the family.", feeStatus });
});

router.post("/students/:studentId/details", (req, res) => {
  const studentPk = Number(req.params.studentId || 0);
  if (!studentPk) {
    return res.redirect(`/teacher/students/${studentPk || ""}?error=${encodeURIComponent("Student not found")}`);
  }

  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(studentPk);
  if (!student) {
    return res.status(404).send("Student not found");
  }

  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const classNameById = new Map(classes.map((row) => [Number(row.id), String(row.name || "")]));
  const updates = [];
  const changes = [];

  for (const column of STUDENT_DETAIL_EDIT_COLUMNS) {
    const nextValue = normalizeStudentDetailEditValue(column, req.body[column.key], classes);
    if (column.required && !stringifyStudentEditValue(nextValue)) {
      return res.redirect(`/teacher/students/${studentPk}?error=${encodeURIComponent(`${column.label} is required`)}`);
    }

    if (column.key === "class_name") {
      if (!nextValue) {
        return res.redirect(`/teacher/students/${studentPk}?error=${encodeURIComponent("Class is required")}`);
      }
      const oldClassId = Number(student.class_id || 0);
      if (Number(nextValue) !== oldClassId) {
        updates.push({ dbColumn: "class_id", value: nextValue });
        changes.push({
          field_key: "class_name",
          field_label: "Class",
          old_value: classNameById.get(oldClassId) || String(oldClassId || ""),
          new_value: classNameById.get(Number(nextValue)) || String(nextValue)
        });
      }
      continue;
    }

    const oldValue = student[column.key] == null ? null : student[column.key];
    if (stringifyStudentEditValue(oldValue) !== stringifyStudentEditValue(nextValue)) {
      updates.push({ dbColumn: column.key, value: nextValue });
      changes.push({
        field_key: column.key,
        field_label: column.label,
        old_value: oldValue,
        new_value: nextValue
      });
    }
  }

  if (!changes.length) {
    return res.redirect(`/teacher/students/${studentPk}?success=${encodeURIComponent("No student detail changes detected")}`);
  }

  const now = dayjs().toISOString();
  const editorId = Number((req.session.user || {}).id || 0) || null;
  const editorLabel = String((req.session.user || {}).displayName || (req.session.user || {}).username || "User").trim() || "User";
  const updateSql = `UPDATE students SET ${updates.map((item) => `${item.dbColumn} = ?`).join(", ")} WHERE id = ?`;
  const updateStudent = db.prepare(updateSql);
  const insertLog = db.prepare(`
    INSERT INTO student_edit_logs
      (student_pk, student_id, student_full_name, field_key, field_label, old_value, new_value, edited_by, edited_by_label, edited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    updateStudent.run(...updates.map((item) => item.value), studentPk);
    changes.forEach((change) => {
      insertLog.run(
        studentPk,
        student.student_id || "",
        student.full_name || "",
        change.field_key,
        change.field_label,
        stringifyStudentEditValue(change.old_value),
        stringifyStudentEditValue(change.new_value),
        editorId,
        editorLabel,
        now
      );
    });
  });

  tx();
  return res.redirect(`/teacher/students/${studentPk}?success=${encodeURIComponent(`Student details updated. ${changes.length} change(s) logged.`)}`);
});

router.post("/students/:studentId/photos/:slot/upload", photoUpload.single("photo_file"), (req, res) => {
  try {
    const studentPk = Number(req.params.studentId || 0);
    const slot = Number(req.params.slot || 0);
    if (!studentPk || slot < 1 || slot > 6) {
      return res.redirect(`/teacher/students/${studentPk || ""}?error=${encodeURIComponent("Invalid photo slot")}`);
    }
    if (!req.file) {
      return res.redirect(`/teacher/students/${studentPk}?error=${encodeURIComponent("Photo file is required")}`);
    }

    const photoColumn = getPhotoColumnForSlot(slot);
    const uploadedAtColumn = getPhotoUploadedAtColumnForSlot(slot);
    const uploadedByColumn = getPhotoUploadedByColumnForSlot(slot);
    const existing = db.prepare(`SELECT ${photoColumn} AS current_photo FROM students WHERE id = ?`).get(studentPk);
    if (!existing) {
      return res.redirect(`/teacher/students/${studentPk}?error=${encodeURIComponent("Student not found")}`);
    }

    const nextPhotoPath = normalizePhotoPath(req.file);
    const nowIso = dayjs().toISOString();
    const uploaderId = Number(req.session && req.session.user && req.session.user.id) || null;
    db.prepare(`UPDATE students SET ${photoColumn} = ?, ${uploadedAtColumn} = ?, ${uploadedByColumn} = ? WHERE id = ?`).run(
      nextPhotoPath,
      nowIso,
      uploaderId,
      studentPk
    );

    if (existing.current_photo && existing.current_photo !== nextPhotoPath) {
      removeManagedPhotoIfExists(existing.current_photo);
    }

    return res.redirect(`/teacher/students/${studentPk}?success=${encodeURIComponent(`Photo ${slot} updated`)}`);
  } catch (error) {
    const studentPk = Number(req.params.studentId || 0);
    return res.redirect(`/teacher/students/${studentPk || ""}?error=${encodeURIComponent(error.message || "Unable to upload photo")}`);
  }
});

router.get("/students/code/:externalStudentId", (req, res) => {
  const externalStudentId = String(req.params.externalStudentId || "").trim();
  if (!externalStudentId) return res.status(404).send("Student not found");

  const student = db.prepare("SELECT id FROM students WHERE student_id = ?").get(externalStudentId);
  if (!student) return res.status(404).send("Student not found");

  return res.redirect(`/teacher/students/${student.id}`);
});

router.get("/calendar/labels", (req, res) => {
  res.json({ labels: listCalendarLabels() });
});

router.post("/calendar/labels/add", (req, res) => {
  const name = String(req.body.label_name || "").trim();
  const color = normalizeHexColor(req.body.label_color, "#3f6fae");
  const description = String(req.body.label_description || "").trim();
  const redirectMonth = String(req.body.redirect_month || "").trim();

  if (!name) {
    return res.redirect(`/teacher/calendar?error=${encodeURIComponent("Label name is required")}${redirectMonth ? `&month=${encodeURIComponent(redirectMonth)}` : ""}`);
  }

  try {
    db.prepare(
      `INSERT INTO calendar_labels (name, color, description, created_by, is_system, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(name, color, description || null, req.session.user.id, dayjs().toISOString());

    return res.redirect(`/teacher/calendar?success=${encodeURIComponent("Label created")}${redirectMonth ? `&month=${encodeURIComponent(redirectMonth)}` : ""}`);
  } catch (err) {
    return res.redirect(`/teacher/calendar?error=${encodeURIComponent(`Label creation failed: ${err.message}`)}${redirectMonth ? `&month=${encodeURIComponent(redirectMonth)}` : ""}`);
  }
});


router.get("/calendar/staff", (req, res) => {
  const all = listStaffUsers();
  res.json({
    all,
    teachers: all.filter((u) => u.role === "teacher"),
    staffs: all.filter((u) => u.role === "staff")
  });
});

router.get("/calendar/events", (req, res) => {
  const { monthStart, gridStart, gridEnd } = getCalendarRange(req.query.month);
  const labels = listCalendarLabels();
  const birthdayLabel = labels.find((l) => l.name === "Birthday");
  const bookingLabel = labels.find((l) => l.name === "Device Booking");

  const manual = fetchManualEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: false });
  const birthdays = fetchBirthdayEvents({ rangeStart: gridStart, rangeEnd: gridEnd, birthdayLabel });
  const deviceBookings = fetchDeviceBookingCalendarEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: false, bookingLabel });
  const events = [...manual, ...birthdays, ...deviceBookings].sort((a, b) => {
    if (a.event_date < b.event_date) return -1;
    if (a.event_date > b.event_date) return 1;
    return String(a.title).localeCompare(String(b.title));
  });

  res.json({
    month: monthStart.format("YYYY-MM"),
    range: { start: gridStart.format("YYYY-MM-DD"), end: gridEnd.format("YYYY-MM-DD") },
    labels,
    events
  });
});

router.get("/calendar", (req, res) => {
  const { monthStart, gridStart, gridEnd } = getCalendarRange(req.query.month);
  const selectedLabelIds = parseLabelIds(req.query.label_ids);
  const labels = listCalendarLabels();
  const birthdayLabel = labels.find((l) => l.name === "Birthday");
  const bookingLabel = labels.find((l) => l.name === "Device Booking");

  const manualRangeEvents = fetchManualEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: false });
  const birthdayRangeEvents = fetchBirthdayEvents({ rangeStart: gridStart, rangeEnd: gridEnd, birthdayLabel });
  const deviceBookingRangeEvents = fetchDeviceBookingCalendarEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: false, bookingLabel });
  const eventsForGrid = [...manualRangeEvents, ...birthdayRangeEvents, ...deviceBookingRangeEvents].sort((a, b) => {
    if (a.event_date < b.event_date) return -1;
    if (a.event_date > b.event_date) return 1;
    return String(a.title).localeCompare(String(b.title));
  }).filter((ev) => eventMatchesSelectedLabels(ev, selectedLabelIds));

    const allManualEvents = fetchManualEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: true });
  const allDeviceBookingEvents = fetchDeviceBookingCalendarEvents({ rangeStart: gridStart, rangeEnd: gridEnd, allActive: true, bookingLabel });
  const allTaggableUsers = listStaffUsers();
  const teacherUsers = allTaggableUsers.filter((u) => u.role === "teacher");
  const supportUsers = allTaggableUsers.filter((u) => u.role === "staff");

  const teacherIdSet = new Set(teacherUsers.map((u) => Number(u.id)));
  const staffIdSet = new Set(supportUsers.map((u) => Number(u.id)));

  const allEvents = [...allManualEvents, ...birthdayRangeEvents, ...allDeviceBookingEvents]
    .map((ev) => {
      const tagged = ev.tagged_users || [];
      const taggedIds = tagged.map((u) => Number(u.id));
      const teacherTagged = taggedIds.filter((id) => teacherIdSet.has(id));
      const staffTagged = taggedIds.filter((id) => staffIdSet.has(id));

      let tag_scope = "";
      if (taggedIds.length) {
        if (taggedIds.length === allTaggableUsers.length) {
          tag_scope = "all";
        } else if (teacherTagged.length && !staffTagged.length && teacherTagged.length === teacherUsers.length) {
          tag_scope = "all_teachers";
        } else if (staffTagged.length && !teacherTagged.length && staffTagged.length === supportUsers.length) {
          tag_scope = "all_staffs";
        } else if (teacherTagged.length && !staffTagged.length) {
          tag_scope = "teachers";
        } else if (staffTagged.length && !teacherTagged.length) {
          tag_scope = "staffs";
        } else {
          tag_scope = "all";
        }
      }

      return {
        ...ev,
        canEdit: !ev.is_system,
        canDelete: !ev.is_system && Number(ev.created_by) === Number(req.session.user.id),
        tag_scope,
        tagged_teacher_ids: teacherTagged,
        tagged_staff_ids: staffTagged
      };
    })
    .sort((a, b) => {
      if (a.event_date < b.event_date) return -1;
      if (a.event_date > b.event_date) return 1;
      return String(a.title).localeCompare(String(b.title));
    })
    .filter((ev) => eventMatchesSelectedLabels(ev, selectedLabelIds));

  const deletedLogs = req.session.user.role === "admin"
    ? db
        .prepare(
          `SELECT ce.id, ce.title, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.deleted_at, u.display_name AS deleted_by_name
           FROM calendar_events ce
           LEFT JOIN users u ON u.id = ce.deleted_by
           WHERE ce.is_deleted = 1
           ORDER BY ce.deleted_at DESC
           LIMIT 100`
        )
        .all()
    : [];

  const weeks = buildCalendarWeeks(monthStart, eventsForGrid);

  res.render("teacher-calendar", {
    user: req.session.user,
    monthLabel: monthStart.format("MMMM YYYY"),
    monthKey: monthStart.format("YYYY-MM"),
    prevMonth: monthStart.subtract(1, "month").format("YYYY-MM"),
    nextMonth: monthStart.add(1, "month").format("YYYY-MM"),
    selectedLabelIds,
    weeks,
    allEvents,
    deletedLogs,
    labels,
    teacherUsers,
    staffUsers: supportUsers,
    allTaggableUsers,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/calendar/add", (req, res) => {
  const title = (req.body.title || "").trim();
  const details = (req.body.details || "").trim();
  const eventDate = (req.body.event_date || "").trim();
  const endDate = (req.body.end_date || eventDate).trim();
  const labelIds = parseLabelIds(req.body.label_ids);
  const tagScope = String(req.body.tag_scope || "").trim().toLowerCase();
  const taggedUserIds = resolveTaggedUserIds(tagScope, req.body.tag_teacher_ids, req.body.tag_staff_ids);

  if (!title || !eventDate) return res.status(400).send("Title and start date are required");
  if (dayjs(endDate).isBefore(dayjs(eventDate), "day")) return res.status(400).send("End date cannot be earlier than start date");

  const now = dayjs().toISOString();
  let eventId;
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO calendar_events (title, details, event_date, end_date, event_source, created_by, created_at, is_deleted)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, 0)`
      )
      .run(title, details, eventDate, endDate, req.session.user.id, now);

    eventId = Number(info.lastInsertRowid);
    assignEventLabels(eventId, labelIds);
    assignEventTaggedUsers(eventId, taggedUserIds);
  });

  tx();
  taggedUserIds.forEach(userId => notifyUser(userId, { type: "calendar_tag", title: "Calendar", message: `You were added to ${title}.`, url: `/teacher/calendar?event=${eventId}`, entityType: "calendar_event", entityId: eventId, createdBy: req.session.user.id }));
  scheduleEvent(eventId, includesBirthdayLabel(labelIds) ? [] : taggedUserIds, eventDate, String(req.body.event_time || "09:00"));
  const monthKey = dayjs(eventDate).format("YYYY-MM");
  res.redirect(`/teacher/calendar?month=${monthKey}&success=${encodeURIComponent("Event created")}`);
});

router.post("/calendar/update/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  const title = (req.body.title || "").trim();
  const details = (req.body.details || "").trim();
  const eventDate = (req.body.event_date || "").trim();
  const endDate = (req.body.end_date || eventDate).trim();
  const labelIds = parseLabelIds(req.body.label_ids);
  const tagScope = String(req.body.tag_scope || "").trim().toLowerCase();
  const taggedUserIds = resolveTaggedUserIds(tagScope, req.body.tag_teacher_ids, req.body.tag_staff_ids);

  if (!eventId || !title || !eventDate) {
    return res.status(400).send("Event ID, title and start date are required");
  }
  if (dayjs(endDate).isBefore(dayjs(eventDate), "day")) {
    return res.status(400).send("End date cannot be earlier than start date");
  }

  const target = db
    .prepare("SELECT id FROM calendar_events WHERE id = ? AND is_deleted = 0 AND event_source = 'manual'")
    .get(eventId);
  if (!target) return res.status(404).send("Event not found or not editable");

  let newlyTagged = [];
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE calendar_events
       SET title = ?, details = ?, event_date = ?, end_date = ?
       WHERE id = ? AND is_deleted = 0 AND event_source = 'manual'`
    ).run(title, details, eventDate, endDate, eventId);

    assignEventLabels(eventId, labelIds);
    newlyTagged = assignEventTaggedUsers(eventId, taggedUserIds);
  });

  tx();
  newlyTagged.forEach(userId => notifyUser(userId, { type: "calendar_tag", title: "Calendar", message: `You were added to ${title}.`, url: `/teacher/calendar?event=${eventId}`, entityType: "calendar_event", entityId: eventId, createdBy: req.session.user.id }));
  scheduleEvent(eventId, includesBirthdayLabel(labelIds) ? [] : taggedUserIds, eventDate, String(req.body.event_time || "09:00"));
  const monthKey = dayjs(eventDate).format("YYYY-MM");
  return res.redirect(`/teacher/calendar?month=${monthKey}&success=${encodeURIComponent("Event updated")}`);
});

router.post("/calendar/delete/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).send("Invalid event ID");

  const target = db.prepare(
    "SELECT id,event_date,event_source,created_by FROM calendar_events WHERE id=? AND is_deleted=0"
  ).get(eventId);
  if (!target) return res.status(404).send("Event not found");
  if (String(target.event_source || "manual") !== "manual") {
    return res.status(403).send("System events cannot be deleted");
  }
  if (Number(target.created_by) !== Number(req.session.user.id)) {
    return res.status(403).send("Only the event creator or an administrator can delete this event");
  }

  const now = dayjs().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE calendar_events SET is_deleted=1,deleted_by=?,deleted_at=? WHERE id=? AND is_deleted=0").run(req.session.user.id, now, eventId);
    db.prepare("DELETE FROM calendar_notification_jobs WHERE event_id=? AND status='pending'").run(eventId);
  })();

  const monthKey = dayjs(target.event_date).isValid() ? dayjs(target.event_date).format("YYYY-MM") : dayjs().format("YYYY-MM");
  return res.redirect(`/teacher/calendar?month=${monthKey}&success=${encodeURIComponent("Event deleted")}`);
});

function parseNumberArray(raw) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return Array.from(new Set(values.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)));
}

function normalizeAttendanceDate(raw) {
  const parsed = dayjs(String(raw || '').trim());
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
}

function getAttendanceAbsenteeVisibility(attendanceDate) {
  const selectedDate = dayjs(attendanceDate);
  const today = dayjs();
  const isAfternoon = today.format('HH:mm') >= '12:00';
  if (selectedDate.isValid() && selectedDate.isBefore(today, 'day')) {
    return { showMorningAbsentList: true, showAfternoonAbsentList: true };
  }
  return { showMorningAbsentList: true, showAfternoonAbsentList: isAfternoon };
}

function classHasAfternoonSession(className) {
  const normalized = String(className || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return !['PRA', 'YEAR 1', 'YEAR 6'].includes(normalized);
}

function buildDefaultAttendanceSession() {
  return { is_present: true, absence_reason: '', is_explicit: false };
}

function buildAttendanceStateMap(students, existingRows) {
  const morningMap = new Map();
  const afternoonMap = new Map();
  for (const row of existingRows) {
    const target = row.session_type === 'afternoon' ? afternoonMap : morningMap;
    target.set(Number(row.student_id), {
      is_present: Number(row.is_present) === 1,
      absence_reason: row.absence_reason || '',
      is_explicit: true
    });
  }

  const stateMap = new Map();
  students.forEach((student) => {
    const morning = morningMap.get(Number(student.id)) || buildDefaultAttendanceSession();
    const afternoon = afternoonMap.get(Number(student.id)) || {
      is_present: morning.is_present,
      absence_reason: morning.is_present ? '' : morning.absence_reason,
      is_explicit: false
    };
    stateMap.set(Number(student.id), {
      morning,
      afternoon
    });
  });
  return stateMap;
}

function describeAttendanceChanges(students, currentStateMap, nextStateMap, sessionTypes = ['morning', 'afternoon']) {
  const changes = [];
  students.forEach((student) => {
    const currentState = currentStateMap.get(Number(student.id)) || {
      morning: buildDefaultAttendanceSession(),
      afternoon: buildDefaultAttendanceSession()
    };
    const nextState = nextStateMap.get(Number(student.id)) || currentState;

    sessionTypes.forEach((sessionType) => {
      const currentSession = currentState[sessionType];
      const nextSession = nextState[sessionType];
      if (
        currentSession.is_present !== nextSession.is_present ||
        String(currentSession.absence_reason || '') !== String(nextSession.absence_reason || '')
      ) {
        changes.push(
          `${student.full_name} ${sessionType}: ${currentSession.is_present ? 'Present' : 'Absent'} -> ${nextSession.is_present ? 'Present' : 'Absent'}`
          + `${nextSession.is_present ? '' : ` (${nextSession.absence_reason || 'no reason'})`}`
        );
      }
    });
  });
  return changes;
}

function getAttendancePageData(classId, attendanceDate) {
  const cls = db.prepare('SELECT id, name FROM classes WHERE id = ?').get(classId);
  if (!cls) return null;
  const hasAfternoonSession = classHasAfternoonSession(cls.name);

  const classes = db.prepare('SELECT id, name FROM classes ORDER BY name').all();
  const students = db.prepare(`
    SELECT id, full_name, COALESCE(NULLIF(name, ''), full_name) AS nickname, photo_path
    FROM students
    WHERE class_id = ?
    ORDER BY COALESCE(NULLIF(name, ''), full_name) COLLATE NOCASE ASC, full_name COLLATE NOCASE ASC
  `).all(classId);

  const existingRows = db.prepare(`
    SELECT ar.student_id, ar.is_present, COALESCE(ar.absence_reason, '') AS absence_reason, asn.session_type
    FROM attendance_records ar
    JOIN attendance_sessions asn ON asn.id = ar.session_id
    WHERE asn.class_id = ? AND asn.attendance_date = ?
  `).all(classId, attendanceDate);

  const attendanceStateMap = buildAttendanceStateMap(students, existingRows);

  const attendanceRows = students.map((student) => {
    const state = attendanceStateMap.get(Number(student.id)) || {
      morning: buildDefaultAttendanceSession(),
      afternoon: buildDefaultAttendanceSession()
    };
    const morning = state.morning;
    const afternoon = state.afternoon;
    const sessionCount = hasAfternoonSession ? 2 : 1;
    const presentCount = (morning.is_present ? 1 : 0) + (hasAfternoonSession && afternoon.is_present ? 1 : 0);
    const percentage = Math.round((presentCount / sessionCount) * 100);
    return {
      ...student,
      morning,
      afternoon,
      has_afternoon_session: hasAfternoonSession,
      day_tally: `${presentCount}/${sessionCount}`,
      day_percentage: percentage
    };
  });

  const totalStudents = attendanceRows.length || 1;
  const morningPresent = attendanceRows.filter((row) => row.morning.is_present).length;
  const afternoonPresent = hasAfternoonSession ? attendanceRows.filter((row) => row.afternoon.is_present).length : 0;
  const combinedSlots = attendanceRows.length * (hasAfternoonSession ? 2 : 1);
  const combinedPresent = attendanceRows.reduce((sum, row) => {
    return sum + (row.morning.is_present ? 1 : 0) + (hasAfternoonSession && row.afternoon.is_present ? 1 : 0);
  }, 0);

  const summary = {
    morningPresent,
    afternoonPresent,
    hasAfternoonSession,
    totalStudents: attendanceRows.length,
    morningPercentage: attendanceRows.length ? Math.round((morningPresent / attendanceRows.length) * 100) : 0,
    afternoonPercentage: hasAfternoonSession && attendanceRows.length ? Math.round((afternoonPresent / attendanceRows.length) * 100) : 0,
    dailyPercentage: combinedSlots ? Math.round((combinedPresent / combinedSlots) * 100) : 0
  };

  const latestLog = db.prepare(`
    SELECT action_type, actor_label, details, created_at
    FROM attendance_logs
    WHERE class_id = ? AND attendance_date = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(classId, attendanceDate);

  const recentLogs = db.prepare(`
    SELECT action_type, actor_label, details, created_at
    FROM attendance_logs
    WHERE class_id = ? AND attendance_date = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 8
  `).all(classId, attendanceDate);

  const audit = latestLog || {
    action_type: 'no_change',
    actor_label: 'By system',
    details: 'No attendance changes recorded yet.',
    created_at: ''
  };

  return {
    cls,
    classes,
    attendanceRows,
    attendanceDate,
    hasAfternoonSession,
    summary,
    audit,
    recentLogs,
    ...getAttendanceAbsenteeVisibility(attendanceDate)
  };
}

function getAttendanceSummaryForScope(classId, attendanceDate) {
  const params = [];
  const classFilterSql = Number.isInteger(classId) && classId > 0 ? 'AND s.class_id = ?' : '';
  if (classFilterSql) params.push(classId);

  const students = db.prepare(
    `SELECT s.id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, c.name AS class_name
     FROM students s
     JOIN classes c ON c.id = s.class_id
     WHERE 1 = 1 ${classFilterSql}`
  ).all(...params);

  const totalStudents = students.length;
  if (!totalStudents) {
    return {
      totalStudents: 0,
      morningPresent: 0,
      afternoonPresent: 0,
      morningPercentage: 0,
      afternoonPercentage: 0,
      dailyPercentage: 0,
      combinedPresent: 0,
      combinedSlots: 0,
      morningTally: '0/0',
      afternoonTally: '0/0',
      dailyTally: '0/0',
      hasAfternoonSession: false,
      morningAbsentNames: [],
      afternoonAbsentNames: []
    };
  }

  const attendanceParams = [attendanceDate];
  const attendanceClassFilterSql = Number.isInteger(classId) && classId > 0 ? 'AND asn.class_id = ?' : '';
  if (attendanceClassFilterSql) attendanceParams.push(classId);

  const existingRows = db.prepare(
    `SELECT ar.student_id, ar.is_present, asn.session_type
     FROM attendance_records ar
     JOIN attendance_sessions asn ON asn.id = ar.session_id
     JOIN students s ON s.id = ar.student_id
     WHERE asn.attendance_date = ? ${attendanceClassFilterSql}`
  ).all(...attendanceParams);

  const attendanceStateMap = buildAttendanceStateMap(students, existingRows);

  let morningPresent = 0;
  let afternoonPresent = 0;
  let afternoonSlots = 0;
  const morningAbsentNames = [];
  const afternoonAbsentNames = [];
  for (const student of students) {
    const studentId = Number(student.id);
    const state = attendanceStateMap.get(studentId) || {
      morning: buildDefaultAttendanceSession(),
      afternoon: buildDefaultAttendanceSession()
    };
    const hasAfternoonSession = classHasAfternoonSession(student.class_name);
    const morningIsPresent = !!state.morning.is_present;
    const afternoonIsPresent = !!state.afternoon.is_present;
    const preferredName = String(student.nickname || student.full_name || '').trim();
    const displayName = Number.isInteger(classId) && classId > 0
      ? preferredName
      : `${preferredName} (${String(student.class_name || '').trim()})`;

    if (morningIsPresent) {
      morningPresent += 1;
    } else {
      morningAbsentNames.push(displayName);
    }

    if (hasAfternoonSession) {
      afternoonSlots += 1;
      if (afternoonIsPresent) {
        afternoonPresent += 1;
      } else {
        afternoonAbsentNames.push(displayName);
      }
    }
  }

  const combinedPresent = morningPresent + afternoonPresent;
  const combinedSlots = totalStudents + afternoonSlots;

  return {
    totalStudents,
    morningPresent,
    afternoonPresent,
    morningPercentage: Math.round((morningPresent / totalStudents) * 100),
    afternoonPercentage: afternoonSlots ? Math.round((afternoonPresent / afternoonSlots) * 100) : 0,
    dailyPercentage: Math.round((combinedPresent / combinedSlots) * 100),
    combinedPresent,
    combinedSlots,
    morningTally: `${morningPresent}/${totalStudents}`,
    afternoonTally: `${afternoonPresent}/${afternoonSlots}`,
    dailyTally: `${combinedPresent}/${combinedSlots}`,
    hasAfternoonSession: afternoonSlots > 0,
    morningAbsentNames,
    afternoonAbsentNames
  };
}

function getAttendanceQrSessionType(now) {
  return now.format("HH:mm") < "12:00" ? "morning" : "afternoon";
}

function getAttendanceQrRewardRule(logTime) {
  return db.prepare(`
    SELECT id, label, start_time, end_time, points
    FROM kiosk_reward_rules
    WHERE COALESCE(is_active, 1) = 1
      AND start_time <= ?
      AND end_time >= ?
    ORDER BY start_time ASC, end_time ASC, id ASC
    LIMIT 1
  `).get(logTime, logTime) || null;
}

function getStudentAccumulatedPoints(studentId) {
  return Number(db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM point_logs WHERE student_id = ?").get(studentId).total || 0);
}

function markAttendancePresentByQr(student, attendanceDate, sessionType, actorUserId, actorLabel, timestamp) {
  const findSession = db.prepare("SELECT id FROM attendance_sessions WHERE class_id = ? AND attendance_date = ? AND session_type = ?");
  const insertSession = db.prepare("INSERT INTO attendance_sessions (class_id, attendance_date, session_type, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)");
  const updateSession = db.prepare("UPDATE attendance_sessions SET recorded_by = ?, recorded_at = ? WHERE id = ?");
  const findRecord = db.prepare("SELECT id FROM attendance_records WHERE session_id = ? AND student_id = ?");
  const insertRecord = db.prepare("INSERT INTO attendance_records (session_id, student_id, is_present, absence_reason) VALUES (?, ?, 1, NULL)");
  const updateRecord = db.prepare("UPDATE attendance_records SET is_present = 1, absence_reason = NULL WHERE id = ?");
  const insertLog = db.prepare(`
    INSERT INTO attendance_logs (class_id, attendance_date, action_type, actor_user_id, actor_label, details, created_at)
    VALUES (?, ?, 'save', ?, ?, ?, ?)
  `);

  let sessionId;
  const existingSession = findSession.get(student.class_id, attendanceDate, sessionType);
  if (existingSession && existingSession.id) {
    sessionId = Number(existingSession.id);
    updateSession.run(actorUserId, timestamp, sessionId);
  } else {
    sessionId = Number(insertSession.run(student.class_id, attendanceDate, sessionType, actorUserId, timestamp).lastInsertRowid);
  }

  const existingRecord = findRecord.get(sessionId, student.id);
  if (existingRecord && existingRecord.id) {
    updateRecord.run(existingRecord.id);
  } else {
    insertRecord.run(sessionId, student.id);
  }

  insertLog.run(
    student.class_id,
    attendanceDate,
    actorUserId,
    actorLabel,
    `${student.full_name} marked present by teacher QR scan for ${sessionType}.`,
    timestamp
  );
}

function processTeacherAttendanceQrScan(req, res) {
  try {
    const attendanceDate = normalizeAttendanceDate(req.body.attendance_date);
    const qrText = String(req.body.qr_text || '').trim();
    if (!qrText) {
      return res.status(400).json({ success: false, error: 'QR text is required' });
    }

    const parsed = parseStudentQrPayload(qrText);
    const student = db.prepare(`
      SELECT s.id, s.student_id, s.qr_token, s.full_name, s.class_id, c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE s.id = ? AND s.student_id = ? AND s.qr_token = ?
    `).get(parsed.student_pk, parsed.student_id, parsed.qr_token);

    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found for this QR code' });
    }

    const now = dayjs();
    const logTime = now.format('HH:mm');
    const scannedAt = now.toISOString();
    const sessionType = classHasAfternoonSession(student.class_name) ? getAttendanceQrSessionType(now) : 'morning';
    const actorUserId = Number(req.session.user.id);
    const actorLabel = String(req.session.user.displayName || req.session.user.username || 'Teacher QR Scanner').trim() || 'Teacher QR Scanner';

    const existingScan = db.prepare(`
      SELECT id, points_awarded, total_points_after
      FROM kiosk_scan_logs
      WHERE student_id = ? AND attendance_date = ? AND session_type = ?
    `).get(student.id, attendanceDate, sessionType);

    if (existingScan) {
      return res.json({
        success: true,
        ignored: true,
        studentId: student.id,
        studentName: student.full_name,
        classId: student.class_id,
        className: student.class_name,
        attendanceDate,
        sessionType,
        scanTime: logTime,
        pointsAwarded: Number(existingScan.points_awarded || 0),
        totalPoints: Number(existingScan.total_points_after || getStudentAccumulatedPoints(student.id)),
        ruleLabel: 'Already scanned'
      });
    }

    const rewardRule = getAttendanceQrRewardRule(logTime);
    const pointsAwarded = rewardRule ? Number(rewardRule.points || 0) : 0;

    const totalPoints = db.transaction(() => {
      markAttendancePresentByQr(student, attendanceDate, sessionType, actorUserId, actorLabel, scannedAt);
      if (pointsAwarded !== 0) {
        db.prepare(`
          INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          student.id,
          student.class_id,
          pointsAwarded,
          `Kiosk attendance: ${rewardRule ? rewardRule.label : sessionType}`,
          actorUserId,
          scannedAt
        );
        updateDailySnapshot(student.id);
      }
      const totalPointsAfter = getStudentAccumulatedPoints(student.id);
      db.prepare(`
        INSERT INTO kiosk_scan_logs
          (student_id, class_id, attendance_date, session_type, scanned_at, log_time, rule_label, points_awarded, total_points_after, qr_payload, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')
      `).run(
        student.id,
        student.class_id,
        attendanceDate,
        sessionType,
        scannedAt,
        logTime,
        rewardRule ? rewardRule.label : null,
        pointsAwarded,
        totalPointsAfter,
        qrText
      );
      return totalPointsAfter;
    })();

    return res.json({
      success: true,
      ignored: false,
      studentId: student.id,
      studentName: student.full_name,
      classId: student.class_id,
      className: student.class_name,
      attendanceDate,
      sessionType,
      scanTime: logTime,
      pointsAwarded,
      totalPoints,
      ruleLabel: rewardRule ? rewardRule.label : 'No matching reward rule'
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Unable to process attendance QR scan' });
  }
}

router.get('/attendance', (req, res) => {
  const attendanceDate = normalizeAttendanceDate(req.query.date);
  const classes = db.prepare('SELECT id, name FROM classes ORDER BY name').all();
  const wholeSchoolSummary = getAttendanceSummaryForScope(null, attendanceDate);
  const classSummaries = classes.map((cls) => ({
    ...cls,
    summary: getAttendanceSummaryForScope(Number(cls.id), attendanceDate)
  }));

  res.render('teacher-classes', {
    classes,
    mode: 'attendance',
    attendanceDate,
    wholeSchoolSummary,
    classSummaries,
    ...getAttendanceAbsenteeVisibility(attendanceDate)
  });
});

router.get('/attendance/scan', (req, res) => {
  const attendanceDate = normalizeAttendanceDate(req.query.date);
  const classes = db.prepare('SELECT id, name FROM classes ORDER BY name').all();
  res.render('teacher-attendance-scan', {
    cls: { id: 'scan-all', name: 'All Classes' },
    classes,
    attendanceDate,
    error: req.query.error || '',
    success: req.query.success || ''
  });
});

router.get('/attendance/:classId/scan', (req, res) => {
  const attendanceDate = normalizeAttendanceDate(req.query.date);
  return res.redirect(`/teacher/attendance/scan?date=${encodeURIComponent(attendanceDate)}`);
});

router.get('/attendance/:classId', (req, res) => {
  const classId = Number(req.params.classId);
  const attendanceDate = normalizeAttendanceDate(req.query.date);
  const pageData = getAttendancePageData(classId, attendanceDate);
  if (!pageData) return res.status(404).send('Class not found');
  res.render('teacher-attendance', {
    ...pageData,
    success: req.query.success || '',
    error: req.query.error || ''
  });
});

router.post('/attendance/scan/process', (req, res) => {
  return processTeacherAttendanceQrScan(req, res);
});

router.post('/attendance/:classId/scan/process', (req, res) => {
  return processTeacherAttendanceQrScan(req, res);
});

router.post('/attendance/:classId/save', (req, res) => {
  const classId = Number(req.params.classId);
  const attendanceDate = normalizeAttendanceDate(req.body.attendance_date);
  const cls = db.prepare('SELECT id, name FROM classes WHERE id = ?').get(classId);
  if (!cls) {
    if (req.xhr || String(req.headers.accept || '').includes('application/json')) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }
    return res.status(404).send('Class not found');
  }
  const hasAfternoonSession = classHasAfternoonSession(cls.name);
  const sessionTypes = hasAfternoonSession ? ['morning', 'afternoon'] : ['morning'];

  const students = db.prepare('SELECT id, full_name FROM students WHERE class_id = ? ORDER BY full_name ASC').all(classId);
  const morningPresentIds = new Set(parseNumberArray(req.body.morning_present_ids));
  const afternoonPresentIds = new Set(parseNumberArray(req.body.afternoon_present_ids));
  const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const userId = Number(req.session.user.id);
  const actorLabel = String(req.session.user.displayName || req.session.user.username || 'System').trim() || 'System';

  const existingRows = db.prepare(`
    SELECT ar.student_id, ar.is_present, COALESCE(ar.absence_reason, '') AS absence_reason, asn.session_type
    FROM attendance_records ar
    JOIN attendance_sessions asn ON asn.id = ar.session_id
    WHERE asn.class_id = ? AND asn.attendance_date = ?
  `).all(classId, attendanceDate);

  const currentStateMap = buildAttendanceStateMap(students, existingRows);
  const nextStateMap = new Map();
  students.forEach((student) => {
    const studentId = Number(student.id);
    const morningPresent = morningPresentIds.has(studentId);
    const morningReason = morningPresent ? '' : String(req.body[`morning_reason_${studentId}`] || '').trim();
    const afternoonPresent = afternoonPresentIds.has(studentId);
    const afternoonReason = afternoonPresent ? '' : String(req.body[`afternoon_reason_${studentId}`] || '').trim();
    nextStateMap.set(studentId, {
      morning: {
        is_present: morningPresent,
        absence_reason: morningReason
      },
      afternoon: {
        is_present: hasAfternoonSession ? afternoonPresent : false,
        absence_reason: hasAfternoonSession ? afternoonReason : ''
      }
    });
  });

  const changes = describeAttendanceChanges(students, currentStateMap, nextStateMap, sessionTypes);
  if (!hasAfternoonSession && existingRows.some((row) => row.session_type === 'afternoon')) {
    changes.push('Removed afternoon session for AM-only class');
  }
  const insertLog = db.prepare('INSERT INTO attendance_logs (class_id, attendance_date, action_type, actor_user_id, actor_label, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const expectedRecordCount = students.length * sessionTypes.length;
  const hasCompleteAttendanceRecord = existingRows.filter((row) => sessionTypes.includes(row.session_type)).length >= expectedRecordCount;

  if (!changes.length && hasCompleteAttendanceRecord) {
    insertLog.run(classId, attendanceDate, 'no_change', null, 'By system', 'No attendance changes detected.', now);
    if (req.xhr || String(req.headers.accept || '').includes('application/json')) {
      return res.json({ success: true, message: 'No attendance changes. Logged by system.', attendanceDate, classId, audit: { actor_label: 'By system', created_at: now }, logs: [{ action_type: 'no_change', actor_label: 'By system', details: 'No attendance changes detected.', created_at: now }] });
    }
    return res.redirect(`/teacher/attendance/${classId}?date=${attendanceDate}&success=${encodeURIComponent('No attendance changes. Logged by system.')}`);
  }

  if (!changes.length) {
    changes.push(`Initialized ${students.length} students as present for ${sessionTypes.join(' and ')}`);
  }

  const findSession = db.prepare('SELECT id FROM attendance_sessions WHERE class_id = ? AND attendance_date = ? AND session_type = ?');
  const insertSession = db.prepare('INSERT INTO attendance_sessions (class_id, attendance_date, session_type, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)');
  const updateSession = db.prepare('UPDATE attendance_sessions SET recorded_by = ?, recorded_at = ? WHERE id = ?');
  const deleteRecords = db.prepare('DELETE FROM attendance_records WHERE session_id = ?');
  const deleteSession = db.prepare('DELETE FROM attendance_sessions WHERE id = ?');
  const insertRecord = db.prepare('INSERT INTO attendance_records (session_id, student_id, is_present, absence_reason) VALUES (?, ?, ?, ?)');

  const tx = db.transaction(() => {
    if (!hasAfternoonSession) {
      const oldAfternoon = findSession.get(classId, attendanceDate, 'afternoon');
      if (oldAfternoon && oldAfternoon.id) {
        deleteRecords.run(Number(oldAfternoon.id));
        deleteSession.run(Number(oldAfternoon.id));
      }
    }
    sessionTypes.forEach((sessionType) => {
      const existing = findSession.get(classId, attendanceDate, sessionType);
      let sessionId;
      if (existing && existing.id) {
        sessionId = Number(existing.id);
        updateSession.run(userId, now, sessionId);
      } else {
        const info = insertSession.run(classId, attendanceDate, sessionType, userId, now);
        sessionId = Number(info.lastInsertRowid);
      }

      deleteRecords.run(sessionId);
      students.forEach((student) => {
        const studentId = Number(student.id);
        const presentSet = sessionType === 'morning' ? morningPresentIds : afternoonPresentIds;
        const isPresent = presentSet.has(studentId) ? 1 : 0;
        const reasonKey = `${sessionType}_reason_${studentId}`;
        const absenceReason = isPresent ? '' : String(req.body[reasonKey] || '').trim();
        insertRecord.run(sessionId, studentId, isPresent, absenceReason || null);
      });
    });
    insertLog.run(classId, attendanceDate, 'save', userId, actorLabel, changes.slice(0, 12).join(' | '), now);
  });

  tx();
  if (req.xhr || String(req.headers.accept || '').includes('application/json')) {
    return res.json({ success: true, message: 'Attendance saved', attendanceDate, classId, audit: { actor_label: actorLabel, created_at: now }, logs: [{ action_type: 'save', actor_label: actorLabel, details: changes.slice(0, 12).join(' | '), created_at: now }] });
  }
  return res.redirect(`/teacher/attendance/${classId}?date=${attendanceDate}&success=${encodeURIComponent('Attendance saved')}`);
});
router.post('/attendance/:classId/reset', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    if (req.xhr || String(req.headers.accept || '').includes('application/json')) {
      return res.status(403).json({ success: false, error: 'Only admin can reset attendance' });
    }
    return res.status(403).send('Only admin can reset attendance');
  }

  const classId = Number(req.params.classId);
  const attendanceDate = normalizeAttendanceDate(req.body.attendance_date || req.query.date);
  const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
  if (!cls) {
    if (req.xhr || String(req.headers.accept || '').includes('application/json')) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }
    return res.status(404).send('Class not found');
  }

  const sessionIds = db.prepare('SELECT id FROM attendance_sessions WHERE class_id = ? AND attendance_date = ?').all(classId, attendanceDate).map((row) => Number(row.id));
  const deleteRecords = db.prepare('DELETE FROM attendance_records WHERE session_id = ?');
  const deleteSession = db.prepare('DELETE FROM attendance_sessions WHERE id = ?');
  const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const actorLabel = String(req.session.user.displayName || req.session.user.username || 'System').trim() || 'System';
  const insertLog = db.prepare('INSERT INTO attendance_logs (class_id, attendance_date, action_type, actor_user_id, actor_label, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction(() => {
    sessionIds.forEach((sessionId) => {
      deleteRecords.run(sessionId);
      deleteSession.run(sessionId);
    });
    insertLog.run(classId, attendanceDate, 'reset', Number(req.session.user.id), actorLabel, 'Attendance records reset.', now);
  });
  tx();

  if (req.xhr || String(req.headers.accept || '').includes('application/json')) {
    return res.json({ success: true, message: 'Attendance record reset', attendanceDate, classId, audit: { actor_label: actorLabel, created_at: now }, logs: [{ action_type: 'reset', actor_label: actorLabel, details: 'Attendance records reset.', created_at: now }] });
  }
  return res.redirect(`/teacher/attendance/${classId}?date=${attendanceDate}&success=${encodeURIComponent('Attendance record reset')}`);
});

router.get('/attendance/:classId/export', (req, res) => {
  const classId = Number(req.params.classId);
  const attendanceDate = normalizeAttendanceDate(req.query.date);
  const pageData = getAttendancePageData(classId, attendanceDate);
  if (!pageData) return res.status(404).send('Class not found');

  const header = 'full_name,nickname,morning_status,morning_reason,afternoon_status,afternoon_reason,day_tally,day_percentage';
  const csvRows = pageData.attendanceRows.map((row) => {
    const values = [
      row.full_name,
      row.nickname,
      row.morning.is_present ? 'Present' : 'Absent',
      row.morning.absence_reason || '',
      row.has_afternoon_session ? (row.afternoon.is_present ? 'Present' : 'Absent') : 'No afternoon session',
      row.has_afternoon_session ? (row.afternoon.absence_reason || '') : '',
      row.day_tally,
      `${row.day_percentage}%`
    ].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`);
    return values.join(',');
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=attendance-${classId}-${attendanceDate}.csv`);
  res.send([header, ...csvRows].join('\n'));
});

function renderReportingTool(req, res) {
  const users = getReportingToolUsers();
  const allowedIds = new Set(users.map((user) => Number(user.id)));
  let selectedUserIds = parseSelectedUserIds(req.query.userIds, allowedIds);
  if (!selectedUserIds.length && String(req.query.generate || "") !== "1") {
    selectedUserIds = users.map((user) => Number(user.id));
  }
  const dateBounds = getTeacherUsageDateBounds();
  const monthFilter = normalizeMonthFilter(req.query.month);
  const dateFrom = String(monthFilter ? dayjs(`${monthFilter}-01`).startOf("month").format("YYYY-MM-DD") : (req.query.from || dateBounds.first_date)).trim();
  const dateTo = String(monthFilter ? dayjs(`${monthFilter}-01`).endOf("month").format("YYYY-MM-DD") : (req.query.to || dateBounds.last_date)).trim();
  const weekLimit = normalizeWeekLimit(req.query.weeks);
  const statusFilter = normalizeUsageStatusFilter(req.query.status);
  const minUsageDays = normalizeUsageDayFilter(req.query.usageDays);
  const shouldGenerate = String(req.query.generate || "") === "1" || !Object.prototype.hasOwnProperty.call(req.query, "generate");
  const report = shouldGenerate ? buildReportingToolReport(selectedUserIds, dateFrom, dateTo, {
    weekLimit,
    statusFilter,
    minUsageDays
  }) : null;

  res.render("teacher-pitis-usage-report", {
    users,
    selectedUserIds,
    dateFrom,
    dateTo,
    dateBounds,
    monthFilter,
    weekLimit,
    statusFilter,
    minUsageDays,
    auditStatus: getLatestTeacherUsageAudit(),
    report,
    visual: buildReportingToolVisuals(report),
    reportBasePath: "/teacher/reporting-tool/teacher-usage-report",
    reportExportPath: "/teacher/reporting-tool/teacher-usage-report/export",
    error: shouldGenerate && !report ? "Select at least one user and a valid date range." : ""
  });
}

function renderReportingToolMenu(_req, res) {
  const integrity = buildPitisIntegrityReport();
  const weekly = buildWeeklyPitisActionReport();
  const coverage = buildStudentRecognitionCoverageReport();
  const leadership = buildLeadershipTermSummary();
  const adoption = buildPwaAdoptionReport();
  res.render("reporting-tool-menu", {
    auditStatus: getLatestTeacherUsageAudit(),
    overview: {
      availableReports: 10,
      criticalIntegrityIssues: integrity.summary.criticalIssues,
      teachersNeedingAction: weekly.summary.teachersNeedingAction,
      recognitionCoverage: coverage.summary.coverage,
      schoolConsistency: leadership.summary.schoolConsistency,
      pushEnabledUsers: adoption.summary.pushEnabled,
      generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss")
    }
  });
}

function renderPitisIntegrityReport(req, res) {
  res.render("pitis-integrity-report", {
    report: buildPitisIntegrityReport(),
    user: req.session.user
  });
}

function exportPitisIntegrityReport(_req, res) {
  const report = buildPitisIntegrityReport();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=pitis-data-integrity-${dayjs().format("YYYY-MM-DD")}.csv`);
  res.send(pitisIntegrityReportToCsv(report));
}

function renderWeeklyPitisActionReport(req, res) {
  res.render("weekly-pitis-action-report", {
    report: buildWeeklyPitisActionReport(req.query),
    user: req.session.user
  });
}

function exportWeeklyPitisActionReport(req, res) {
  const report = buildWeeklyPitisActionReport(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=weekly-pitis-action-${report.asOf}.csv`);
  res.send(weeklyPitisActionReportToCsv(report));
}

function renderStudentRecognitionCoverage(req, res) {
  res.render("student-recognition-coverage", {
    report: buildStudentRecognitionCoverageReport(req.query),
    user: req.session.user
  });
}

function exportStudentRecognitionCoverage(req, res) {
  const report = buildStudentRecognitionCoverageReport(req.query);
  if (report.error) return res.status(400).send(report.error);
  const classLabel = report.classId === "all" ? "all-classes" : `class-${report.classId}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=student-recognition-coverage-${classLabel}-${report.from}-to-${report.to}.csv`);
  res.send(studentRecognitionCoverageToCsv(report));
}

function renderStudentStatement(req, res) {
  res.render("individual-student-statement", { report: buildStudentStatement(req.query), user: req.session.user });
}

function exportStudentStatement(req, res) {
  const report = buildStudentStatement(req.query);
  if (report.error || !report.hasStudent) return res.status(400).send(report.error || "Choose a student.");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=pitis-statement-${report.studentId}-${report.from}-to-${report.to}.csv`);
  res.send(studentStatementToCsv(report));
}

function renderClassWeeklyDigest(req, res) {
  res.render("class-weekly-digest", { report: buildClassWeeklyDigest(req.query), user: req.session.user });
}

function exportClassWeeklyDigest(req, res) {
  const report = buildClassWeeklyDigest(req.query);
  if (report.error || !report.hasClass) return res.status(400).send(report.error || "Choose a class.");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=class-digest-${report.classId}-${report.from}-to-${report.to}.csv`);
  res.send(classWeeklyDigestToCsv(report));
}

function renderLeadershipTermSummary(req, res) {
  res.render("leadership-term-summary", { report: buildLeadershipTermSummary(req.query), user: req.session.user });
}

function exportLeadershipTermSummary(req, res) {
  const report = buildLeadershipTermSummary(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=leadership-term-${report.term.term}-${report.asOf}.csv`);
  res.send(leadershipTermSummaryToCsv(report));
}

function renderPwaAdoptionReport(req, res) {
  res.render("pwa-adoption-report", { report: buildPwaAdoptionReport(), user: req.session.user });
}

function exportPwaAdoptionReport(_req, res) {
  const report = buildPwaAdoptionReport();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=pwa-notification-adoption.csv");
  res.send(pwaAdoptionReportToCsv(report));
}

function exportReportingTool(req, res) {
  const users = getReportingToolUsers();
  const allowedIds = new Set(users.map((user) => Number(user.id)));
  const selectedUserIds = parseSelectedUserIds(req.query.userIds, allowedIds);
  const dateFrom = String(req.query.from || "").trim();
  const dateTo = String(req.query.to || "").trim();
  const report = buildReportingToolReport(selectedUserIds, dateFrom, dateTo, {
    weekLimit: normalizeWeekLimit(req.query.weeks),
    statusFilter: normalizeUsageStatusFilter(req.query.status),
    minUsageDays: normalizeUsageDayFilter(req.query.usageDays)
  });
  if (!report) return res.status(400).send("Missing or invalid report filters");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=reporting-tool-pitis-usage-${report.dateFrom}-to-${report.dateTo}.csv`);
  res.send(reportingToolReportToCsv(report));
}

function renderSipPitisDashboard(req, res) {
  const dashboard = buildSipPitisDashboard(req.query);
  res.render("sip-pitis-dashboard", {
    dashboard,
    user: req.session.user,
    printMode: false
  });
}

function renderSipPitisDashboardPrint(req, res) {
  const dashboard = buildSipPitisDashboard(req.query);
  res.render("sip-pitis-dashboard", {
    dashboard,
    user: req.session.user,
    printMode: true
  });
}

function exportSipPitisDashboard(req, res) {
  const dashboard = buildSipPitisDashboard(req.query);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=sip-pitis-dashboard-term-${dashboard.sipTarget.term}.csv`);
  res.send(sipDashboardToCsv(dashboard));
}

function renderSipPitisTeacherJourney(req, res) {
  const result = buildSipPitisTeacherJourney(req.params.userId, req.query);
  if (!result) return res.status(404).send("Teacher not found in SIP PITIS settings");
  res.render("sip-pitis-journey", {
    dashboard: result.dashboard,
    teacher: result.teacher,
    user: req.session.user
  });
}

function renderSipPitisRawAudit(req, res) {
  const audit = buildSipPitisRawAudit(req.query);
  res.render("sip-pitis-raw-audit", {
    audit,
    user: req.session.user
  });
}

function exportSipPitisRawAudit(req, res) {
  const audit = buildSipPitisRawAudit(req.query);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=sip-pitis-raw-audit-${audit.filters.from}-to-${audit.filters.to}.csv`);
  res.send(sipRawAuditToCsv(audit));
}

function renderSipPitisSettings(req, res) {
  if (!req.session.user || req.session.user.role !== "admin") return res.status(403).send("Admin access required");
  res.render("sip-pitis-settings", {
    settings: getSipPitisSettings(),
    candidates: getAllPortalTeacherCandidates(),
    saved: String(req.query.saved || "") === "1",
    user: req.session.user
  });
}

function saveSipPitisSettingsRoute(req, res) {
  if (!req.session.user || req.session.user.role !== "admin") return res.status(403).send("Admin access required");
  saveSipPitisSettings(req.body, Number(req.session.user.id || 0) || null);
  res.redirect("/teacher/reporting-tool/sip-pitis/settings?saved=1");
}

router.get("/reporting-tool", renderReportingToolMenu);
router.get("/reporting-tool/data-integrity", renderPitisIntegrityReport);
router.get("/reporting-tool/data-integrity/export.csv", exportPitisIntegrityReport);
router.get("/reporting-tool/weekly-action", renderWeeklyPitisActionReport);
router.get("/reporting-tool/weekly-action/export.csv", exportWeeklyPitisActionReport);
router.get("/reporting-tool/recognition-coverage", renderStudentRecognitionCoverage);
router.get("/reporting-tool/recognition-coverage/export.csv", exportStudentRecognitionCoverage);
router.get("/reporting-tool/student-statement", renderStudentStatement);
router.get("/reporting-tool/student-statement/export.csv", exportStudentStatement);
router.get("/reporting-tool/class-digest", renderClassWeeklyDigest);
router.get("/reporting-tool/class-digest/export.csv", exportClassWeeklyDigest);
router.get("/reporting-tool/leadership-summary", renderLeadershipTermSummary);
router.get("/reporting-tool/leadership-summary/export.csv", exportLeadershipTermSummary);
router.get("/reporting-tool/pwa-adoption", renderPwaAdoptionReport);
router.get("/reporting-tool/pwa-adoption/export.csv", exportPwaAdoptionReport);
router.get("/reporting-tool/sip-pitis", renderSipPitisDashboard);
router.get("/reporting-tool/sip-pitis/export.csv", exportSipPitisDashboard);
router.get("/reporting-tool/sip-pitis/print", renderSipPitisDashboardPrint);
router.get("/reporting-tool/sip-pitis/raw-audit", renderSipPitisRawAudit);
router.get("/reporting-tool/sip-pitis/raw-audit/export.csv", exportSipPitisRawAudit);
router.get("/reporting-tool/sip-pitis/settings", renderSipPitisSettings);
router.post("/reporting-tool/sip-pitis/settings", saveSipPitisSettingsRoute);
router.get("/reporting-tool/sip-pitis/teacher/:userId", renderSipPitisTeacherJourney);
router.get("/reporting-tool/export", exportSipPitisDashboard);
router.get("/reporting-tool/teacher-usage-report", renderSipPitisDashboard);
router.get("/reporting-tool/teacher-usage-report/export", exportSipPitisDashboard);
router.get("/pitis-usage-report", renderSipPitisDashboard);
router.get("/pitis-usage-report/export", exportSipPitisDashboard);

function parseStudentTotalsFilters(query) {
  const classIdRaw = String(query.classId || "").trim();
  const classId = classIdRaw === "all" ? "all" : Number(classIdRaw || 0);
  const dateFrom = String(query.from || "").trim();
  const dateTo = String(query.to || "").trim();
  const allTime = String(query.allTime || "") === "1";
  const hasFilters = Boolean(classId) && (allTime || Boolean(dateFrom || dateTo));
  let error = "";

  if (hasFilters && !allTime) {
    const from = parseIsoDate(dateFrom);
    const to = parseIsoDate(dateTo);
    if (!from || !to) error = "Choose a valid From and To date.";
    else if (from.isAfter(to, "day")) error = "The From date must be on or before the To date.";
  }

  return { classId, dateFrom, dateTo, allTime, hasFilters, error };
}

router.get("/report/student-totals", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const filters = parseStudentTotalsFilters(req.query);
  const rows = filters.hasFilters && !filters.error
    ? fetchStudentPitisTotalRows(filters.classId, filters.dateFrom, filters.dateTo, filters.allTime)
    : [];

  res.render("student-pitis-totals", { classes, rows, ...filters });
});

router.get("/report/student-totals/export", (req, res) => {
  const filters = parseStudentTotalsFilters(req.query);
  if (!filters.hasFilters || filters.error) return res.status(400).send(filters.error || "Missing filters");

  const rows = fetchStudentPitisTotalRows(filters.classId, filters.dateFrom, filters.dateTo, filters.allTime);
  const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = "student,full_name,class,pitis_collected,deductions,net_pitis,transactions";
  const csvRows = rows.map((row) => [
    row.name,
    row.full_name,
    row.class_name,
    row.pitis_collected,
    row.pitis_deducted,
    row.net_pitis,
    row.transactions
  ].map(csvEscape).join(","));
  const reportLabel = filters.allTime ? "all-time" : `${filters.dateFrom}-to-${filters.dateTo}`;
  const classLabel = filters.classId === "all" ? "all-classes" : filters.classId;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=student-pitis-totals-${classLabel}-${reportLabel}.csv`);
  res.send([header, ...csvRows].join("\n"));
});

router.get("/report", (req, res) => {
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const classIdRaw = String(req.query.classId || "").trim();
  const classId = classIdRaw === "all" ? "all" : Number(classIdRaw || 0);
  const dateFrom = req.query.from || "";
  const dateTo = req.query.to || "";
  const allTime = String(req.query.allTime || "") === "1";
  const rows = fetchRewardReportRows(classId, dateFrom, dateTo, allTime);

  res.render("teacher-report", { classes, rows, classId, dateFrom, dateTo, allTime });
});

router.get("/report/export", (req, res) => {
  const classIdRaw = String(req.query.classId || "").trim();
  const classId = classIdRaw === "all" ? "all" : Number(classIdRaw || 0);
  const dateFrom = req.query.from || "";
  const dateTo = req.query.to || "";
  const allTime = String(req.query.allTime || "") === "1";
  if (!classId || (!allTime && (!dateFrom || !dateTo))) return res.status(400).send("Missing filters");

  const rows = fetchRewardReportRows(classId, dateFrom, dateTo, allTime);

  const header = "date_awarded,time_awarded,name,full_name,class,source_reason,points_awarded,awarded_by";
  const csvRows = rows.map((r) => {
    const vals = [
      r.date_awarded,
      r.time_awarded,
      r.name,
      r.full_name,
      r.class_name,
      r.source_reason,
      r.points_awarded,
      r.awarded_by
    ].map((v) => {
      const s = String(v ?? "").replace(/"/g, "\"\"");
      return `"${s}"`;
    });
    return vals.join(",");
  });

  res.setHeader("Content-Type", "text/csv");
  const reportLabel = allTime ? "all-time" : `${dateFrom}-to-${dateTo}`;
  const classLabel = classId === "all" ? "all-classes" : classId;
  res.setHeader("Content-Disposition", `attachment; filename=teacher-report-${classLabel}-${reportLabel}.csv`);
  res.send([header, ...csvRows].join("\n"));
});

router.use((err, req, res, next) => {
  if (!err) return next();

  const studentPk = encodeURIComponent(String((req.params || {}).studentId || ""));
  if (err instanceof multer.MulterError) {
    return res.redirect(`/teacher/students/${studentPk}?error=${encodeURIComponent("Upload failed: " + err.message)}`);
  }
  if (String(err.message || "").includes("Only image files are allowed")) {
    return res.redirect(`/teacher/students/${studentPk}?error=${encodeURIComponent("Upload failed: only image files are allowed")}`);
  }
  return next(err);
});

module.exports = router;








































