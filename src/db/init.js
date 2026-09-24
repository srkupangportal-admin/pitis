const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const dayjs = require("dayjs");
const { db } = require("./database");
const {
  STUDENT_DB_COLUMNS,
  createStudentQrToken,
  getStudentTableSql,
  normalizeClassName,
  normalizeDateValue,
  normalizeGender,
  normalizeOptionalText
} = require("../services/studentSchema");

function getColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','teacher','staff')),
      user_type TEXT NOT NULL DEFAULT 'teacher',
       password_hash TEXT NOT NULL,
       is_active INTEGER NOT NULL DEFAULT 1,
       must_change_password INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    ${getStudentTableSql("students")};

    CREATE TABLE IF NOT EXISTS student_siblings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_pk INTEGER NOT NULL,
      sibling_student_pk INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(student_pk, sibling_student_pk),
      FOREIGN KEY (student_pk) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (sibling_student_pk) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS point_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT UNIQUE NOT NULL,
      reason_type TEXT NOT NULL DEFAULT 'positive' CHECK (reason_type IN ('positive','negative')),
      created_by INTEGER,
      is_custom INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS point_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      awarded_by INTEGER NOT NULL,
      awarded_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (class_id) REFERENCES classes(id),
      FOREIGN KEY (awarded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS daily_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      student_id INTEGER NOT NULL,
      total_points INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      UNIQUE(snapshot_date, student_id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS rewards_gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      points_required INTEGER NOT NULL,
      image_path TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      details TEXT,
      event_date TEXT NOT NULL,
      end_date TEXT,
      event_source TEXT NOT NULL DEFAULT 'manual',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by INTEGER,
      deleted_at TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (deleted_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS calendar_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT NOT NULL,
      description TEXT,
      created_by INTEGER,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS calendar_event_labels (
      event_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, label_id),
      FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
      FOREIGN KEY (label_id) REFERENCES calendar_labels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS calendar_event_users (
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, user_id),
      FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}
function migrateUsersTable() {
  const cols = getColumns("users");
  const needsCredentialHardening = !cols.includes("must_change_password");

  if (!cols.includes("is_active")) {
    db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("user_type")) {
    db.exec("ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'teacher'");
  }
  if (!cols.includes("email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  }
  if (needsCredentialHardening) {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE users SET must_change_password = 1 WHERE role IN ('teacher', 'staff') AND is_active = 1");
  }

  db.exec("UPDATE users SET is_active = 1 WHERE is_active IS NULL");
  db.exec("UPDATE users SET user_type = CASE WHEN role = 'admin' THEN 'admin' WHEN role = 'staff' THEN 'staff' ELSE 'teacher' END WHERE user_type IS NULL OR TRIM(user_type) = ''");
  db.exec("UPDATE users SET must_change_password = 0 WHERE role = 'admin'");
  db.exec("UPDATE users SET email = NULL WHERE email IS NOT NULL AND TRIM(email) = ''");

  const duplicates = db
    .prepare(
      `SELECT LOWER(TRIM(email)) AS email_norm
       FROM users
       WHERE email IS NOT NULL AND TRIM(email) <> ''
       GROUP BY LOWER(TRIM(email))
       HAVING COUNT(*) > 1`
    )
    .all();

  for (const d of duplicates) {
    const rows = db
      .prepare(
        `SELECT id
         FROM users
         WHERE LOWER(TRIM(email)) = ?
         ORDER BY id ASC`
      )
      .all(d.email_norm);

    rows.slice(1).forEach((r) => {
      db.prepare("UPDATE users SET email = NULL WHERE id = ?").run(r.id);
    });
  }

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL AND TRIM(email) <> ''");
}

function migrateUserLoginLogsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      user_type TEXT,
      logged_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_login_logs_logged_at ON user_login_logs(logged_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_user_login_logs_role ON user_login_logs(role, user_type);
  `);
}

function migrateStudentEditLogsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS student_edit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_pk INTEGER,
      student_id TEXT,
      student_full_name TEXT,
      field_key TEXT NOT NULL,
      field_label TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      edited_by INTEGER,
      edited_by_label TEXT NOT NULL,
      edited_at TEXT NOT NULL,
      FOREIGN KEY (student_pk) REFERENCES students(id),
      FOREIGN KEY (edited_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_student_edit_logs_student ON student_edit_logs(student_pk, edited_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_student_edit_logs_edited_at ON student_edit_logs(edited_at DESC, id DESC);
  `);
}

function migratePhotoLibraryTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photo_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES photo_folders(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_photo_folders_parent ON photo_folders(parent_id, id);

    CREATE TABLE IF NOT EXISTS photo_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT,
      captured_at_source TEXT,
      uploaded_by INTEGER,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY (folder_id) REFERENCES photo_folders(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_photo_files_folder_uploaded_at ON photo_files(folder_id, uploaded_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS photo_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      display_name TEXT,
      activity_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_label TEXT,
      folder_id INTEGER,
      file_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (folder_id) REFERENCES photo_folders(id) ON DELETE SET NULL,
      FOREIGN KEY (file_id) REFERENCES photo_files(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_photo_activity_logs_created_at ON photo_activity_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_photo_activity_logs_activity ON photo_activity_logs(activity_type, target_type);
  `);

  const photoFileCols = getColumns("photo_files");
  if (!photoFileCols.includes("captured_at")) {
    db.exec("ALTER TABLE photo_files ADD COLUMN captured_at TEXT");
  }
  if (!photoFileCols.includes("captured_at_source")) {
    db.exec("ALTER TABLE photo_files ADD COLUMN captured_at_source TEXT");
  }
}
const MONTH_MAP = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  MAC: "03",
  APR: "04",
  MAY: "05",
  MEI: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  OGS: "08",
  OGOS: "08",
  SEP: "09",
  OCT: "10",
  OKT: "10",
  NOV: "11",
  DEC: "12",
  DIS: "12"
};

function normalizeGenderValue(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "MALE") return "Male";
  if (normalized === "FEMALE") return "Female";
  return String(value || "").trim() || null;
}

function buildDobFromParts(dayValue, monthValue, yearValue) {
  const day = String(dayValue || "").trim();
  const monthRaw = String(monthValue || "").trim().toUpperCase();
  const year = String(yearValue || "").trim();
  if (!day || !monthRaw || !year) return null;

  const month = MONTH_MAP[monthRaw] || (monthRaw.match(/^\d{1,2}$/) ? monthRaw.padStart(2, "0") : null);
  if (!month) return null;

  const paddedDay = day.padStart(2, "0");
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(paddedDay)) return null;
  return `${year}-${month}-${paddedDay}`;
}

function toTitleCase(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}
function mapLegacyStudentRow(row) {
  const createdAt = String(row.created_at || "").trim() || dayjs().toISOString();
  const name = normalizeOptionalText(row.name)
    || normalizeOptionalText(row.nickname)
    || normalizeOptionalText(row.full_name)
    || normalizeOptionalText(row.nama_penuh)
    || "Student";
  const fullName = normalizeOptionalText(row.full_name)
    || normalizeOptionalText(row.nama_penuh)
    || normalizeOptionalText(row.name)
    || normalizeOptionalText(row.nickname)
    || name;
  const studentId = normalizeOptionalText(row.student_id)
    || normalizeOptionalText(row.student_code)
    || (row.id ? `STU${String(row.id).padStart(4, "0")}` : `STU-${Date.now()}`);

  return {
    id: Number(row.id) || null,
    name,
    full_name: fullName,
    student_id: studentId,
    qr_token: normalizeOptionalText(row.qr_token),
    no_sb: normalizeOptionalText(row.no_sb),
    no_bruhims: normalizeOptionalText(row.no_bruhims) || normalizeOptionalText(row.bruhims),
    bangsa: normalizeOptionalText(row.bangsa),
    ugama: normalizeOptionalText(row.ugama) || normalizeOptionalText(row.agama),
    kerakyatan: normalizeOptionalText(row.kerakyatan),
    gender: normalizeGender(row.gender || row.jantina),
    dob: normalizeDateValue(row.dob) || buildDobFromParts(row.dob_day, row.dob_month, row.dob_year),
    age: normalizeOptionalText(row.age),
    level: normalizeOptionalText(row.level) || normalizeOptionalText(row.tahun),
    notes: normalizeOptionalText(row.notes),
    emergency_contact: normalizeOptionalText(row.emergency_contact) || "-",
    email: normalizeOptionalText(row.email),
    alamat: normalizeOptionalText(row.alamat) || normalizeOptionalText(row.address) || normalizeOptionalText(row.alamat_rumah),
    nama_ayah: normalizeOptionalText(row.nama_ayah) || normalizeOptionalText(row.nama_bapa),
    pekerjaan_ayah: normalizeOptionalText(row.pekerjaan_ayah),
    dob_ayah: normalizeDateValue(row.dob_ayah),
    taraf_ayah: normalizeOptionalText(row.taraf_ayah) || normalizeOptionalText(row.taraf_kelamin),
    no_telefon_ayah: normalizeOptionalText(row.no_telefon_ayah) || normalizeOptionalText(row.no_tel_ayah),
    bangsa_ayah: normalizeOptionalText(row.bangsa_ayah),
    ugama_ayah: normalizeOptionalText(row.ugama_ayah),
    kerakyatan_ayah: normalizeOptionalText(row.kerakyatan_ayah),
    nama_ibu: normalizeOptionalText(row.nama_ibu),
    pekerjaan_ibu: normalizeOptionalText(row.pekerjaan_ibu),
    dob_ibu: normalizeDateValue(row.dob_ibu),
    taraf_ibu: normalizeOptionalText(row.taraf_ibu) || normalizeOptionalText(row.taraf_kelamin_ibu),
    no_telefon_ibu: normalizeOptionalText(row.no_telefon_ibu) || normalizeOptionalText(row.no_tel_ibu),
    bangsa_ibu: normalizeOptionalText(row.bangsa_ibu),
    ugama_ibu: normalizeOptionalText(row.ugama_ibu),
    kerakyatan_ibu: normalizeOptionalText(row.kerakyatan_ibu),
    family_id: normalizeOptionalText(row.family_id) || normalizeOptionalText(row.familyid),
    yiuran_sekolah_paid: Number(row.yiuran_sekolah_paid) === 1 ? 1 : 0,
    yuran_pibg_paid: Number(row.yuran_pibg_paid) === 1 ? 1 : 0,
    insuran_paid: Number(row.insuran_paid) === 1 ? 1 : 0,
    avatar_path: normalizeOptionalText(row.avatar_path),
    class_id: Number(row.class_id) || 1,
    created_at: createdAt
  };
}

function generateUniqueStudentQrToken(findByToken) {
  let token = createStudentQrToken();
  while (findByToken.get(token)) {
    token = createStudentQrToken();
  }
  return token;
}

function ensureStudentQrTokens() {
  const cols = getColumns("students");
  if (!cols.includes("qr_token")) {
    db.exec("ALTER TABLE students ADD COLUMN qr_token TEXT");
  }

  const rows = db.prepare("SELECT id, qr_token FROM students ORDER BY id ASC").all();
  const seen = new Set();
  const duplicateOrBlankIds = [];

  rows.forEach((row) => {
    const token = String(row.qr_token || "").trim();
    if (!token || seen.has(token)) {
      duplicateOrBlankIds.push(Number(row.id));
      return;
    }
    seen.add(token);
  });

  if (duplicateOrBlankIds.length) {
    const findByToken = db.prepare("SELECT id FROM students WHERE qr_token = ? LIMIT 1");
    const updateToken = db.prepare("UPDATE students SET qr_token = ? WHERE id = ?");
    duplicateOrBlankIds.forEach((studentId) => {
      updateToken.run(generateUniqueStudentQrToken(findByToken), studentId);
    });
  }

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_students_qr_token_unique ON students(qr_token)");
}

function migrateStudentsTable() {
  const cols = getColumns("students");
  if (!cols.length) {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_id ON students(student_id)");
    return;
  }

  const currentSet = new Set(cols);
  const desiredSet = new Set(STUDENT_DB_COLUMNS);
  const isSameShape = cols.length === STUDENT_DB_COLUMNS.length
    && STUDENT_DB_COLUMNS.every((column) => currentSet.has(column))
    && cols.every((column) => desiredSet.has(column));

  if (!isSameShape) {
    const legacyRows = db.prepare("SELECT * FROM students ORDER BY id ASC").all();
    const tempTable = "students_rebuild_tmp";

    db.pragma("foreign_keys = OFF");
    db.exec(`DROP TABLE IF EXISTS ${tempTable}`);
    db.exec(getStudentTableSql(tempTable));
    const insertStudent = db.prepare(
      `INSERT INTO ${tempTable} (${STUDENT_DB_COLUMNS.join(", ")}) VALUES (${STUDENT_DB_COLUMNS.map(() => "?").join(", ")})`
    );
    legacyRows.forEach((row) => {
      const mapped = mapLegacyStudentRow(row);
      insertStudent.run(...STUDENT_DB_COLUMNS.map((column) => (Object.prototype.hasOwnProperty.call(mapped, column) ? mapped[column] : null)));
    });
    db.exec("DROP TABLE students");
    db.exec(`ALTER TABLE ${tempTable} RENAME TO students`);
    db.pragma("foreign_keys = ON");
  }

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_id ON students(student_id)");
  ensureStudentQrTokens();
}

function migrateStudentLevelsAndTahun() {
  const rows = db.prepare(`
    SELECT s.id, s.class_id, c.name AS class_name, COALESCE(s.level, '') AS level
    FROM students s
    JOIN classes c ON c.id = s.class_id
  `).all();
  const insertClass = db.prepare("INSERT OR IGNORE INTO classes (name) VALUES (?)");
  const findClass = db.prepare("SELECT id FROM classes WHERE name = ?");
  const updateStudent = db.prepare("UPDATE students SET class_id = ?, level = ? WHERE id = ?");
  const reassignPointLogs = db.prepare("UPDATE point_logs SET class_id = ? WHERE class_id = ?");
  const reassignAttendance = getColumns("attendance_sessions").length
    ? db.prepare("UPDATE attendance_sessions SET class_id = ? WHERE class_id = ?")
    : null;

  for (let level = 1; level <= 6; level += 1) {
    insertClass.run(`YEAR ${level}`);
  }

  rows.forEach((row) => {
    const targetClassName = normalizeClassName(row.class_name);
    const match = String(targetClassName || "").match(/^YEAR\s+([1-6])$/);
    if (!match) return;
    const targetClass = findClass.get(targetClassName);
    if (!targetClass) return;
    const nextLevel = String(row.level || "").trim() || `YEAR ${match[1]}`;
    updateStudent.run(targetClass.id, nextLevel, row.id);
    reassignPointLogs.run(targetClass.id, row.class_id);
    if (reassignAttendance) {
      reassignAttendance.run(targetClass.id, row.class_id);
    }
  });
}

function migrateCalendarEventsTable() {
  const cols = getColumns("calendar_events");
  if (!cols.includes("end_date")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN end_date TEXT");
  }
  if (!cols.includes("event_source")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN event_source TEXT");
  }
  if (!cols.includes("term_number")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN term_number INTEGER");
  }
  if (!cols.includes("school_week_number")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN school_week_number INTEGER");
  }
  if (!cols.includes("is_school_day")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN is_school_day INTEGER");
  }
  if (!cols.includes("is_available_for_pitis")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN is_available_for_pitis INTEGER");
  }
  if (!cols.includes("event_type")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN event_type TEXT");
  }
  if (!cols.includes("exclusion_reason")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN exclusion_reason TEXT");
  }
  if (!cols.includes("notes")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN notes TEXT");
  }
  if (!cols.includes("editable_flag")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN editable_flag INTEGER NOT NULL DEFAULT 1");
  }
  db.exec("UPDATE calendar_events SET event_source = 'manual' WHERE event_source IS NULL OR TRIM(event_source) = ''");
  db.exec("UPDATE calendar_events SET end_date = event_date WHERE end_date IS NULL OR TRIM(end_date) = ''");
  db.exec("UPDATE calendar_events SET event_type = COALESCE(NULLIF(event_type, ''), CASE WHEN event_source = 'manual' THEN 'school_event' ELSE event_source END)");
  db.exec("UPDATE calendar_events SET editable_flag = 1 WHERE editable_flag IS NULL");
}

function migrateSchoolCalendarTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_school_days (
      calendar_date TEXT PRIMARY KEY,
      calendar_year INTEGER NOT NULL,
      day_name TEXT NOT NULL,
      term_number INTEGER,
      school_week_number INTEGER,
      is_school_day INTEGER NOT NULL DEFAULT 0,
      is_public_holiday INTEGER NOT NULL DEFAULT 0,
      is_term_holiday INTEGER NOT NULL DEFAULT 0,
      is_available_for_pitis INTEGER NOT NULL DEFAULT 0,
      event_type TEXT NOT NULL DEFAULT 'non_school_day',
      holiday_name TEXT,
      exclusion_reason TEXT,
      notes TEXT,
      editable_flag INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'moe_2026',
      updated_at TEXT,
      updated_by INTEGER,
      FOREIGN KEY (updated_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_calendar_school_days_year_date ON calendar_school_days(calendar_year, calendar_date);
    CREATE INDEX IF NOT EXISTS idx_calendar_school_days_term_week ON calendar_school_days(term_number, school_week_number);
    CREATE INDEX IF NOT EXISTS idx_calendar_school_days_type ON calendar_school_days(event_type, is_available_for_pitis);
  `);
}

function migratePointReasonsTable() {
  const cols = getColumns("point_reasons");
  if (!cols.includes("reason_type")) {
    db.exec("ALTER TABLE point_reasons ADD COLUMN reason_type TEXT NOT NULL DEFAULT 'positive'");
  }

  db.exec("UPDATE point_reasons SET reason_type = 'positive' WHERE reason_type IS NULL OR TRIM(reason_type) = ''");

  db.exec(`
    UPDATE point_reasons
    SET reason_type = CASE
      WHEN LOWER(reason) LIKE '%late%' OR LOWER(reason) LIKE '%disruption%' OR LOWER(reason) LIKE '%misconduct%' OR LOWER(reason) LIKE '%bad%'
      THEN 'negative'
      ELSE reason_type
    END
  `);

  db.exec(`
    UPDATE point_reasons
    SET reason_type = CASE
      WHEN EXISTS (
        SELECT 1 FROM point_logs pl
        WHERE pl.reason = point_reasons.reason AND pl.points < 0
      ) AND NOT EXISTS (
        SELECT 1 FROM point_logs pl2
        WHERE pl2.reason = point_reasons.reason AND pl2.points > 0
      )
      THEN 'negative'
      WHEN EXISTS (
        SELECT 1 FROM point_logs pl3
        WHERE pl3.reason = point_reasons.reason AND pl3.points > 0
      ) AND NOT EXISTS (
        SELECT 1 FROM point_logs pl4
        WHERE pl4.reason = point_reasons.reason AND pl4.points < 0
      )
      THEN 'positive'
      ELSE reason_type
    END
  `);
}
function seedCalendarLabels() {
  const now = dayjs().toISOString();
  const defaults = [
    { name: "Public Holiday", color: "#e74c3c", description: "National/public holiday" },
    { name: "Cuti Penggal", color: "#f39c12", description: "School term break" },
    { name: "School Closure", color: "#7c3aed", description: "An announced non-school day that is excluded from PITIS reporting and reminders" },
    { name: "Birthday", color: "#f1c40f", description: "Student birthday" },
    { name: "Device Booking", color: "#3498db", description: "Booked school multimedia device" },
    { name: "PD", color: "#2ecc71", description: "Professional development" },
    { name: "Meeting", color: "#3498db", description: "Meeting" },
    { name: "Taklimat", color: "#9b59b6", description: "Briefing / Taklimat" },
    { name: "School Event", color: "#1abc9c", description: "School event" },
    { name: "Assessment", color: "#e67e22", description: "Assessment" },
    { name: "Dateline", color: "#e84393", description: "Deadline / dateline" }
  ];

  const insert = db.prepare(
    `INSERT INTO calendar_labels (name, color, description, created_by, is_system, created_at)
     VALUES (?, ?, ?, NULL, 1, ?)
     ON CONFLICT(name) DO UPDATE SET color = excluded.color, description = excluded.description`
  );

  for (const label of defaults) {
    insert.run(label.name, label.color, label.description, now);
  }
}

function migrateSiblingsToRelation() {
  const relationCount = db.prepare("SELECT COUNT(*) AS count FROM student_siblings").get().count;
  if (relationCount > 0) return;

  const rows = db.prepare("SELECT id, family_id FROM students WHERE family_id IS NOT NULL AND TRIM(family_id) <> '' ORDER BY family_id ASC, id ASC").all();
  const insertRel = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );
  const now = dayjs().toISOString();

  const grouped = new Map();
  for (const row of rows) {
    const familyId = String(row.family_id || "").trim();
    if (!grouped.has(familyId)) {
      grouped.set(familyId, []);
    }
    grouped.get(familyId).push(Number(row.id));
  }

  grouped.forEach((studentIds) => {
    studentIds.forEach((studentId) => {
      studentIds.forEach((siblingId) => {
        if (studentId === siblingId) return;
        insertRel.run(studentId, siblingId, now);
      });
    });
  });
}

function migrateInformationFilesTable() {
  db.exec("CREATE TABLE IF NOT EXISTS info_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS information_files (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL, file_path TEXT NOT NULL, uploaded_by INTEGER NOT NULL, uploaded_at TEXT NOT NULL, FOREIGN KEY (uploaded_by) REFERENCES users(id))");
  const folderCols = getColumns("info_folders");
  if (!folderCols.includes("sort_order")) {
    db.exec("ALTER TABLE info_folders ADD COLUMN sort_order INTEGER");
  }
  db.exec("UPDATE info_folders SET sort_order = id WHERE sort_order IS NULL");
  const cols = getColumns("information_files");
  if (!cols.includes("folder_id")) {
    db.exec("ALTER TABLE information_files ADD COLUMN folder_id INTEGER");
  }
}

function migrateRewardsGalleryTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rewards_gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      points_required INTEGER NOT NULL,
      image_path TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_rewards_gallery_active_points ON rewards_gallery(is_active, points_required);
  `);

  const cols = getColumns("rewards_gallery");
  if (!cols.includes("description")) {
    db.exec("ALTER TABLE rewards_gallery ADD COLUMN description TEXT");
  }
  if (!cols.includes("image_path")) {
    db.exec("ALTER TABLE rewards_gallery ADD COLUMN image_path TEXT");
  }
  if (!cols.includes("is_active")) {
    db.exec("ALTER TABLE rewards_gallery ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("updated_at")) {
    db.exec("ALTER TABLE rewards_gallery ADD COLUMN updated_at TEXT");
  }
  db.exec("UPDATE rewards_gallery SET is_active = 1 WHERE is_active IS NULL");
}

function migrateClassNames() {
  const desired = ["PRA", "YEAR 1", "YEAR 2", "YEAR 3", "YEAR 4", "YEAR 5", "YEAR 6"];
  const byName = db.prepare("SELECT id, name FROM classes WHERE name = ?");
  const rename = db.prepare("UPDATE classes SET name = ? WHERE id = ?");
  const reassignStudents = db.prepare("UPDATE students SET class_id = ? WHERE class_id = ?");
  const reassignPointLogs = db.prepare("UPDATE point_logs SET class_id = ? WHERE class_id = ?");
  const reassignAttendance = db.prepare("UPDATE attendance_sessions SET class_id = ? WHERE class_id = ?");
  const removeClass = db.prepare("DELETE FROM classes WHERE id = ?");

  function moveClassReferences(targetClassId, sourceClassId) {
    if (Number(targetClassId) === Number(sourceClassId)) return;
    reassignStudents.run(targetClassId, sourceClassId);
    reassignPointLogs.run(targetClassId, sourceClassId);
    if (getColumns("attendance_sessions").length) {
      reassignAttendance.run(targetClassId, sourceClassId);
    }
  }

  function canonicalClassName(name) {
    return normalizeClassName(name);
  }

  const legacyMap = {
    "Year 1 Amanah": "YEAR 1",
    "Year 2 Bestari": "YEAR 2",
    "Year 3 Cemerlang": "YEAR 3",
    "Year 4 Dinamik": "YEAR 4"
  };

  for (const [oldName, newName] of Object.entries(legacyMap)) {
    const oldClass = byName.get(oldName);
    if (!oldClass) continue;

    const targetClass = byName.get(newName);
    if (targetClass) {
      moveClassReferences(targetClass.id, oldClass.id);
      removeClass.run(oldClass.id);
    } else {
      rename.run(newName, oldClass.id);
    }
  }

  const regexYear = /^Year\s+([1-6])\b/i;
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY id ASC").all();
  for (const c of classes) {
    const match = String(c.name || "").match(regexYear);
    if (!match) continue;
    const targetName = "YEAR " + match[1];
    if (!desired.includes(targetName)) continue;

    const target = byName.get(targetName);
    if (target && target.id !== c.id) {
      moveClassReferences(target.id, c.id);
      removeClass.run(c.id);
    } else if (!target) {
      rename.run(targetName, c.id);
    }
  }

  const tahunClasses = db.prepare("SELECT id, name FROM classes WHERE UPPER(name) LIKE 'TAHUN %' ORDER BY id ASC").all();
  for (const tahunClass of tahunClasses) {
    const targetName = normalizeClassName(tahunClass.name);
    if (!targetName || targetName === tahunClass.name) continue;
    const target = byName.get(targetName);
    if (target && Number(target.id) !== Number(tahunClass.id)) {
      moveClassReferences(target.id, tahunClass.id);
      removeClass.run(tahunClass.id);
    } else {
      rename.run(targetName, tahunClass.id);
    }
  }

  const currentClasses = db.prepare("SELECT id, name FROM classes ORDER BY id ASC").all();
  const grouped = new Map();
  for (const classRow of currentClasses) {
    const canonicalName = canonicalClassName(classRow.name);
    if (!canonicalName) continue;
    if (!grouped.has(canonicalName)) {
      grouped.set(canonicalName, []);
    }
    grouped.get(canonicalName).push(classRow);
  }

  for (const [canonicalName, variants] of grouped.entries()) {
    const exactTarget = variants.find((variant) => variant.name === canonicalName);
    const target = exactTarget || variants[0];

    if (target.name !== canonicalName) {
      rename.run(canonicalName, target.id);
    }

    variants.forEach((variant) => {
      if (variant.id === target.id) return;
      moveClassReferences(target.id, variant.id);
      removeClass.run(variant.id);
    });
  }

  const insertClass = db.prepare("INSERT OR IGNORE INTO classes (name) VALUES (?)");
  desired.forEach((name) => insertClass.run(name));
}
function seedDefaults() {
  const now = dayjs().toISOString();

  const classNames = ["PRA", "YEAR 1", "YEAR 2", "YEAR 3", "YEAR 4", "YEAR 5", "YEAR 6"];
  const insertClass = db.prepare("INSERT OR IGNORE INTO classes (name) VALUES (?)");
  classNames.forEach((name) => insertClass.run(name));

  const hasReasons = db.prepare("SELECT COUNT(*) as count FROM point_reasons").get().count > 0;
  if (!hasReasons) {
    const insertReason = db.prepare(
      "INSERT INTO point_reasons (reason, reason_type, created_by, is_custom, created_at) VALUES (?, ?, NULL, 0, ?)"
    );
    [
      { reason: "Homework completed", type: "positive" },
      { reason: "Good behavior", type: "positive" },
      { reason: "Helped classmate", type: "positive" },
      { reason: "Late submission", type: "negative" },
      { reason: "Class disruption", type: "negative" }
    ].forEach((item) => {
      insertReason.run(item.reason, item.type, now);
    });
  }
  const shouldSeedMockStudents = process.env.SEED_MOCK_STUDENTS === "1";
  const hasStudents = db.prepare("SELECT COUNT(*) as count FROM students").get().count > 0;
  if (shouldSeedMockStudents && !hasStudents) {
    const classes = db.prepare("SELECT id, name FROM classes ORDER BY id").all();
    const insertStudent = db.prepare(
      `INSERT INTO students
       (name, full_name, student_id, no_sb, gender, dob, emergency_contact, family_id, alamat, class_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const first = ["Aiman", "Siti", "Nur", "Amir", "Haziq", "Nadia", "Faris", "Izzah", "Danish", "Alya"];
    const last = ["Ahmad", "Brahim", "Jamil", "Kassim", "Rahman", "Salleh", "Yusof", "Hakim", "Razak", "Musa"];

    let counter = 1;
    for (const c of classes) {
      for (let i = 0; i < 12; i += 1) {
        const fullName = `${first[i % first.length]} ${last[(i + c.id) % last.length]}`;
        const shortName = `${first[i % first.length]}${counter}`;
        const externalStudentId = `STU${String(counter).padStart(4, "0")}`;
        const noSb = `NSB${String(counter).padStart(4, "0")}`;
        const dob = dayjs("2017-01-01").add(counter % 1500, "day").format("YYYY-MM-DD");
        insertStudent.run(
          shortName,
          fullName,
          externalStudentId,
          noSb,
          counter % 2 === 0 ? "Male" : "Female",
          dob,
          `+673-8${String(100000 + counter).slice(-6)}`,
          `FAM${String(Math.ceil(counter / 2)).padStart(3, "0")}`,
          `Kg. Mock ${((counter - 1) % 7) + 1}, Tutong`,
          c.id,
          now
        );
        counter += 1;
      }
    }
  }

  const shouldSeedMockEvents = process.env.SEED_MOCK_EVENTS === "1";
  const hasEvents = db.prepare("SELECT COUNT(*) as count FROM calendar_events").get().count > 0;
  if (shouldSeedMockEvents && !hasEvents) {
    const teacher = db.prepare("SELECT id FROM users WHERE username = ?").get("hizemrie");
    const insertEvent = db.prepare(
      `INSERT INTO calendar_events
       (title, details, event_date, end_date, created_by, created_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    );
    [
      { title: "Assembly Briefing", details: "Morning updates", offset: 0, span: 1 },
      { title: "Homework Deadline", details: "Math workbook", offset: 1, span: 1 },
      { title: "Sports Practice", details: "Field session", offset: 3, span: 2 },
      { title: "Reading Assessment", details: "Library room", offset: 5, span: 1 },
      { title: "Parent Check-in", details: "Phone call round", offset: 7, span: 1 }
    ].forEach((e) => {
      const start = dayjs().add(e.offset, "day");
      insertEvent.run(
        e.title,
        e.details,
        start.format("YYYY-MM-DD"),
        start.add(e.span - 1, "day").format("YYYY-MM-DD"),
        teacher.id,
        now
      );
    });
  }
}

function updateDailySnapshot(studentId) {
  const snapshotDate = dayjs().format("YYYY-MM-DD");
  const totalPoints = db
    .prepare("SELECT COALESCE(SUM(points), 0) AS total FROM point_logs WHERE student_id = ?")
    .get(studentId).total;

  db.prepare(
    `INSERT INTO daily_points (snapshot_date, student_id, total_points, last_updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(snapshot_date, student_id)
     DO UPDATE SET total_points = excluded.total_points, last_updated_at = excluded.last_updated_at`
  ).run(snapshotDate, studentId, totalPoints, dayjs().toISOString());
}

function migrateAttendanceTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL,
      session_type TEXT NOT NULL CHECK (session_type IN ('morning','afternoon')),
      recorded_by INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (class_id) REFERENCES classes(id),
      FOREIGN KEY (recorded_by) REFERENCES users(id),
      UNIQUE (class_id, attendance_date, session_type)
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      is_present INTEGER NOT NULL DEFAULT 1,
      absence_reason TEXT,
      FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id),
      UNIQUE (session_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_sessions_class_date ON attendance_sessions(class_id, attendance_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_records_session ON attendance_records(session_id);

    CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK (action_type IN ('save','reset','no_change')),
      actor_user_id INTEGER,
      actor_label TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (class_id) REFERENCES classes(id),
      FOREIGN KEY (actor_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_logs_class_date ON attendance_logs(class_id, attendance_date, created_at DESC);
  `);
}

function migrateNotesTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_by INTEGER,
      updated_at TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (updated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS note_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      comment_text TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS note_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      action_type TEXT NOT NULL CHECK (action_type IN ('create','edit','comment')),
      log_details TEXT,
      actor_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS catatan_harian_checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('pemakanan','aktiviti')),
      item_text TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catatan_harian_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      hari TEXT NOT NULL,
      tarikh TEXT NOT NULL,
      catatan TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS catatan_harian_report_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      checklist_item_id INTEGER,
      category TEXT NOT NULL CHECK (category IN ('pemakanan','aktiviti')),
      item_text TEXT NOT NULL,
      FOREIGN KEY (report_id) REFERENCES catatan_harian_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (checklist_item_id) REFERENCES catatan_harian_checklist_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_note_comments_note_id ON note_comments(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_logs_note_id ON note_logs(note_id);
    CREATE INDEX IF NOT EXISTS idx_catatan_harian_reports_tarikh ON catatan_harian_reports(tarikh DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_catatan_harian_reports_user ON catatan_harian_reports(user_id, tarikh DESC);
    CREATE INDEX IF NOT EXISTS idx_catatan_harian_report_items_report ON catatan_harian_report_items(report_id);
  `);

  seedCatatanHarianChecklistDefaults();
}

function seedCatatanHarianChecklistDefaults() {
  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO catatan_harian_checklist_items (category, item_text, is_active, created_at, updated_at)
    SELECT ?, ?, 1, ?, ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM catatan_harian_checklist_items
      WHERE category = ? AND item_text = ?
    )
  `);

  [
    ["pemakanan", "Makanan mencukupi"],
    ["pemakanan", "Murid makan di kawasan ditetapkan"],
    ["pemakanan", "Kawasan makan bersih"],
    ["pemakanan", "Tiada isu makanan dilaporkan"],
    ["aktiviti", "Perhimpunan pagi dijalankan"],
    ["aktiviti", "Kehadiran murid dipantau"],
    ["aktiviti", "Kelas berjalan seperti biasa"],
    ["aktiviti", "Kebersihan kelas dipantau"],
    ["aktiviti", "Murid pulang mengikut masa"]
  ].forEach(([category, itemText]) => {
    insert.run(category, itemText, now, now, category, itemText);
  });
}

function migrateDeviceTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      serial_number TEXT,
      photo_path TEXT,
      photo_uploaded_at TEXT,
      location TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','unavailable','inactive')),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      booking_date TEXT NOT NULL,
      planned_start_time TEXT NOT NULL,
      planned_end_time TEXT NOT NULL,
      actual_start_time TEXT,
      actual_end_time TEXT,
      took_from_hub_at TEXT,
      returned_to_hub_at TEXT,
      class_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      lesson_topic TEXT NOT NULL,
      venue TEXT NOT NULL,
      purpose TEXT NOT NULL,
      remarks TEXT,
      status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','in_use','completed','cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (device_id) REFERENCES devices(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
    CREATE INDEX IF NOT EXISTS idx_device_bookings_device_date ON device_bookings(device_id, booking_date);
    CREATE INDEX IF NOT EXISTS idx_device_bookings_user_date ON device_bookings(user_id, booking_date);
    CREATE INDEX IF NOT EXISTS idx_device_bookings_status ON device_bookings(status);
  `);

  const bookingCols = getColumns("device_bookings");
  if (!bookingCols.includes("took_from_hub_at")) {
    db.exec("ALTER TABLE device_bookings ADD COLUMN took_from_hub_at TEXT");
  }
  if (!bookingCols.includes("returned_to_hub_at")) {
    db.exec("ALTER TABLE device_bookings ADD COLUMN returned_to_hub_at TEXT");
  }

  const deviceCols = getColumns("devices");
  if (!deviceCols.includes("photo_path")) {
    db.exec("ALTER TABLE devices ADD COLUMN photo_path TEXT");
  }
  if (!deviceCols.includes("photo_uploaded_at")) {
    db.exec("ALTER TABLE devices ADD COLUMN photo_uploaded_at TEXT");
  }
}

function seedDeviceLocations() {
  const now = dayjs().toISOString();
  const insertLocation = db.prepare(
    `INSERT OR IGNORE INTO device_locations (name, is_active, created_at, updated_at)
     VALUES (?, 1, ?, ?)`
  );

  ["Device Hub", "School Hall", "Lab 1", "Library", "YEAR 5"].forEach((name) => {
    insertLocation.run(name, now, now);
  });

  const existingDeviceLocations = db.prepare("SELECT DISTINCT location FROM devices WHERE TRIM(COALESCE(location, '')) <> ''").all();
  existingDeviceLocations.forEach((row) => {
    insertLocation.run(String(row.location).trim(), now, now);
  });
}

function seedDeviceVenues() {
  const now = dayjs().toISOString();
  const insertVenue = db.prepare(
    `INSERT OR IGNORE INTO device_venues (name, is_active, created_at, updated_at)
     VALUES (?, 1, ?, ?)`
  );

  ["School Hall", "Lab 1", "Library", "YEAR 5", "Computer Room"].forEach((name) => {
    insertVenue.run(name, now, now);
  });

  const existingBookingVenues = db.prepare("SELECT DISTINCT venue FROM device_bookings WHERE TRIM(COALESCE(venue, '')) <> ''").all();
  existingBookingVenues.forEach((row) => {
    insertVenue.run(String(row.venue).trim(), now, now);
  });
}

function seedDeviceDefaults() {
  const now = dayjs().toISOString();
  const hasDevices = db.prepare("SELECT COUNT(*) AS count FROM devices").get().count > 0;
  if (hasDevices) return;

  const insertDevice = db.prepare(
    `INSERT INTO devices
     (name, code, category, brand, model, serial_number, location, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  [
    ["Laptop 01", "LAP-01", "Laptop", "Dell", "Latitude", "", "Device Hub", "available", "Sample seeded device"],
    ["Laptop 02", "LAP-02", "Laptop", "Dell", "Latitude", "", "Device Hub", "available", "Sample seeded device"],
    ["Projector Hall", "PROJ-HALL", "Projector", "Epson", "", "", "School Hall", "available", "Sample seeded device"],
    ["Speaker A", "SPK-A", "Speaker", "JBL", "", "", "Device Hub", "available", "Sample seeded device"],
    ["TV Panel Year 5", "TV-Y5", "TV Panel", "Samsung", "", "", "YEAR 5", "available", "Sample seeded device"]
  ].forEach((device) => {
    insertDevice.run(...device, now, now);
  });
}

function createInventoryToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function seedInventoryOptionTable(table, values) {
  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO ${table} (name, is_active, created_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at
  `);
  values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .forEach((value) => insert.run(value, now, now));
}

function migrateInventoryTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS school_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      item_condition TEXT NOT NULL DEFAULT 'good',
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_use','maintenance','unavailable','inactive')),
      token TEXT UNIQUE,
      linked_device_id INTEGER,
      is_bookable INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (linked_device_id) REFERENCES devices(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_availability_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      document_type TEXT NOT NULL CHECK (document_type IN ('pdf','jpg')),
      uploaded_by INTEGER,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY (inventory_id) REFERENCES school_inventory(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_detail_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL UNIQUE,
      field_type TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','date','number')),
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_detail_values (
      inventory_id INTEGER NOT NULL,
      field_id INTEGER NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (inventory_id, field_id),
      FOREIGN KEY (inventory_id) REFERENCES school_inventory(id) ON DELETE CASCADE,
      FOREIGN KEY (field_id) REFERENCES inventory_detail_fields(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_school_inventory_status ON school_inventory(status);
    CREATE INDEX IF NOT EXISTS idx_school_inventory_linked_device ON school_inventory(linked_device_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_documents_inventory ON inventory_documents(inventory_id, uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inventory_detail_values_inventory ON inventory_detail_values(inventory_id);
  `);

  const cols = getColumns("school_inventory");
  if (!cols.includes("token")) {
    db.exec("ALTER TABLE school_inventory ADD COLUMN token TEXT");
  }
  if (!cols.includes("linked_device_id")) {
    db.exec("ALTER TABLE school_inventory ADD COLUMN linked_device_id INTEGER");
  }
  if (!cols.includes("is_bookable")) {
    db.exec("ALTER TABLE school_inventory ADD COLUMN is_bookable INTEGER NOT NULL DEFAULT 0");
  }

  const rows = db.prepare("SELECT id, token FROM school_inventory ORDER BY id ASC").all();
  const seen = new Set();
  const findByToken = db.prepare("SELECT id FROM school_inventory WHERE token = ? LIMIT 1");
  const updateToken = db.prepare("UPDATE school_inventory SET token = ? WHERE id = ?");
  rows.forEach((row) => {
    let token = String(row.token || "").trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      return;
    }
    do {
      token = createInventoryToken();
    } while (seen.has(token) || findByToken.get(token));
    seen.add(token);
    updateToken.run(token, row.id);
  });

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_school_inventory_token_unique ON school_inventory(token)");

  seedInventoryOptionTable("inventory_categories", [
    "Teaching Aid",
    "ICT",
    "Furniture",
    "Sports",
    "Stationery"
  ]);
  seedInventoryOptionTable("inventory_locations", [
    "Resource Room",
    "Device Hub",
    "Library",
    "Office"
  ]);
  seedInventoryOptionTable("inventory_conditions", [
    "new",
    "good",
    "fair",
    "needs repair"
  ]);
  seedInventoryOptionTable("inventory_availability_options", [
    "available",
    "in_use",
    "maintenance",
    "unavailable",
    "inactive"
  ]);

  seedInventoryOptionTable("inventory_categories", db.prepare("SELECT DISTINCT category AS name FROM school_inventory WHERE TRIM(category) <> ''").all().map((row) => row.name));
  seedInventoryOptionTable("inventory_locations", db.prepare("SELECT DISTINCT location AS name FROM school_inventory WHERE TRIM(location) <> ''").all().map((row) => row.name));
  seedInventoryOptionTable("inventory_conditions", db.prepare("SELECT DISTINCT item_condition AS name FROM school_inventory WHERE TRIM(item_condition) <> ''").all().map((row) => row.name));
  seedInventoryOptionTable("inventory_availability_options", db.prepare("SELECT DISTINCT status AS name FROM school_inventory WHERE TRIM(status) <> ''").all().map((row) => row.name));

  const now = dayjs().toISOString();
  const insertDetailField = db.prepare(`
    INSERT INTO inventory_detail_fields (field_key, label, field_type, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(field_key) DO NOTHING
  `);
  [
    ["delivery_order_ref", "Delivery order ref", "text"],
    ["date_of_delivery", "Date of Delivery", "date"],
    ["company", "Company", "text"],
    ["asset_id", "Asset ID", "text"],
    ["serial_number", "Serial Number", "text"],
    ["price", "Price", "number"],
    ["accepted_by", "Accepted By", "text"],
    ["no_of_total", "No of Total", "number"]
  ].forEach(([key, label, fieldType], index) => {
    insertDetailField.run(key, label, fieldType, (index + 1) * 10, now, now);
  });
}

function migrateBackupTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT,
      updated_by INTEGER,
      FOREIGN KEY (updated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS backup_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      auto_enabled INTEGER NOT NULL DEFAULT 1,
      backup_day_of_week INTEGER NOT NULL DEFAULT 6,
      backup_interval_days INTEGER NOT NULL DEFAULT 2,
      backup_time TEXT NOT NULL DEFAULT '15:00',
      destination_path TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      last_backup_path TEXT,
      updated_at TEXT,
      updated_by INTEGER,
      FOREIGN KEY (updated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS backup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'auto')),
      status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
      backup_name TEXT,
      backup_path TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT
    );
  `);

  const settingsCols = getColumns("backup_settings");
  if (!settingsCols.includes("backup_day_of_week")) {
    db.exec("ALTER TABLE backup_settings ADD COLUMN backup_day_of_week INTEGER NOT NULL DEFAULT 6");
  }
  if (!settingsCols.includes("backup_interval_days")) {
    db.exec("ALTER TABLE backup_settings ADD COLUMN backup_interval_days INTEGER NOT NULL DEFAULT 2");
  }
  if (!settingsCols.includes("last_status")) {
    db.exec("ALTER TABLE backup_settings ADD COLUMN last_status TEXT");
  }
  if (!settingsCols.includes("last_error")) {
    db.exec("ALTER TABLE backup_settings ADD COLUMN last_error TEXT");
  }
  if (!settingsCols.includes("last_backup_path")) {
    db.exec("ALTER TABLE backup_settings ADD COLUMN last_backup_path TEXT");
  }
  if (!settingsCols.includes("updated_at")) {
    db.exec("ALTER TABLE backup_settings ADD COLUMN updated_at TEXT");
  }
  if (!settingsCols.includes("updated_by")) {
    db.exec("ALTER TABLE backup_settings ADD COLUMN updated_by INTEGER");
  }
}

function requirePrivatePasswordsForExistingUsers() {
  const migrationKey = "require_private_passwords_for_existing_users_v1";
  const completed = db.prepare(
    "SELECT setting_value FROM app_settings WHERE setting_key = ?"
  ).get(migrationKey);
  if (completed) return;

  const appliedAt = dayjs().toISOString();
  const transaction = db.transaction(() => {
    db.prepare(
      "UPDATE users SET must_change_password = 1 WHERE role IN ('teacher', 'staff') AND COALESCE(is_active, 1) = 1"
    ).run();

    const sessionTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'web_sessions'"
    ).get();
    if (sessionTable) {
      db.prepare("DELETE FROM web_sessions").run();
    }

    db.prepare(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by)
       VALUES (?, 'complete', ?, NULL)`
    ).run(migrationKey, appliedAt);
  });

  transaction();
  console.log("Password-change requirement enabled for all existing active users.");
}

