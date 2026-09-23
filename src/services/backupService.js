const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { dbPath, reloadDatabaseConnection, closeDatabaseConnection } = require("../db/database");
const { getMaintenanceState } = require("./maintenanceService");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const LEGACY_FALLBACK_DIRECTORY = path.join(PROJECT_ROOT, "backup");
const LEGACY_SETTINGS_FALLBACK_PATH = path.join(LEGACY_FALLBACK_DIRECTORY, "auto-backup-settings.json");
const DATA_DIRECTORY = path.dirname(dbPath);
const SETTINGS_FALLBACK_PATH = path.join(DATA_DIRECTORY, "backup-settings.json");
const LEGACY_DEFAULT_DESTINATION_PATH = "/home/hp/Documents/pitis/backup/auto-backups";
const DEFAULT_DESTINATION_PATH = path.join(DATA_DIRECTORY, "backups");
const PUBLIC_UPLOADS_DIR = path.join(PROJECT_ROOT, "public", "uploads");

const BACKUP_TABLES = {
  app_settings: ["setting_key", "setting_value", "updated_at", "updated_by"],
  users: ["id", "username", "email", "display_name", "role", "user_type", "password_hash", "is_active", "created_at"],
  classes: ["id", "name"],
  academic_year_rollover_runs: ["id", "from_year", "to_year", "status", "students_promoted", "students_graduated", "reset_fees", "backup_path", "error_message", "started_at", "completed_at", "created_by"],
  student_academic_history: ["id", "rollover_run_id", "student_id", "academic_year", "class_id", "class_name", "outcome", "destination_class_id", "destination_class_name", "recorded_at"],
  admin_action_logs: ["id", "user_id", "username", "display_name", "action_type", "action_label", "target_type", "target_label", "request_method", "request_path", "result", "response_status", "details_json", "ip_address", "user_agent", "duration_ms", "created_at"],
  students: [
    "id",
    "name",
    "full_name",
    "student_id",
    "qr_token",
    "family_id",
    "no_sb",
    "no_bruhims",
    "bangsa",
    "ugama",
    "kerakyatan",
    "dob",
    "gender",
    "age",
    "level",
    "notes",
    "emergency_contact",
    "alamat",
    "nama_ayah",
    "pekerjaan_ayah",
    "dob_ayah",
    "taraf_ayah",
    "no_telefon_ayah",
    "bangsa_ayah",
    "ugama_ayah",
    "kerakyatan_ayah",
    "nama_ibu",
    "pekerjaan_ibu",
    "dob_ibu",
    "taraf_ibu",
    "no_telefon_ibu",
    "bangsa_ibu",
    "ugama_ibu",
    "kerakyatan_ibu",
    "yiuran_sekolah_paid",
    "yuran_pibg_paid",
    "insuran_paid",
    "photo_path",
    "photo_uploaded_at",
    "photo_uploaded_by",
    "photo_2_path",
    "photo_2_uploaded_at",
    "photo_2_uploaded_by",
    "photo_3_path",
    "photo_3_uploaded_at",
    "photo_3_uploaded_by",
    "photo_4_path",
    "photo_4_uploaded_at",
    "photo_4_uploaded_by",
    "photo_5_path",
    "photo_5_uploaded_at",
    "photo_5_uploaded_by",
    "photo_6_path",
    "photo_6_uploaded_at",
    "photo_6_uploaded_by",
    "class_id",
    "created_at"
  ],
  student_siblings: ["id", "student_pk", "sibling_student_pk", "created_at"],
  point_reasons: ["id", "reason", "reason_type", "created_by", "is_custom", "created_at"],
  point_logs: ["id", "student_id", "class_id", "points", "reason", "awarded_by", "awarded_at"],
  daily_points: ["id", "snapshot_date", "student_id", "total_points", "last_updated_at"],
  kiosk_reward_rules: ["id", "label", "start_time", "end_time", "points", "is_active", "created_at", "updated_at"],
  kiosk_scan_logs: ["id", "student_id", "class_id", "attendance_date", "session_type", "scanned_at", "log_time", "rule_label", "points_awarded", "total_points_after", "qr_payload", "status"],
  qr_quizzes: ["id", "title", "target_type", "target_class_id", "status", "award_enabled", "points_per_correct", "access_token", "created_by", "created_at", "updated_at", "activated_at", "closed_at", "archived_at"],
  qr_quiz_questions: ["id", "quiz_id", "position", "question_text", "option_a", "option_b", "option_c", "correct_answer"],
  qr_quiz_target_classes: ["id", "quiz_id", "class_name", "class_id"],
  qr_quiz_responses: ["id", "quiz_id", "student_id", "class_id", "score", "total_questions", "pitis_awarded", "submitted_at"],
  qr_quiz_response_answers: ["id", "response_id", "question_id", "selected_answer", "is_correct"],
  rewards_gallery: ["id", "title", "description", "points_required", "image_path", "is_active", "created_by", "created_at", "updated_at"],
  calendar_events: ["id", "title", "details", "event_date", "end_date", "event_source", "created_by", "created_at", "deleted_by", "deleted_at", "is_deleted", "term_number", "school_week_number", "is_school_day", "is_available_for_pitis", "event_type", "exclusion_reason", "notes", "editable_flag"],
  calendar_labels: ["id", "name", "color", "description", "created_by", "is_system", "created_at"],
  calendar_event_labels: ["event_id", "label_id"],
  calendar_event_users: ["event_id", "user_id"],
  calendar_school_days: ["calendar_date", "calendar_year", "day_name", "term_number", "school_week_number", "is_school_day", "is_public_holiday", "is_term_holiday", "is_available_for_pitis", "event_type", "holiday_name", "exclusion_reason", "notes", "editable_flag", "source", "updated_at", "updated_by"],
  user_login_logs: ["id", "user_id", "username", "display_name", "role", "user_type", "logged_at", "ip_address", "user_agent"],
  teacher_usage_audit_runs: ["id", "trigger_type", "date_from", "date_to", "started_at", "finished_at", "status", "error_message"],
  teacher_usage_weekly_audits: ["id", "run_id", "user_id", "username", "display_name", "week_start", "week_end", "school_day_count", "required_days", "valid_days", "target_met", "total_logins", "total_awards", "students_awarded", "created_at"],
  student_edit_logs: ["id", "student_pk", "student_id", "student_full_name", "field_key", "field_label", "old_value", "new_value", "edited_by", "edited_by_label", "edited_at"],
  catatan_harian_checklist_items: ["id", "category", "item_text", "is_active", "created_at", "updated_at"],
  catatan_harian_reports: ["id", "user_id", "hari", "tarikh", "catatan", "created_by", "created_at", "updated_at"],
  catatan_harian_report_items: ["id", "report_id", "checklist_item_id", "category", "item_text"],
  attendance_sessions: ["id", "class_id", "attendance_date", "session_type", "recorded_by", "recorded_at"],
  attendance_records: ["id", "session_id", "student_id", "is_present", "absence_reason"],
  attendance_logs: ["id", "class_id", "attendance_date", "action_type", "actor_user_id", "actor_label", "details", "created_at"],
  device_locations: ["id", "name", "is_active", "created_at", "updated_at"],
  device_venues: ["id", "name", "is_active", "created_at", "updated_at"],
  devices: ["id", "name", "code", "category", "brand", "model", "serial_number", "photo_path", "photo_uploaded_at", "location", "status", "notes", "created_at", "updated_at"],
  device_bookings: ["id", "device_id", "user_id", "booking_date", "planned_start_time", "planned_end_time", "actual_start_time", "actual_end_time", "took_from_hub_at", "returned_to_hub_at", "class_name", "subject", "lesson_topic", "venue", "purpose", "remarks", "status", "created_at", "updated_at"],
  inventory_locations: ["id", "name", "is_active", "created_at", "updated_at"],
  inventory_categories: ["id", "name", "is_active", "created_at", "updated_at"],
  inventory_conditions: ["id", "name", "is_active", "created_at", "updated_at"],
  inventory_availability_options: ["id", "name", "is_active", "created_at", "updated_at"],
  school_inventory: ["id", "name", "code", "category", "location", "item_condition", "status", "token", "linked_device_id", "is_bookable", "notes", "created_at", "updated_at"],
  inventory_documents: ["id", "inventory_id", "original_name", "file_name", "file_path", "mime_type", "document_type", "uploaded_by", "uploaded_at"],
  inventory_detail_fields: ["id", "field_key", "label", "field_type", "is_active", "sort_order", "created_at", "updated_at"],
  inventory_detail_values: ["inventory_id", "field_id", "value", "updated_at"],
  info_folders: ["id", "name", "created_at"],
  information_files: ["id", "title", "file_name", "file_path", "folder_id", "uploaded_by", "uploaded_at"],
  photo_folders: ["id", "name", "parent_id", "created_by", "created_at"],
  photo_files: ["id", "folder_id", "original_name", "stored_name", "file_path", "mime_type", "file_size_bytes", "captured_at", "captured_at_source", "uploaded_by", "uploaded_at"],
  photo_activity_logs: ["id", "user_id", "username", "display_name", "activity_type", "target_type", "target_label", "folder_id", "file_id", "details", "created_at", "ip_address", "user_agent"]
};