function retireKnownDemoAccounts() {
  const knownAccounts = [
    { username: "admin", password: "117911Zam" },
    { username: "hizemrie", password: "eirmezih" }
  ];
  const find = db.prepare("SELECT id, password_hash FROM users WHERE username = ?");
  const disable = db.prepare("UPDATE users SET is_active = 0, must_change_password = 1 WHERE id = ?");
  for (const account of knownAccounts) {
    const user = find.get(account.username);
    if (user && bcrypt.compareSync(account.password, user.password_hash)) {
      disable.run(user.id);
      console.warn(`Disabled legacy demo account: ${account.username}`);
    }
  }
}

function migrateAcademicYearRolloverTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS academic_year_rollover_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_year INTEGER NOT NULL,
      to_year INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      students_promoted INTEGER NOT NULL DEFAULT 0,
      students_graduated INTEGER NOT NULL DEFAULT 0,
      reset_fees INTEGER NOT NULL DEFAULT 0,
      backup_path TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_by INTEGER,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS student_academic_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rollover_run_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      academic_year INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      class_name TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('promoted','graduated')),
      destination_class_id INTEGER,
      destination_class_name TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (rollover_run_id) REFERENCES academic_year_rollover_runs(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_rollover_completed_year
      ON academic_year_rollover_runs(to_year) WHERE status = 'completed';
    CREATE INDEX IF NOT EXISTS idx_student_academic_history_student
      ON student_academic_history(student_id, academic_year DESC);
  `);
}

function migrateAdminAuditTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_action_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_label TEXT NOT NULL,
      target_type TEXT,
      target_label TEXT,
      request_method TEXT NOT NULL,
      request_path TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('success','failed')),
      response_status INTEGER NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      user_agent TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_admin_action_logs_created ON admin_action_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_action_logs_user ON admin_action_logs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_action_logs_result ON admin_action_logs(result, created_at DESC);
  `);
}

function migrateTeacherUsageAuditTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teacher_usage_audit_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL DEFAULT 'auto' CHECK (trigger_type IN ('auto','manual')),
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('success','failed')),
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS teacher_usage_weekly_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      school_day_count INTEGER NOT NULL DEFAULT 5,
      required_days INTEGER NOT NULL DEFAULT 3,
      valid_days INTEGER NOT NULL DEFAULT 0,
      target_met INTEGER NOT NULL DEFAULT 0,
      total_logins INTEGER NOT NULL DEFAULT 0,
      total_awards INTEGER NOT NULL DEFAULT 0,
      students_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES teacher_usage_audit_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_teacher_usage_audit_runs_started ON teacher_usage_audit_runs(started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_teacher_usage_weekly_audits_user_week ON teacher_usage_weekly_audits(user_id, week_start, run_id);
    CREATE INDEX IF NOT EXISTS idx_teacher_usage_weekly_audits_run ON teacher_usage_weekly_audits(run_id);
  `);
}

function migrateKioskTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kiosk_reward_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kiosk_scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL,
      session_type TEXT NOT NULL CHECK (session_type IN ('morning','afternoon')),
      scanned_at TEXT NOT NULL,
      log_time TEXT NOT NULL,
      rule_label TEXT,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      total_points_after INTEGER NOT NULL DEFAULT 0,
      qr_payload TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (class_id) REFERENCES classes(id),
      UNIQUE (student_id, attendance_date, session_type)
    );

    CREATE INDEX IF NOT EXISTS idx_kiosk_reward_rules_active ON kiosk_reward_rules(is_active, start_time, end_time);
    CREATE INDEX IF NOT EXISTS idx_kiosk_scan_logs_date ON kiosk_scan_logs(attendance_date, scanned_at DESC);
  `);

  const count = Number(db.prepare("SELECT COUNT(*) AS c FROM kiosk_reward_rules").get().c || 0);
  if (!count) {
    const now = dayjs().toISOString();
    const insertRule = db.prepare(`
      INSERT INTO kiosk_reward_rules (label, start_time, end_time, points, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `);
    [
      ["Early Arrival", "06:00", "07:00", 5],
      ["On Time", "07:01", "07:30", 3],
      ["Late Morning", "07:31", "11:59", 1],
      ["Afternoon", "12:00", "23:59", 1]
    ].forEach((rule) => {
      insertRule.run(rule[0], rule[1], rule[2], rule[3], now, now);
    });
  }
}

function migrateQrQuizTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qr_quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'all' CHECK (target_type IN ('all','class')),
      target_class_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed','archived')),
      award_enabled INTEGER NOT NULL DEFAULT 0,
      points_per_correct INTEGER NOT NULL DEFAULT 0,
      access_token TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT,
      closed_at TEXT,
      archived_at TEXT,
      FOREIGN KEY (target_class_id) REFERENCES classes(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS qr_quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      question_text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      correct_answer TEXT NOT NULL CHECK (correct_answer IN ('A','B','C')),
      FOREIGN KEY (quiz_id) REFERENCES qr_quizzes(id) ON DELETE CASCADE,
      UNIQUE (quiz_id, position)
    );

    CREATE TABLE IF NOT EXISTS qr_quiz_target_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id INTEGER NOT NULL,
      class_name TEXT NOT NULL,
      class_id INTEGER,
      FOREIGN KEY (quiz_id) REFERENCES qr_quizzes(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id),
      UNIQUE (quiz_id, class_name)
    );

    CREATE TABLE IF NOT EXISTS qr_quiz_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      total_questions INTEGER NOT NULL DEFAULT 0,
      pitis_awarded INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT NOT NULL,
      FOREIGN KEY (quiz_id) REFERENCES qr_quizzes(id),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (class_id) REFERENCES classes(id),
      UNIQUE (quiz_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS qr_quiz_response_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      response_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      selected_answer TEXT NOT NULL CHECK (selected_answer IN ('A','B','C')),
      is_correct INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (response_id) REFERENCES qr_quiz_responses(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES qr_quiz_questions(id),
      UNIQUE (response_id, question_id)
    );

    CREATE INDEX IF NOT EXISTS idx_qr_quizzes_status ON qr_quizzes(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_qr_quiz_questions_quiz ON qr_quiz_questions(quiz_id, position);
    CREATE INDEX IF NOT EXISTS idx_qr_quiz_responses_quiz ON qr_quiz_responses(quiz_id, submitted_at DESC);
  `);

  const targetColumns = getColumns("qr_quiz_target_classes");
  if (!targetColumns.includes("id") || !targetColumns.includes("class_name")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS qr_quiz_target_classes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL,
        class_name TEXT NOT NULL,
        class_id INTEGER,
        FOREIGN KEY (quiz_id) REFERENCES qr_quizzes(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id),
        UNIQUE (quiz_id, class_name)
      );
    `);

    const selectClassName = targetColumns.includes("class_name")
      ? "NULLIF(qtc.class_name, '')"
      : "NULL";
    const selectClassId = targetColumns.includes("class_id")
      ? "qtc.class_id"
      : "NULL";

    db.exec(`
      INSERT OR IGNORE INTO qr_quiz_target_classes_new (quiz_id, class_name, class_id)
      SELECT qtc.quiz_id, COALESCE(${selectClassName}, c.name), ${selectClassId}
      FROM qr_quiz_target_classes qtc
      LEFT JOIN classes c ON c.id = ${selectClassId}
      WHERE COALESCE(${selectClassName}, c.name) IS NOT NULL
    `);

    db.exec(`
      DROP TABLE qr_quiz_target_classes;
      ALTER TABLE qr_quiz_target_classes_new RENAME TO qr_quiz_target_classes;
      CREATE INDEX IF NOT EXISTS idx_qr_quiz_target_classes_class ON qr_quiz_target_classes(class_id, quiz_id);
      CREATE INDEX IF NOT EXISTS idx_qr_quiz_target_classes_name ON qr_quiz_target_classes(class_name, quiz_id);
    `);
  } else {
    if (!targetColumns.includes("class_id")) {
      db.exec("ALTER TABLE qr_quiz_target_classes ADD COLUMN class_id INTEGER");
    }
    db.exec(`
      UPDATE qr_quiz_target_classes
      SET class_id = (
        SELECT id FROM classes WHERE classes.name = qr_quiz_target_classes.class_name
      )
      WHERE class_id IS NULL
    `);
  }

  db.exec(`
    INSERT OR IGNORE INTO qr_quiz_target_classes (quiz_id, class_name, class_id)
    SELECT q.id, c.name, c.id
    FROM qr_quizzes q
    JOIN classes c ON c.id = q.target_class_id
    WHERE q.target_type = 'class' AND q.target_class_id IS NOT NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_qr_quiz_target_classes_class ON qr_quiz_target_classes(class_id, quiz_id);
    CREATE INDEX IF NOT EXISTS idx_qr_quiz_target_classes_name ON qr_quiz_target_classes(class_name, quiz_id);
  `);
}