const OPTIONAL_BACKUP_TABLES = new Set([
  "app_settings",
  "academic_year_rollover_runs",
  "student_academic_history",
  "admin_action_logs",
  "rewards_gallery",
  "calendar_labels",
  "calendar_event_labels",
  "calendar_event_users",
  "calendar_school_days",
  "user_login_logs",
  "teacher_usage_audit_runs",
  "teacher_usage_weekly_audits",
  "student_edit_logs",
  "catatan_harian_checklist_items",
  "catatan_harian_reports",
  "catatan_harian_report_items",
  "attendance_sessions",
  "attendance_records",
  "attendance_logs",
  "device_locations",
  "device_venues",
  "devices",
  "device_bookings",
  "inventory_locations",
  "inventory_categories",
  "inventory_conditions",
  "inventory_availability_options",
  "school_inventory",
  "inventory_documents",
  "inventory_detail_fields",
  "inventory_detail_values",
  "info_folders",
  "information_files",
  "photo_folders",
  "photo_files",
  "photo_activity_logs",
  "kiosk_reward_rules",
  "kiosk_scan_logs",
  "qr_quizzes",
  "qr_quiz_questions",
  "qr_quiz_target_classes",
  "qr_quiz_responses",
  "qr_quiz_response_answers"
]);

let schedulerTimer = null;
let backupInProgress = false;
const DEFAULT_BACKUP_DAY_OF_WEEK = 6;
const DEFAULT_BACKUP_INTERVAL_DAYS = 2;
const DEFAULT_BACKUP_TIME = "15:00";
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getDefaultBackupSettings() {
  return {
    id: 1,
    auto_enabled: 1,
    backup_day_of_week: DEFAULT_BACKUP_DAY_OF_WEEK,
    backup_interval_days: DEFAULT_BACKUP_INTERVAL_DAYS,
    backup_time: DEFAULT_BACKUP_TIME,
    destination_path: DEFAULT_DESTINATION_PATH,
    last_run_at: null,
    last_status: "never",
    last_error: null,
    last_backup_path: null,
    updated_at: null,
    updated_by: null
  };
}

function getManagedBackupSettings(input = {}) {
  return {
    auto_enabled: 1,
    backup_day_of_week: DEFAULT_BACKUP_DAY_OF_WEEK,
    backup_interval_days: DEFAULT_BACKUP_INTERVAL_DAYS,
    backup_time: DEFAULT_BACKUP_TIME,
    destination_path: normalizeDestinationPath(input.destination_path || DEFAULT_DESTINATION_PATH),
    updated_by: input.updated_by ? Number(input.updated_by) : null
  };
}

function parseBooleanFlag(value) {
  return Number(value) === 1 ? 1 : 0;
}

function isValidBackupTime(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || "").trim());
}

function normalizeBackupDayOfWeek(value) {
  const day = Number(value);
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULT_BACKUP_DAY_OF_WEEK;
}

function normalizeBackupIntervalDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : DEFAULT_BACKUP_INTERVAL_DAYS;
}

function getBackupDayLabel(value) {
  return DAY_LABELS[normalizeBackupDayOfWeek(value)] || DAY_LABELS[DEFAULT_BACKUP_DAY_OF_WEEK];
}

function normalizeDestinationPath(input) {
  let raw = String(input || "").trim();
  if (!raw) return DEFAULT_DESTINATION_PATH;
  if (/^\/(?!\/)/.test(raw)) return raw.replace(/\/+$/g, "") || "/";
  return path.resolve(raw);
}

function isForeignPlatformPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return false;
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(raw)) return true;
  if (process.platform === "win32" && /^\/(?!\/)/.test(raw)) return true;
  return false;
}