function initializeDatabase() {
  createTables();
  migrateUsersTable();
  migrateUserLoginLogsTable();
  migrateStudentEditLogsTable();
  migratePhotoLibraryTables();
  migrateStudentsTable();
  migrateCalendarEventsTable();
  migrateSchoolCalendarTables();
  migratePointReasonsTable();
  migrateStudentLevelsAndTahun();
  migrateAttendanceTables();
  migrateClassNames();
  migrateSiblingsToRelation();
  migrateInformationFilesTable();
  migrateRewardsGalleryTable();
  migrateNotesTables();
  migrateDeviceTables();
  migrateInventoryTables();
  migrateBackupTables();
  requirePrivatePasswordsForExistingUsers();
  migrateAcademicYearRolloverTables();
  migrateAdminAuditTables();
  migrateTeacherUsageAuditTables();
  migrateKioskTables();
  migrateQrQuizTables();
  db.exec(`
    CREATE TABLE IF NOT EXISTS pwa_user_activity (
      user_id INTEGER PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      page_views INTEGER NOT NULL DEFAULT 0,
      bootstrap_count INTEGER NOT NULL DEFAULT 0,
      scan_count INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      last_class_id INTEGER,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (last_class_id) REFERENCES classes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pwa_user_activity_last_seen ON pwa_user_activity(last_seen_at DESC);
  `);
  retireKnownDemoAccounts();
  seedDefaults();
  seedCalendarLabels();
  seedDeviceLocations();
  seedDeviceVenues();
  seedDeviceDefaults();
}

module.exports = {
  db,
  initializeDatabase,
  updateDailySnapshot
};

