function shouldMigrateDestinationPath(input) {
  const raw = String(input || "").trim();
  if (!raw || raw === LEGACY_DEFAULT_DESTINATION_PATH || isForeignPlatformPath(raw)) return true;
  const databaseIsPersistent = !isPathWithinRoot(PROJECT_ROOT, dbPath);
  return databaseIsPersistent && isPathWithinRoot(PROJECT_ROOT, normalizeDestinationPath(raw));
}

function writeSettingsFallback(settings) {
  try {
    fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
    fs.writeFileSync(
      SETTINGS_FALLBACK_PATH,
      JSON.stringify({
        auto_enabled: parseBooleanFlag(settings.auto_enabled),
        backup_day_of_week: normalizeBackupDayOfWeek(settings.backup_day_of_week),
        backup_interval_days: normalizeBackupIntervalDays(settings.backup_interval_days),
        backup_time: settings.backup_time,
        destination_path: settings.destination_path,
        last_run_at: settings.last_run_at || null,
        last_status: settings.last_status || "never",
        last_error: settings.last_error || null,
        last_backup_path: settings.last_backup_path || null,
        updated_at: settings.updated_at || null,
        updated_by: settings.updated_by || null
      }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.warn("Backup settings fallback write skipped:", error.message || error);
  }
}

function readSettingsFallback() {
  try {
    const canUseLegacyFallback = path.resolve(DATA_DIRECTORY) === path.resolve(PROJECT_ROOT);
    const fallbackPath = fs.existsSync(SETTINGS_FALLBACK_PATH)
      ? SETTINGS_FALLBACK_PATH
      : canUseLegacyFallback ? LEGACY_SETTINGS_FALLBACK_PATH : SETTINGS_FALLBACK_PATH;
    if (!fs.existsSync(fallbackPath)) return null;
    const payload = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function ensureSettingsRow() {
  const existing = db.prepare("SELECT * FROM backup_settings WHERE id = 1").get();
  if (existing) {
    const currentDestination = normalizeDestinationPath(existing.destination_path || DEFAULT_DESTINATION_PATH);
    const shouldMigrateDestination = shouldMigrateDestinationPath(existing.destination_path);
    const shouldMigrateTime = String(existing.backup_time || "").trim() !== DEFAULT_BACKUP_TIME;
    const shouldMigrateDay = normalizeBackupDayOfWeek(existing.backup_day_of_week) !== DEFAULT_BACKUP_DAY_OF_WEEK;
    const shouldMigrateInterval = normalizeBackupIntervalDays(existing.backup_interval_days) !== DEFAULT_BACKUP_INTERVAL_DAYS;
    if (shouldMigrateDestination || shouldMigrateTime || shouldMigrateDay || shouldMigrateInterval) {
      db.prepare(`
        UPDATE backup_settings
        SET backup_day_of_week = ?, backup_interval_days = ?, backup_time = ?, destination_path = ?
        WHERE id = 1
      `).run(
        DEFAULT_BACKUP_DAY_OF_WEEK,
        DEFAULT_BACKUP_INTERVAL_DAYS,
        DEFAULT_BACKUP_TIME,
        shouldMigrateDestination ? normalizeDestinationPath(DEFAULT_DESTINATION_PATH) : currentDestination
      );
      const updated = db.prepare("SELECT * FROM backup_settings WHERE id = 1").get();
      writeSettingsFallback(updated);
      return updated;
    }
    return existing;
  }

  const fallback = readSettingsFallback() || {};
  const defaults = getDefaultBackupSettings();
  const initial = {
    ...defaults,
    auto_enabled: parseBooleanFlag(fallback.auto_enabled == null ? defaults.auto_enabled : fallback.auto_enabled),
    backup_day_of_week: normalizeBackupDayOfWeek(fallback.backup_day_of_week),
    backup_interval_days: normalizeBackupIntervalDays(fallback.backup_interval_days),
    backup_time: isValidBackupTime(fallback.backup_time) ? fallback.backup_time : defaults.backup_time,
    destination_path: normalizeDestinationPath(fallback.destination_path || defaults.destination_path),
    last_run_at: fallback.last_run_at || defaults.last_run_at,
    last_status: fallback.last_status || defaults.last_status,
    last_error: fallback.last_error || defaults.last_error,
    last_backup_path: fallback.last_backup_path || defaults.last_backup_path,
    updated_at: fallback.updated_at || dayjs().toISOString(),
    updated_by: fallback.updated_by || null
  };

  db.prepare(`
    INSERT INTO backup_settings
      (id, auto_enabled, backup_day_of_week, backup_interval_days, backup_time, destination_path, last_run_at, last_status, last_error, last_backup_path, updated_at, updated_by)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    initial.id,
    initial.auto_enabled,
    initial.backup_day_of_week,
    initial.backup_interval_days,
    initial.backup_time,
    initial.destination_path,
    initial.last_run_at,
    initial.last_status,
    initial.last_error,
    initial.last_backup_path,
    initial.updated_at,
    initial.updated_by
  );

  writeSettingsFallback(initial);
  return db.prepare("SELECT * FROM backup_settings WHERE id = 1").get();
}

function getBackupSettings() {
  const row = ensureSettingsRow();
  return {
    ...getDefaultBackupSettings(),
    ...row,
    auto_enabled: parseBooleanFlag(row.auto_enabled),
    backup_day_of_week: normalizeBackupDayOfWeek(row.backup_day_of_week),
    backup_interval_days: normalizeBackupIntervalDays(row.backup_interval_days),
    backup_time: isValidBackupTime(row.backup_time) ? row.backup_time : DEFAULT_BACKUP_TIME,
    destination_path: normalizeDestinationPath(row.destination_path)
  };
}

function ensureWritableDirectory(destinationPath) {
  const resolvedPath = normalizeDestinationPath(destinationPath);
  try {
    fs.mkdirSync(resolvedPath, { recursive: true });
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Backup path must be a folder: ${resolvedPath}`);
    }

    const probePath = path.join(resolvedPath, `.backup-write-test-${Date.now()}.tmp`);
    fs.writeFileSync(probePath, "ok", "utf8");
    try {
      fs.unlinkSync(probePath);
    } catch (_) {
      // Some folders allow creating backup files but deny deleting test files immediately.
      // Successful write is enough to confirm the folder can receive new backup content.
    }
    return resolvedPath;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENODEV")) {
      throw new Error(`Backup folder not found: ${resolvedPath}`);
    }
    if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw new Error(`Permission denied for backup folder: ${resolvedPath}`);
    }
    throw new Error(error && error.message ? error.message : `Unable to use backup folder: ${resolvedPath}`);
  }
}

function updateBackupSettings(input) {
  const managed = getManagedBackupSettings(input);
  const autoEnabled = managed.auto_enabled;
  const backupDayOfWeek = normalizeBackupDayOfWeek(managed.backup_day_of_week);
  const backupIntervalDays = normalizeBackupIntervalDays(managed.backup_interval_days);
  const backupTime = managed.backup_time;
  const destinationPath = ensureWritableDirectory(managed.destination_path);
  const updatedAt = dayjs().toISOString();
  const updatedBy = managed.updated_by;

  db.prepare(`
    UPDATE backup_settings
    SET auto_enabled = ?, backup_day_of_week = ?, backup_interval_days = ?, backup_time = ?, destination_path = ?, updated_at = ?, updated_by = ?
    WHERE id = 1
  `).run(autoEnabled, backupDayOfWeek, backupIntervalDays, backupTime, destinationPath, updatedAt, updatedBy);

  const next = getBackupSettings();
  writeSettingsFallback(next);
  return next;
}

function isPathWithinRoot(rootPath, candidatePath) {
  const root = `${path.resolve(rootPath)}${path.sep}`;
  const candidate = path.resolve(candidatePath);
  return candidate === path.resolve(rootPath) || candidate.startsWith(root);
}

function listSavedBackups(destinationPath) {
  const resolvedRoot = ensureWritableDirectory(destinationPath);
  return fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry && entry.isDirectory())
    .map((entry) => {
      const backupPath = path.join(resolvedRoot, entry.name);
      const manifestPath = path.join(backupPath, "backup-manifest.json");
      let manifest = null;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (_) {
          manifest = null;
        }
      }
      const stats = fs.statSync(backupPath);
      return {
        name: entry.name,
        path: backupPath,
        created_at: (manifest && manifest.created_at) || stats.mtime.toISOString(),
        trigger_type: (manifest && manifest.trigger_type) || "",
        has_manifest: !!manifest,
        integrity_protection: manifest && Number(manifest.manifest_version) >= 2 && Array.isArray(manifest.files)
          ? "SHA-256 manifest"
          : "Legacy backup"
      };
    })
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function resolveSavedBackupPath(backupName, destinationPath) {
  const safeName = String(backupName || "").trim();
  if (!safeName || safeName.includes("/") || safeName.includes("\\") || safeName.includes("..")) {
    throw new Error("Invalid backup selected");
  }
  const resolvedRoot = ensureWritableDirectory(destinationPath);
  const backupPath = path.join(resolvedRoot, safeName);
  if (!isPathWithinRoot(resolvedRoot, backupPath)) {
    throw new Error("Invalid backup selected");
  }
  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) {
    throw new Error("Backup folder not found");
  }
  return backupPath;
}

function removeDirectoryRecursive(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let current = index;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) ? (0xEDB88320 ^ (current >>> 1)) : (current >>> 1);
    }
    table[index] = current >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

function calculateCrc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getZipDosDateParts(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | Math.floor((date.getSeconds() || 0) / 2);
  const dosDate = (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { dosTime, dosDate };
}

function collectDirectoryFiles(rootPath, currentPath = rootPath) {
  const files = [];
  fs.readdirSync(currentPath, { withFileTypes: true }).forEach((entry) => {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDirectoryFiles(rootPath, absolutePath));
      return;
    }
    if (!entry.isFile()) return;
    files.push({
      absolutePath,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/")
    });
  });
  return files;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function buildBackupFileInventory(rootPath) {
  return collectDirectoryFiles(rootPath)
    .filter((file) => file.relativePath !== "backup-manifest.json")
    .map((file) => {
      const data = fs.readFileSync(file.absolutePath);
      return { path: file.relativePath, size: data.length, sha256: sha256Buffer(data) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function verifySqliteDatabase(databasePath) {
  const checkDb = new Database(databasePath, { fileMustExist: true });
  try {
    checkDb.pragma("journal_mode = DELETE");
    const rows = checkDb.pragma("integrity_check");
    const messages = rows.map((row) => String(row.integrity_check || Object.values(row)[0] || ""));
    if (messages.length !== 1 || messages[0].toLowerCase() !== "ok") {
      throw new Error(`SQLite integrity check failed: ${messages.join("; ") || "unknown result"}`);
    }
    return "ok";
  } finally {
    checkDb.close();
  }
}

function validateManifestFiles(manifest, observedFiles) {
  const manifestVersion = Number(manifest && manifest.manifest_version || 0);
  if (!Array.isArray(manifest && manifest.files)) {
    if (manifestVersion >= 2) throw new Error("Backup manifest file inventory is missing");
    return false;
  }

  const expected = new Map();
  manifest.files.forEach((record) => {
    const entryName = normalizeArchiveEntryName(record && record.path);
    if (entryName === "backup-manifest.json" || expected.has(entryName)) {
      throw new Error("Backup manifest contains an invalid or duplicate file entry");
    }
    const size = Number(record.size);
    const sha256 = String(record.sha256 || "").toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Backup manifest metadata is invalid for ${entryName}`);
    }
    expected.set(entryName, { size, sha256 });
  });

  for (const [entryName, expectedFile] of expected) {
    const actual = observedFiles.get(entryName);
    if (!actual) throw new Error(`Backup ZIP is missing ${entryName}`);
    if (actual.size !== expectedFile.size || actual.sha256 !== expectedFile.sha256) {
      throw new Error(`Backup SHA-256 verification failed for ${entryName}`);
    }
  }
  for (const entryName of observedFiles.keys()) {
    if (entryName !== "backup-manifest.json" && !expected.has(entryName)) {
      throw new Error(`Backup ZIP contains an unlisted file: ${entryName}`);
    }
  }
  return true;
}

function validatePortableBackupIntegrity(payload, manifest, observedFiles) {
  const backupVersion = Number(payload && payload.meta && payload.meta.backup_version || 0);
  const manifestVersion = Number(manifest && manifest.manifest_version || 0);
  if (backupVersion >= 4 && manifestVersion < 2) {
    throw new Error("Backup integrity manifest is missing or outdated");
  }
  if (manifestVersion >= 2) {
    if (String(manifest.hash_algorithm || "").toUpperCase() !== "SHA-256") {
      throw new Error("Backup manifest uses an unsupported hash algorithm");
    }
    if (String(manifest.database_integrity || "").toLowerCase() !== "ok") {
      throw new Error("Backup database integrity was not verified");
    }
  }
  validateManifestFiles(manifest, observedFiles);
}

function createZipArchive(sourcePath, destinationZipPath) {
  const sourceStats = fs.statSync(sourcePath);
  if (!sourceStats.isDirectory()) {
    throw new Error("Backup source must be a folder");
  }

  const files = collectDirectoryFiles(sourcePath);
  const centralDirectoryRecords = [];
  let currentOffset = 0;
  const outputFd = fs.openSync(destinationZipPath, "w");

  try {
    files.forEach((file) => {
      const data = fs.readFileSync(file.absolutePath);
      const compressedData = zlib.deflateRawSync(data, { level: 9 });
      const stats = fs.statSync(file.absolutePath);
      const nameBuffer = Buffer.from(file.relativePath, "utf8");
      const { dosTime, dosDate } = getZipDosDateParts(stats.mtime);
      const crc32 = calculateCrc32(data);

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0, 6);
      localHeader.writeUInt16LE(8, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(crc32, 14);
      localHeader.writeUInt32LE(compressedData.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0, 8);
      centralHeader.writeUInt16LE(8, 10);
      centralHeader.writeUInt16LE(dosTime, 12);
      centralHeader.writeUInt16LE(dosDate, 14);
      centralHeader.writeUInt32LE(crc32, 16);
      centralHeader.writeUInt32LE(compressedData.length, 20);
      centralHeader.writeUInt32LE(data.length, 24);
      centralHeader.writeUInt16LE(nameBuffer.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(currentOffset, 42);

      fs.writeSync(outputFd, localHeader);
      fs.writeSync(outputFd, nameBuffer);
      fs.writeSync(outputFd, compressedData);
      centralDirectoryRecords.push(Buffer.concat([centralHeader, nameBuffer]));
      currentOffset += localHeader.length + nameBuffer.length + compressedData.length;
    });

    const centralDirectory = Buffer.concat(centralDirectoryRecords);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(files.length, 8);
    endRecord.writeUInt16LE(files.length, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(currentOffset, 16);
    endRecord.writeUInt16LE(0, 20);

    fs.writeSync(outputFd, centralDirectory);
    fs.writeSync(outputFd, endRecord);
  } finally {
    fs.closeSync(outputFd);
  }

  if (!fs.existsSync(destinationZipPath)) {
    throw new Error("Backup zip archive was not created");
  }
}

function normalizeArchiveEntryName(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error("Backup ZIP contains an invalid file path");
  }
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Backup ZIP contains an unsafe file path");
  }
  return parts.join("/");
}

function readPortableBackupArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error("Backup ZIP is empty or invalid");
  }

  const files = new Map();
  let offset = 0;
  let totalExpandedBytes = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > buffer.length) throw new Error("Backup ZIP has a truncated file header");
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const expandedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if ((flags & 0x08) !== 0) throw new Error("Backup ZIP uses unsupported streaming entries");
    if (method !== 0 && method !== 8) throw new Error("Backup ZIP uses an unsupported compression method");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("Backup ZIP contains truncated file data");
    const entryName = normalizeArchiveEntryName(buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : Buffer.from(compressed);
    if (data.length !== expandedSize || calculateCrc32(data) !== expectedCrc) {
      throw new Error(`Backup ZIP integrity check failed for ${entryName}`);
    }
    totalExpandedBytes += data.length;
    if (files.size >= 20000 || totalExpandedBytes > 2 * 1024 * 1024 * 1024) {
      throw new Error("Backup ZIP is too large to restore safely");
    }
    if (files.has(entryName)) throw new Error(`Backup ZIP contains a duplicate file: ${entryName}`);
    files.set(entryName, data);
    offset = dataEnd;
  }

  const snapshotBuffer = files.get("snapshot.json");
  const manifestBuffer = files.get("backup-manifest.json");
  if (!snapshotBuffer || !manifestBuffer) {
    throw new Error("Portable backup must contain snapshot.json and backup-manifest.json");
  }

  let payload;
  let manifest;
  try {
    payload = JSON.parse(snapshotBuffer.toString("utf8"));
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch (error) {
    throw new Error(`Backup ZIP metadata is invalid: ${error.message}`);
  }
  if (!ensureValidBackupPayload(payload) || manifest.app !== "srkupangcodex-school-app") {
    throw new Error("Backup ZIP is not a valid SR Kupang Portal backup");
  }
  const observedFiles = new Map();
  files.forEach((data, entryName) => observedFiles.set(entryName, { size: data.length, sha256: sha256Buffer(data) }));
  validatePortableBackupIntegrity(payload, manifest, observedFiles);

  const uploads = [];
  files.forEach((data, entryName) => {
    if (!entryName.startsWith("public/uploads/")) return;
    const relativePath = entryName.slice("public/uploads/".length);
    if (!relativePath) return;
    uploads.push({ relativePath, data });
  });
  return { payload, manifest, uploads };
}

function preparePublicUploadsRestore(uploadFiles) {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const publicRoot = path.dirname(PUBLIC_UPLOADS_DIR);
  const stagingPath = path.join(publicRoot, `.uploads-restore-${token}`);
  const rollbackPath = path.join(publicRoot, `.uploads-rollback-${token}`);
  fs.mkdirSync(stagingPath, { recursive: true });

  (uploadFiles || []).forEach((file) => {
    const relativePath = normalizeArchiveEntryName(file.relativePath);
    const targetPath = path.resolve(stagingPath, relativePath);
    if (!isPathWithinRoot(stagingPath, targetPath)) throw new Error("Backup ZIP contains an unsafe upload path");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, file.data);
  });

  let committed = false;
  return {
    commit() {
      try {
        if (fs.existsSync(PUBLIC_UPLOADS_DIR)) fs.renameSync(PUBLIC_UPLOADS_DIR, rollbackPath);
        fs.renameSync(stagingPath, PUBLIC_UPLOADS_DIR);
        committed = true;
        removeDirectoryRecursive(rollbackPath);
      } catch (error) {
        if (!fs.existsSync(PUBLIC_UPLOADS_DIR) && fs.existsSync(rollbackPath)) {
          fs.renameSync(rollbackPath, PUBLIC_UPLOADS_DIR);
        }
        throw error;
      }
    },
    cleanup() {
      if (!committed) removeDirectoryRecursive(stagingPath);
      removeDirectoryRecursive(rollbackPath);
    }
  };
}

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const count = fs.readSync(fd, buffer, total, length - total, position + total);
    if (!count) throw new Error("Backup ZIP contains truncated file data");
    total += count;
  }
  return buffer;
}

function removeSqliteSidecars(databasePath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecarPath = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecarPath)) fs.rmSync(sidecarPath, { force: true });
  }
}

function prepareDatabaseFileRestore(stagingPath, token) {
  const rollbackPath = path.join(DATA_DIRECTORY, `.database-rollback-${token}.db`);
  let committed = false;
  return {
    commit() {
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (_) {}
      closeDatabaseConnection();
      removeSqliteSidecars(dbPath);
      try {
        if (fs.existsSync(dbPath)) fs.renameSync(dbPath, rollbackPath);
        fs.renameSync(stagingPath, dbPath);
        reloadDatabaseConnection();
        committed = true;
      } catch (error) {
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
        if (fs.existsSync(rollbackPath)) fs.renameSync(rollbackPath, dbPath);
        reloadDatabaseConnection();
        throw error;
      }
    },
    rollback() {
      if (!committed) return;
      closeDatabaseConnection();
      removeSqliteSidecars(dbPath);
      if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
      if (fs.existsSync(rollbackPath)) fs.renameSync(rollbackPath, dbPath);
      reloadDatabaseConnection();
      committed = false;
    },
    finalize() {
      removeDirectoryRecursive(rollbackPath);
      removeDirectoryRecursive(stagingPath);
    },
    cleanup() {
      if (!committed) removeDirectoryRecursive(stagingPath);
    }
  };
}

function preparePortableBackupArchiveRestore(zipFilePath) {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const publicRoot = path.dirname(PUBLIC_UPLOADS_DIR);
  const stagingPath = path.join(publicRoot, `.uploads-restore-${token}`);
  const databaseStagingPath = path.join(DATA_DIRECTORY, `.database-restore-${token}.db`);
  fs.mkdirSync(stagingPath, { recursive: true });
  const fd = fs.openSync(zipFilePath, "r");
  let offset = 0;
  let entryCount = 0;
  let totalExpandedBytes = 0;
  let snapshotBuffer = null;
  let manifestBuffer = null;
  const observedFiles = new Map();

  try {
    const archiveSize = fs.fstatSync(fd).size;
    while (offset + 4 <= archiveSize) {
      const signature = readExact(fd, 4, offset).readUInt32LE(0);
      if (signature !== 0x04034b50) break;
      const header = readExact(fd, 30, offset);
      const flags = header.readUInt16LE(6);
      const method = header.readUInt16LE(8);
      const expectedCrc = header.readUInt32LE(14);
      const compressedSize = header.readUInt32LE(18);
      const expandedSize = header.readUInt32LE(22);
      const nameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      if ((flags & 0x08) !== 0) throw new Error("Backup ZIP uses unsupported streaming entries");
      if (method !== 0 && method !== 8) throw new Error("Backup ZIP uses an unsupported compression method");
      const nameStart = offset + 30;
      const dataStart = nameStart + nameLength + extraLength;
      if (dataStart + compressedSize > archiveSize) throw new Error("Backup ZIP contains truncated file data");
      const entryName = normalizeArchiveEntryName(readExact(fd, nameLength, nameStart).toString("utf8"));
      const compressed = readExact(fd, compressedSize, dataStart);
      const data = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
      if (data.length !== expandedSize || calculateCrc32(data) !== expectedCrc) {
        throw new Error(`Backup ZIP integrity check failed for ${entryName}`);
      }
      entryCount += 1;
      totalExpandedBytes += data.length;
      if (entryCount > 20000 || totalExpandedBytes > 2 * 1024 * 1024 * 1024) {
        throw new Error("Backup ZIP is too large to restore safely");
      }
      if (observedFiles.has(entryName)) throw new Error(`Backup ZIP contains a duplicate file: ${entryName}`);
      observedFiles.set(entryName, { size: data.length, sha256: sha256Buffer(data) });
      if (entryName === "snapshot.json") snapshotBuffer = data;
      if (entryName === "backup-manifest.json") manifestBuffer = data;
      if (entryName === "data/data.db") fs.writeFileSync(databaseStagingPath, data);
      if (entryName.startsWith("public/uploads/")) {
        const relativePath = entryName.slice("public/uploads/".length);
        if (relativePath) {
          const targetPath = path.resolve(stagingPath, normalizeArchiveEntryName(relativePath));
          if (!isPathWithinRoot(stagingPath, targetPath)) throw new Error("Backup ZIP contains an unsafe upload path");
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, data);
        }
      }
      offset = dataStart + compressedSize;
    }
  } catch (error) {
    removeDirectoryRecursive(stagingPath);
    removeDirectoryRecursive(databaseStagingPath);
    throw error;
  } finally {
    fs.closeSync(fd);
  }

  if (!snapshotBuffer || !manifestBuffer) {
    removeDirectoryRecursive(stagingPath);
    removeDirectoryRecursive(databaseStagingPath);
    throw new Error("Portable backup must contain snapshot.json and backup-manifest.json");
  }
  let payload;
  let manifest;
  try {
    payload = JSON.parse(snapshotBuffer.toString("utf8"));
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch (error) {
    removeDirectoryRecursive(stagingPath);
    removeDirectoryRecursive(databaseStagingPath);
    throw new Error(`Backup ZIP metadata is invalid: ${error.message}`);
  }
  if (!ensureValidBackupPayload(payload) || manifest.app !== "srkupangcodex-school-app") {
    removeDirectoryRecursive(stagingPath);
    removeDirectoryRecursive(databaseStagingPath);
    throw new Error("Backup ZIP is not a valid SR Kupang Portal backup");
  }
  try {
    validatePortableBackupIntegrity(payload, manifest, observedFiles);
  } catch (error) {
    removeDirectoryRecursive(stagingPath);
    removeDirectoryRecursive(databaseStagingPath);
    throw error;
  }
  if (!fs.existsSync(databaseStagingPath)) {
    removeDirectoryRecursive(stagingPath);
    throw new Error("Portable backup does not contain data/data.db");
  }
  try {
    verifySqliteDatabase(databaseStagingPath);
  } catch (error) {
    removeDirectoryRecursive(stagingPath);
    removeDirectoryRecursive(databaseStagingPath);
    throw error;
  }

  const rollbackPath = path.join(publicRoot, `.uploads-rollback-${token}`);
  let committed = false;
  return {
    payload,
    manifest,
    uploadsRestore: {
      commit() {
        try {
          if (fs.existsSync(PUBLIC_UPLOADS_DIR)) fs.renameSync(PUBLIC_UPLOADS_DIR, rollbackPath);
          fs.renameSync(stagingPath, PUBLIC_UPLOADS_DIR);
          committed = true;
        } catch (error) {
          if (!fs.existsSync(PUBLIC_UPLOADS_DIR) && fs.existsSync(rollbackPath)) fs.renameSync(rollbackPath, PUBLIC_UPLOADS_DIR);
          throw error;
        }
      },
      rollback() {
        if (!committed) return;
        removeDirectoryRecursive(PUBLIC_UPLOADS_DIR);
        if (fs.existsSync(rollbackPath)) fs.renameSync(rollbackPath, PUBLIC_UPLOADS_DIR);
        committed = false;
      },
      finalize() {
        removeDirectoryRecursive(rollbackPath);
        removeDirectoryRecursive(stagingPath);
      },
      cleanup() {
        if (!committed) removeDirectoryRecursive(stagingPath);
      }
    },
    databaseRestore: prepareDatabaseFileRestore(databaseStagingPath, token)
  };
}

function updateLastBackupState(payload) {
  const settings = getBackupSettings();
  const nextState = {
    ...settings,
    last_run_at: payload.last_run_at || settings.last_run_at,
    last_status: payload.last_status || settings.last_status,
    last_error: payload.last_error == null ? null : String(payload.last_error),
    last_backup_path: payload.last_backup_path || null
  };

  db.prepare(`
    UPDATE backup_settings
    SET last_run_at = ?, last_status = ?, last_error = ?, last_backup_path = ?
    WHERE id = 1
  `).run(nextState.last_run_at, nextState.last_status, nextState.last_error, nextState.last_backup_path);

  writeSettingsFallback({
    ...settings,
    ...nextState
  });
}

function logBackupHistory(entry) {
  db.prepare(`
    INSERT INTO backup_history
      (trigger_type, status, backup_name, backup_path, started_at, finished_at, error_message)
    VALUES
      (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.trigger_type,
    entry.status,
    entry.backup_name || null,
    entry.backup_path || null,
    entry.started_at,
    entry.finished_at || null,
    entry.error_message || null
  );
}

function getBackupHistory(limit = 10) {
  return db.prepare(`
    SELECT id, trigger_type, status, backup_name, backup_path, started_at, finished_at, error_message
    FROM backup_history
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(Number(limit) || 10);
}

function getLatestBackupRecord() {
  return db.prepare(`
    SELECT id, trigger_type, status, backup_name, backup_path, started_at, finished_at, error_message
    FROM backup_history
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `).get() || null;
}

function getLatestAutoBackupRecord() {
  return db.prepare(`
    SELECT id, trigger_type, status, backup_name, backup_path, started_at, finished_at, error_message
    FROM backup_history
    WHERE trigger_type = 'auto'
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `).get() || null;
}

function applyBackupTime(base, settings) {
  const time = String(settings.backup_time || DEFAULT_BACKUP_TIME).split(":");
  return base
    .hour(Number(time[0] || 15))
    .minute(Number(time[1] || 0))
    .second(0)
    .millisecond(0);
}

function getNextBackupAt(settings, now = dayjs()) {
  if (!settings || !parseBooleanFlag(settings.auto_enabled)) return null;
  const intervalDays = normalizeBackupIntervalDays(settings.backup_interval_days);
  const latestAuto = getLatestAutoBackupRecord();
  let next = latestAuto && latestAuto.started_at
    ? applyBackupTime(dayjs(latestAuto.started_at).add(intervalDays, "day"), settings)
    : applyBackupTime(now, settings);
  while (!next.isAfter(now)) {
    next = next.add(intervalDays, "day");
  }
  return next;
}

function describeAutoBackupState(settings) {
  if (!settings.auto_enabled) {
    return {
      message: "Automatic backup is disabled.",
      next_backup_at: null,
      warning: null
    };
  }

  const nextBackup = getNextBackupAt(settings);
  let warning = null;
  try {
    ensureWritableDirectory(settings.destination_path);
  } catch (error) {
    warning = `Backup folder issue: ${error.message}`;
  }

  return {
    message: `Automatic backup is enabled every ${normalizeBackupIntervalDays(settings.backup_interval_days)} days at ${settings.backup_time || DEFAULT_BACKUP_TIME}. Next backup: ${nextBackup ? nextBackup.format("DD MMM YYYY hh:mm A") : "Not scheduled"}.`,
    next_backup_at: nextBackup ? nextBackup.toISOString() : null,
    warning
  };
}

function makeBackupSnapshot() {
  const data = {};
  for (const [table, columns] of Object.entries(BACKUP_TABLES)) {
    const orderBy = columns.includes("id") ? "id ASC" : columns.map((column) => `${column} ASC`).join(", ");
    const sql = `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`;
    data[table] = db.prepare(sql).all();
  }

  return {
    meta: {
      app: "srkupangcodex-school-app",
      backup_version: 4,
      created_at: dayjs().toISOString()
    },
    data
  };
}

function ensureValidBackupPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!payload.data || typeof payload.data !== "object") return false;
  return Object.keys(BACKUP_TABLES).every((table) => Array.isArray(payload.data[table]) || OPTIONAL_BACKUP_TABLES.has(table));
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.readdirSync(sourceDir, { withFileTypes: true }).forEach((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
      return;
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  });
}

function buildBackupFolderPath(destinationRoot, baseName) {
  let targetPath = path.join(destinationRoot, baseName);
  let suffix = 1;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(destinationRoot, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return targetPath;
}

async function runBackup(options = {}) {
  if (backupInProgress) {
    throw new Error("Another backup is already running");
  }

  backupInProgress = true;
  const triggerType = options.trigger_type === "auto" ? "auto" : "manual";
  const startedAt = dayjs().toISOString();
  const settings = getBackupSettings();

  let targetPath = null;
  let backupName = null;
  try {
    const destinationRoot = ensureWritableDirectory(options.destination_path || settings.destination_path);
    backupName = `backup-${dayjs().format("YYYY-MM-DD-HHmm")}`;
    targetPath = buildBackupFolderPath(destinationRoot, backupName);

    fs.mkdirSync(targetPath, { recursive: true });
    fs.mkdirSync(path.join(targetPath, "data"), { recursive: true });

    const databaseBackupPath = path.join(targetPath, "data", "data.db");
    await db.backup(databaseBackupPath);
    const databaseIntegrity = verifySqliteDatabase(databaseBackupPath);

    const snapshot = makeBackupSnapshot();
    fs.writeFileSync(path.join(targetPath, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");

    if (options.include_uploads !== false && fs.existsSync(PUBLIC_UPLOADS_DIR)) {
      copyDirectoryRecursive(PUBLIC_UPLOADS_DIR, path.join(targetPath, "public", "uploads"));
    }

    fs.writeFileSync(
      path.join(targetPath, "RESTORE-INSTRUCTIONS.txt"),
      [
        "SR Kupang Portal portable backup",
        "",
        "On a replacement portal server:",
        "1. Sign in as an administrator.",
        "2. Open Admin Dashboard > Backup and Restore.",
        "3. Upload this ZIP under Restore Portable Backup.",
        "4. Confirm the restore. You will be signed out when it completes.",
        "",
        "The ZIP contains the database snapshot and managed files from public/uploads."
      ].join("\r\n"),
      "utf8"
    );
    const files = buildBackupFileInventory(targetPath);
    fs.writeFileSync(
      path.join(targetPath, "backup-manifest.json"),
      JSON.stringify({
        app: "srkupangcodex-school-app",
        manifest_version: 2,
        backup_version: snapshot.meta.backup_version,
        created_at: startedAt,
        trigger_type: triggerType,
        destination_root: destinationRoot,
        backup_name: backupName,
        database_integrity: databaseIntegrity,
        hash_algorithm: "SHA-256",
        files
      }, null, 2),
      "utf8"
    );

    const finishedAt = dayjs().toISOString();
    updateLastBackupState({
      last_run_at: finishedAt,
      last_status: "success",
      last_error: null,
      last_backup_path: targetPath
    });
    logBackupHistory({
      trigger_type: triggerType,
      status: "success",
      backup_name: backupName,
      backup_path: targetPath,
      started_at: startedAt,
      finished_at: finishedAt,
      error_message: null
    });

    return {
      trigger_type: triggerType,
      status: "success",
      backup_name: backupName,
      backup_path: targetPath,
      started_at: startedAt,
      finished_at: finishedAt
    };
  } catch (error) {
    const finishedAt = dayjs().toISOString();
    updateLastBackupState({
      last_run_at: finishedAt,
      last_status: "failed",
      last_error: error.message || String(error),
      last_backup_path: targetPath
    });
    logBackupHistory({
      trigger_type: triggerType,
      status: "failed",
      backup_name: backupName,
      backup_path: targetPath,
      started_at: startedAt,
      finished_at: finishedAt,
      error_message: error.message || String(error)
    });
    throw error;
  } finally {
    backupInProgress = false;
  }
}

async function createManualBackupDownload() {
  const settings = getBackupSettings();
  const backupResult = await runBackup({ trigger_type: "manual", destination_path: settings.destination_path });
  const zipFileName = `${backupResult.backup_name}.zip`;
  const zipFilePath = path.join(os.tmpdir(), zipFileName);

  if (fs.existsSync(zipFilePath)) {
    try { fs.unlinkSync(zipFilePath); } catch (_) {}
  }

  createZipArchive(backupResult.backup_path, zipFilePath);

  return {
    ...backupResult,
    zip_file_name: zipFileName,
    zip_file_path: zipFilePath
  };
}

function createSavedBackupDownload(backupName, destinationPath) {
  const backupPath = resolveSavedBackupPath(backupName, destinationPath);
  const zipFileName = `${path.basename(backupPath)}.zip`;
  const zipFilePath = path.join(os.tmpdir(), zipFileName);

  if (fs.existsSync(zipFilePath)) {
    try { fs.unlinkSync(zipFilePath); } catch (_) {}
  }

  createZipArchive(backupPath, zipFilePath);

  return {
    backup_name: path.basename(backupPath),
    backup_path: backupPath,
    zip_file_name: zipFileName,
    zip_file_path: zipFilePath
  };
}

function deleteSavedBackup(backupName, destinationPath) {
  const backupPath = resolveSavedBackupPath(backupName, destinationPath);
  removeDirectoryRecursive(backupPath);
  return {
    backup_name: path.basename(backupPath),
    backup_path: backupPath
  };
}

function getBackupDashboardData() {
  const settings = getBackupSettings();
  let savedBackups = [];
  try {
    savedBackups = listSavedBackups(settings.destination_path);
  } catch (_) {
    savedBackups = [];
  }
  return {
    settings,
    status: describeAutoBackupState(settings),
    latest: getLatestBackupRecord(),
    history: getBackupHistory(12),
    savedBackups,
    running: backupInProgress
  };
}

async function checkAutomaticBackup() {
  if (backupInProgress || getMaintenanceState()) return;
  const settings = getBackupSettings();
  if (!settings.auto_enabled) return;

  const now = dayjs();
  const latestAuto = getLatestAutoBackupRecord();
  const intervalDays = normalizeBackupIntervalDays(settings.backup_interval_days);
  const dueAt = latestAuto && latestAuto.started_at
    ? applyBackupTime(dayjs(latestAuto.started_at).add(intervalDays, "day"), settings)
    : applyBackupTime(now, settings);
  if (now.isBefore(dueAt)) return;

  const todayKey = now.format("YYYY-MM-DD");
  const existingToday = db.prepare(`
    SELECT id
    FROM backup_history
    WHERE trigger_type = 'auto' AND substr(started_at, 1, 10) = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(todayKey);
  if (existingToday) return;

  try {
    await runBackup({ trigger_type: "auto" });
  } catch (error) {
    console.error("Automatic backup failed:", error.message || error);
  }
}

function initializeBackupScheduler() {
  ensureSettingsRow();
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
  }
  schedulerTimer = setInterval(() => {
    checkAutomaticBackup().catch((error) => {
      console.error("Backup scheduler error:", error.message || error);
    });
  }, 30000);

  setTimeout(() => {
    checkAutomaticBackup().catch((error) => {
      console.error("Initial backup scheduler check failed:", error.message || error);
    });
  }, 1500);
}

module.exports = {
  BACKUP_TABLES,
  OPTIONAL_BACKUP_TABLES,
  DEFAULT_DESTINATION_PATH,
  createManualBackupDownload,
  createZipArchive,
  createSavedBackupDownload,
  deleteSavedBackup,
  ensureValidBackupPayload,
  getBackupDayLabel,
  getBackupDashboardData,
  getBackupHistory,
  getBackupSettings,
  initializeBackupScheduler,
  isValidBackupTime,
  makeBackupSnapshot,
  preparePublicUploadsRestore,
  preparePortableBackupArchiveRestore,
  readPortableBackupArchive,
  runBackup,
  updateBackupSettings
};
