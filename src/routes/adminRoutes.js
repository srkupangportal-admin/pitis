const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const dayjs = require("dayjs");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");
const {
  BACKUP_TABLES,
  DEFAULT_DESTINATION_PATH,
  createManualBackupDownload,
  createSavedBackupDownload,
  deleteSavedBackup,
  ensureValidBackupPayload,
  getBackupDashboardData,
  makeBackupSnapshot,
  preparePortableBackupArchiveRestore,
  runBackup,
  updateBackupSettings
} = require("../services/backupService");
const {
  STUDENT_TEMPLATE_COLUMNS,
  STUDENT_CORE_FIELD_KEYS,
  STUDENT_FORM_GROUPS,
  createStudentQrToken,
  csvEscape,
  normalizeClassName,
  normalizeDateValue,
  normalizeGender,
  normalizeOptionalText
} = require("../services/studentSchema");
const {
  buildStudentQrPayload,
  buildUserQrPayload,
  generateDeviceQrDataUrl,
  generateStudentQrDataUrl,
  generateUserQrDataUrl
} = require("../services/qrCodeService");
const { getUserLoginReportRows } = require("../services/userLoginLogService");
const {
  getLeaderboardSlideshowDurationMs,
  setLeaderboardSlideshowDurationSeconds
} = require("../services/portalSettingsService");
const { getPhotoActivityReportRows } = require("../services/photoActivityLogService");
const { getAdminAuditRows } = require("../services/adminAuditService");
const { getAdminCommandCentre } = require("../services/adminCommandCentreService");
const {
  applyAcademicYearRollover,
  getRolloverPreview,
  normalizeYear
} = require("../services/academicYearRolloverService");
const {
  getSchoolCalendarDashboard,
  getSchoolCalendarFilters,
  updateSchoolCalendarDay
} = require("../services/schoolCalendarService");

const router = express.Router();
const uploadMemory = multer({ storage: multer.memoryStorage() });
const uploadRestore = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, os.tmpdir()),
    filename: (_req, _file, callback) => callback(null, `srkupang-restore-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.upload`)
  }),
  limits: { files: 1, fileSize: 2 * 1024 * 1024 * 1024 }
});
const ADMIN_DEVICE_STATUSES = ["available", "maintenance", "unavailable", "inactive"];

function normalizeCalendarHexColor(input, fallback = "#3f6fae") {
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

function parseCalendarLabelIds(raw) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return Array.from(new Set(
    values
      .flatMap((value) => String(value).split(","))
      .map((value) => Number(String(value).trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
  ));
}

function parseCalendarLabelsRaw(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  return text.split("||").map((chunk) => {
    const [id, name, color, description] = chunk.split("::");
    if (!id || !name) return null;
    return {
      id: Number(id),
      name,
      color: normalizeCalendarHexColor(color, "#3f6fae"),
      description: description || ""
    };
  }).filter(Boolean);
}

function listCalendarLabelsForAdmin() {
  return db.prepare(`
    SELECT id, name, color, COALESCE(description, '') AS description, is_system
    FROM calendar_labels
    ORDER BY is_system DESC, name ASC
  `).all().map((label) => ({
    ...label,
    color: normalizeCalendarHexColor(label.color, "#3f6fae")
  }));
}

function assignCalendarEventLabels(eventId, labelIds) {
  const ids = Array.from(new Set((labelIds || []).filter((value) => Number.isInteger(value) && value > 0)));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM calendar_event_labels WHERE event_id = ?").run(eventId);
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    const validIds = db.prepare(`SELECT id FROM calendar_labels WHERE id IN (${placeholders})`).all(...ids).map((row) => Number(row.id));
    const insert = db.prepare("INSERT INTO calendar_event_labels (event_id, label_id) VALUES (?, ?)");
    validIds.forEach((labelId) => insert.run(eventId, labelId));
  });
  tx();
}

const STUDENT_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "students");
if (!fs.existsSync(STUDENT_UPLOAD_DIR)) {
  fs.mkdirSync(STUDENT_UPLOAD_DIR, { recursive: true });
}

const INFORMATION_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "informations");
if (!fs.existsSync(INFORMATION_UPLOAD_DIR)) {
  fs.mkdirSync(INFORMATION_UPLOAD_DIR, { recursive: true });
}

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STUDENT_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeId = String(req.body.student_id || "student").replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${safeId}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
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

const STUDENT_PHOTO_UPLOAD_FIELDS = [
  { name: "photo_file", maxCount: 1 },
  { name: "photo_2_file", maxCount: 1 },
  { name: "photo_3_file", maxCount: 1 },
  { name: "photo_4_file", maxCount: 1 },
  { name: "photo_5_file", maxCount: 1 },
  { name: "photo_6_file", maxCount: 1 }
];

const informationStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, INFORMATION_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".pdf";
    const base = path.basename(file.originalname || "information", ext).replace(/[^a-zA-Z0-9_-]/g, "_") || "information";
    cb(null, `${base}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const informationUpload = multer({
  storage: informationStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if ((file.mimetype || "").includes("pdf") || ext === ".pdf") return cb(null, true);
    return cb(new Error("Only PDF files are allowed"));
  }
});

function normalizePhotoPath(file) {
  if (!file) return "";
  const rel = path.join("uploads", "students", file.filename).replace(/\\/g, "/");
  return `/${rel}`;
}

function removeManagedPhotoIfExists(photoPath) {
  const rel = String(photoPath || "").trim();
  if (!rel || !rel.startsWith("/uploads/students/")) return;
  const abs = path.join(__dirname, "..", "..", "public", rel.replace(/^\//, ""));
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (_) {}
  }
}

function formatStudentExportDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format("DD/MM/YYYY") : raw;
}

function formatCheckboxStatus(value) {
  return Number(value) === 1 ? "Checked" : "";
}

function sanitizeFilenameSegment(value, fallback = "all") {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBuffer = Buffer.from(String(file.name || "").replace(/\\/g, "/"), "utf8");
    const dataBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "");
    const checksum = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

async function buildStudentQrZipFiles(rows, scope) {
  return Promise.all(rows.map(async (row) => {
    const qrDataUrl = await generateStudentQrDataUrl(row);
    const fileBase64 = String(qrDataUrl || "").replace(/^data:image\/png;base64,/, "");
    const fileData = Buffer.from(fileBase64, "base64");
    const classSegment = sanitizeFilenameSegment(normalizeClassName(row.class_name), "class");
    const studentSegment = sanitizeFilenameSegment(`${row.name || row.full_name}-${row.student_id}`, `student-${row.id}`);
    const fileName = scope === "school"
      ? `${classSegment}/${studentSegment}.png`
      : `${studentSegment}.png`;
    return {
      name: fileName,
      data: fileData
    };
  }));
}

function normalizeTimeValue(value) {
  const raw = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(raw) ? raw : "";
}

function resolveAdminInformationFolder(existingFolderRaw, newFolderRaw) {
  const existingFolderId = Number(String(existingFolderRaw || "").trim() || 0);
  const newFolderName = String(newFolderRaw || "").trim();

  if (newFolderName) {
    const existing = db.prepare("SELECT id, name FROM info_folders WHERE LOWER(name) = LOWER(?)").get(newFolderName);
    if (existing && existing.id) {
      return { folderId: Number(existing.id), folderName: String(existing.name || "").trim() || newFolderName };
    }

    const folderId = Number(
      db.prepare("INSERT INTO info_folders (name, created_at) VALUES (?, ?)").run(newFolderName, dayjs().toISOString()).lastInsertRowid
    );
    return { folderId, folderName: newFolderName };
  }

  if (!existingFolderId) {
    throw new Error("Please choose an existing folder or enter a new folder name");
  }

  const folder = db.prepare("SELECT id, name FROM info_folders WHERE id = ?").get(existingFolderId);
  if (!folder || !folder.id) {
    throw new Error("Selected folder is invalid");
  }

  return { folderId: Number(folder.id), folderName: String(folder.name || "").trim() || `Folder ${existingFolderId}` };
}

router.use(requireRole("admin"));

const restoreTableInfoCache = new Map();

function getRestoreTableInfo(table) {
  if (!restoreTableInfoCache.has(table)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    restoreTableInfoCache.set(table, new Map(columns.map((column) => [column.name, column])));
  }
  return restoreTableInfoCache.get(table);
}

function getRestoreFallbackValue(table, column, row) {
  if (table === "students" && column === "name") {
    return {
      hasValue: true,
      value: normalizeOptionalText(row.nickname) || normalizeOptionalText(row.full_name) || normalizeOptionalText(row.student_id) || "Student"
    };
  }
  if (table === "students" && column === "full_name") {
    return {
      hasValue: true,
      value: normalizeOptionalText(row.full_name) || normalizeOptionalText(row.name) || normalizeOptionalText(row.nickname) || "Student"
    };
  }
  if (table === "students" && column === "student_id") {
    return {
      hasValue: true,
      value: normalizeOptionalText(row.student_id) || normalizeOptionalText(row.student_code) || `STU${String(row.id || Date.now()).padStart(4, "0")}`
    };
  }
  if (table === "students" && column === "level") return { hasValue: true, value: normalizeOptionalText(row.level) || normalizeOptionalText(row.tahun) };
  if (table === "students" && column === "alamat") {
    return { hasValue: true, value: normalizeOptionalText(row.alamat) || normalizeOptionalText(row.address) || normalizeOptionalText(row.alamat_rumah) };
  }
  if (table === "students" && column === "no_bruhims") return { hasValue: true, value: normalizeOptionalText(row.no_bruhims) || normalizeOptionalText(row.bruhims) };
  if (table === "students" && column === "ugama") return { hasValue: true, value: normalizeOptionalText(row.ugama) || normalizeOptionalText(row.agama) };
  if (table === "calendar_events" && column === "event_source") return { hasValue: true, value: "manual" };
  if (table === "calendar_events" && column === "is_deleted") return { hasValue: true, value: 0 };
  if (table === "point_reasons" && column === "reason_type") return { hasValue: true, value: "positive" };
  if (table === "point_reasons" && column === "is_custom") return { hasValue: true, value: 0 };
  if (table === "users" && column === "is_active") return { hasValue: true, value: 1 };
  if (table === "users" && column === "user_type") {
    return { hasValue: true, value: row.role === "admin" ? "admin" : row.role === "staff" ? "staff" : "teacher" };
  }
  if (table === "qr_quiz_target_classes" && column === "class_name" && row.class_id) {
    const cls = db.prepare("SELECT name FROM classes WHERE id = ?").get(row.class_id);
    return { hasValue: true, value: cls ? cls.name : null };
  }
  if (table === "students" && column === "qr_token") return { hasValue: true, value: createStudentQrToken() };
  if (table === "school_inventory" && column === "token") {
    return { hasValue: true, value: crypto.randomBytes(18).toString("base64url") };
  }
  if (table === "school_inventory" && column === "is_bookable") return { hasValue: true, value: 0 };
  return { hasValue: false, value: null };
}

function insertRows(table, columns, rows) {
  if (!rows.length) return;
  const tableInfo = getRestoreTableInfo(table);
  const statements = new Map();

  for (const row of rows) {
    const insertColumns = [];
    const values = [];

    columns.forEach((column) => {
      if (Object.prototype.hasOwnProperty.call(row, column)) {
        insertColumns.push(column);
        values.push(row[column]);
        return;
      }

      const fallback = getRestoreFallbackValue(table, column, row);
      if (fallback.hasValue) {
        insertColumns.push(column);
        values.push(fallback.value);
        return;
      }

      const info = tableInfo.get(column);
      if (info && info.dflt_value != null) return;

      insertColumns.push(column);
      values.push(null);
    });

    const statementKey = insertColumns.join("|");
    if (!statements.has(statementKey)) {
      const placeholders = insertColumns.map(() => "?").join(", ");
      statements.set(statementKey, db.prepare(`INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${placeholders})`));
    }
    statements.get(statementKey).run(...values);
  }
}

function assertNoRestoreForeignKeyViolations() {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (!violations.length) return;
  const sample = violations.slice(0, 5).map((violation) => (
    `${violation.table} row ${violation.rowid} references missing ${violation.parent}`
  )).join("; ");
  throw new Error(`Backup restored with broken references: ${sample}`);
}

function seedInventoryOptionsIfEmpty(table, values) {
  const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  if (count && count.count > 0) return;
  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO ${table} (name, is_active, created_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(name) DO NOTHING
  `);
  values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .forEach((value) => insert.run(value, now, now));
}

function ensureInventoryOptionsAfterRestore() {
  seedInventoryOptionsIfEmpty("inventory_categories", [
    "Teaching Aid",
    "ICT",
    "Furniture",
    "Sports",
    "Stationery",
    ...db.prepare("SELECT DISTINCT category AS name FROM school_inventory WHERE TRIM(category) <> ''").all().map((row) => row.name)
  ]);
  seedInventoryOptionsIfEmpty("inventory_locations", [
    "Resource Room",
    "Device Hub",
    "Library",
    "Office",
    ...db.prepare("SELECT DISTINCT location AS name FROM school_inventory WHERE TRIM(location) <> ''").all().map((row) => row.name)
  ]);
  seedInventoryOptionsIfEmpty("inventory_conditions", [
    "new",
    "good",
    "fair",
    "needs repair",
    ...db.prepare("SELECT DISTINCT item_condition AS name FROM school_inventory WHERE TRIM(item_condition) <> ''").all().map((row) => row.name)
  ]);
  seedInventoryOptionsIfEmpty("inventory_availability_options", [
    "available",
    "in_use",
    "maintenance",
    "unavailable",
    "inactive",
    ...db.prepare("SELECT DISTINCT status AS name FROM school_inventory WHERE TRIM(status) <> ''").all().map((row) => row.name)
  ]);
}

function ensureInventoryDetailFieldsAfterRestore() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM inventory_detail_fields").get();
  if (count && count.count > 0) return;
  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO inventory_detail_fields (field_key, label, field_type, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
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
    insert.run(key, label, fieldType, (index + 1) * 10, now, now);
  });
}

function ensureCatatanHarianChecklistAfterRestore() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM catatan_harian_checklist_items").get();
  if (count && count.count > 0) return;
  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO catatan_harian_checklist_items (category, item_text, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
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
  ].forEach((item) => insert.run(item[0], item[1], now, now));
}

function syncFamilyLinks(studentPk, familyId, now, linkSibling, findByFamily) {
  const fam = String(familyId || "").trim();
  if (!fam) return;

  const members = findByFamily.all(fam);
  for (const member of members) {
    if (!member || Number(member.id) === Number(studentPk)) continue;
    linkSibling.run(studentPk, member.id, now);
    linkSibling.run(member.id, studentPk, now);
  }
}

function buildStudentBaseValues(body, classId) {
  return {
    class_id: classId,
    name: normalizeOptionalText(body.name),
    full_name: normalizeOptionalText(body.full_name),
    student_id: normalizeOptionalText(body.student_id),
    no_sb: normalizeOptionalText(body.no_sb),
    no_bruhims: normalizeOptionalText(body.no_bruhims),
    bangsa: normalizeOptionalText(body.bangsa),
    ugama: normalizeOptionalText(body.ugama),
    kerakyatan: normalizeOptionalText(body.kerakyatan),
    gender: normalizeGender(body.gender),
    dob: normalizeDateValue(body.dob),
    age: normalizeOptionalText(body.age),
    level: normalizeOptionalText(body.level),
    notes: normalizeOptionalText(body.notes),
    emergency_contact: normalizeOptionalText(body.emergency_contact) || "-",
    email: normalizeOptionalText(body.email),
    alamat: normalizeOptionalText(body.alamat),
    nama_ayah: normalizeOptionalText(body.nama_ayah),
    pekerjaan_ayah: normalizeOptionalText(body.pekerjaan_ayah),
    dob_ayah: normalizeDateValue(body.dob_ayah),
    taraf_ayah: normalizeOptionalText(body.taraf_ayah),
    no_telefon_ayah: normalizeOptionalText(body.no_telefon_ayah),
    bangsa_ayah: normalizeOptionalText(body.bangsa_ayah),
    ugama_ayah: normalizeOptionalText(body.ugama_ayah),
    kerakyatan_ayah: normalizeOptionalText(body.kerakyatan_ayah),
    nama_ibu: normalizeOptionalText(body.nama_ibu),
    pekerjaan_ibu: normalizeOptionalText(body.pekerjaan_ibu),
    dob_ibu: normalizeDateValue(body.dob_ibu),
    taraf_ibu: normalizeOptionalText(body.taraf_ibu),
    no_telefon_ibu: normalizeOptionalText(body.no_telefon_ibu),
    bangsa_ibu: normalizeOptionalText(body.bangsa_ibu),
    ugama_ibu: normalizeOptionalText(body.ugama_ibu),
    kerakyatan_ibu: normalizeOptionalText(body.kerakyatan_ibu),
    family_id: normalizeOptionalText(body.family_id || body.familyID),
    yiuran_sekolah_paid: body.yiuran_sekolah_paid ? 1 : 0,
    yuran_pibg_paid: body.yuran_pibg_paid ? 1 : 0,
    insuran_paid: body.insuran_paid ? 1 : 0
  };
}

function getPhotoColumnForSlot(slot) {
  return Number(slot) === 1 ? "photo_path" : "photo_" + Number(slot) + "_path";
}

function getPhotoUploadedAtColumnForSlot(slot) {
  return Number(slot) === 1 ? "photo_uploaded_at" : "photo_" + Number(slot) + "_uploaded_at";
}

function getPhotoUploadedByColumnForSlot(slot) {
  return Number(slot) === 1 ? "photo_uploaded_by" : "photo_" + Number(slot) + "_uploaded_by";
}

function getUploadedPhoto(req, fieldName) {
  if (!req.files || !req.files[fieldName] || !req.files[fieldName][0]) return null;
  return req.files[fieldName][0];
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
    const pathColumn = getPhotoColumnForSlot(slot);
    const uploadedAtColumn = getPhotoUploadedAtColumnForSlot(slot);
    const src = String(student[pathColumn] || "").trim();
    const uploadedById = Number(student[getPhotoUploadedByColumnForSlot(slot)] || 0);
    return {
      slot,
      src,
      uploadedAt: formatUploadedDate(student[uploadedAtColumn]),
      uploadedBy: uploaderNameById.get(uploadedById) || ""
    };
  });
}

function getStudentForAdminEdit(studentPk, classId) {
  return db
    .prepare(
      `SELECT *
       FROM students
       WHERE id = ? AND class_id = ?`
    )
    .get(studentPk, classId);
}

function getDashboardDeviceStatus(device) {
  if (device.status !== "available") return device.status;
  if (Number(device.has_in_use) > 0) return "in_use";
  if (Number(device.has_booked) > 0) return "booked";
  return "available";
}

function getDashboardDevices() {
  const today = dayjs().format("YYYY-MM-DD");
  const nowTime = dayjs().format("HH:mm");
  return db
    .prepare(
      `SELECT d.*,
              inv.id AS inventory_id,
              inv.name AS inventory_name,
              inv.code AS inventory_code,
              inv.category AS inventory_category,
              inv.location AS inventory_location,
              inv.status AS inventory_status,
              inv.is_bookable AS inventory_is_bookable,
              inv.notes AS inventory_notes,
              EXISTS(
                SELECT 1
                FROM device_bookings b
                WHERE b.device_id = d.id
                  AND b.status = 'in_use'
              ) AS has_in_use,
              EXISTS(
                SELECT 1
                FROM device_bookings b
                WHERE b.device_id = d.id
                  AND b.status = 'booked'
                  AND (b.booking_date > ? OR (b.booking_date = ? AND b.planned_end_time >= ?))
              ) AS has_booked
       FROM devices d
       JOIN school_inventory inv ON inv.linked_device_id = d.id
       ORDER BY LOWER(inv.category) ASC, LOWER(inv.name) ASC`
    )
    .all(today, today, nowTime)
    .map((row) => ({
      ...row,
      name: row.inventory_name || row.name,
      code: row.inventory_code || row.code,
      category: row.inventory_category || row.category,
      location: row.inventory_location || row.location,
      status: ADMIN_DEVICE_STATUSES.includes(row.inventory_status) ? row.inventory_status : row.status,
      notes: row.inventory_notes || row.notes,
      derived_status: getDashboardDeviceStatus({
        ...row,
        status: ADMIN_DEVICE_STATUSES.includes(row.inventory_status) ? row.inventory_status : row.status
      })
    }));
}

function getDashboardDeviceLocations(activeOnly = false) {
  return db
    .prepare(
      `SELECT id, name, is_active, created_at, updated_at
       FROM inventory_locations
       ${activeOnly ? "WHERE is_active = 1" : ""}
       ORDER BY is_active DESC, LOWER(name) ASC`
    )
    .all();
}

function getDashboardDeviceVenues(activeOnly = false) {
  return getDashboardDeviceLocations(activeOnly);
}

function getDashboardDeviceCategories(activeOnly = false) {
  return db
    .prepare(
      `SELECT id, name, is_active, created_at, updated_at
       FROM inventory_categories
       ${activeOnly ? "WHERE is_active = 1" : ""}
       ORDER BY is_active DESC, LOWER(name) ASC`
    )
    .all();
}

function getDashboardDeviceAvailability(activeOnly = false) {
  const options = db
    .prepare(
      `SELECT id, name, is_active, created_at, updated_at
       FROM inventory_availability_options
       ${activeOnly ? "WHERE is_active = 1" : ""}
       ORDER BY is_active DESC, LOWER(name) ASC`
    )
    .all()
    .filter((option) => ADMIN_DEVICE_STATUSES.includes(option.name));
  if (activeOnly && !options.length) {
    return ADMIN_DEVICE_STATUSES.map((name, index) => ({ id: index + 1, name, is_active: 1 }));
  }
  return options;
}

router.get("/dashboard", async (req, res) => {
  const signedInUserId = Number((req.session.user || {}).id || 0);
  const staffUsersRaw = db
    .prepare(
      `SELECT id, username, email, display_name, role,
              COALESCE(user_type, CASE WHEN role = 'admin' THEN 'admin' WHEN role = 'staff' THEN 'staff' ELSE 'teacher' END) AS user_type,
              COALESCE(is_active, 1) AS is_active,
              created_at
       FROM users
       ORDER BY id DESC`
    )
    .all();
  const staffUsers = await Promise.all(
    staffUsersRaw.map(async (user) => ({
      ...user,
      is_current_session_user: Number(user.id) === signedInUserId,
      qr_code_payload: buildUserQrPayload(user),
      qr_code_image: await generateUserQrDataUrl(user)
    }))
  );
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const selectedClassId = Number(req.query.class_id) || (classes[0] ? classes[0].id : null);

  const studentsInClass = selectedClassId
    ? db
        .prepare(
          `SELECT id, student_id, no_sb, full_name, COALESCE(NULLIF(name, ''), full_name) AS nickname
           FROM students
           WHERE class_id = ?
           ORDER BY COALESCE(NULLIF(name, ''), full_name) ASC, full_name ASC`
        )
        .all(selectedClassId)
    : [];

  const selectedStudentId = Number(req.query.student_pk) || (studentsInClass[0] ? studentsInClass[0].id : null);
  const selectedStudent = selectedStudentId ? getStudentForAdminEdit(selectedStudentId, selectedClassId) : null;
  const selectedStudentPhotoSlots = selectedStudent ? getStudentPhotoSlots(selectedStudent) : [];

  const activeEvents = db
    .prepare(
      `SELECT ce.id, ce.title, COALESCE(ce.details, '') AS details, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.event_source, ce.created_at, u.display_name AS creator_name,
              COALESCE((
                SELECT GROUP_CONCAT(
                  cl.id || '::' || cl.name || '::' || cl.color || '::' || COALESCE(cl.description, ''),
                  '||'
                )
                FROM calendar_event_labels cel
                JOIN calendar_labels cl ON cl.id = cel.label_id
                WHERE cel.event_id = ce.id
              ), '') AS labels_raw
       FROM calendar_events ce
       LEFT JOIN users u ON u.id = ce.created_by
       WHERE ce.is_deleted = 0
       ORDER BY ce.event_date ASC, ce.created_at DESC`
    )
    .all()
    .map((event) => ({
      ...event,
      labels: parseCalendarLabelsRaw(event.labels_raw),
      label_ids: parseCalendarLabelsRaw(event.labels_raw).map((label) => Number(label.id)).filter(Boolean)
    }));
  const calendarLabels = listCalendarLabelsForAdmin();

  const deletedEvents = db
    .prepare(
      `SELECT ce.id, ce.title, ce.event_date, COALESCE(ce.end_date, ce.event_date) AS end_date, ce.deleted_at, u.display_name AS deleted_by_name
       FROM calendar_events ce
       LEFT JOIN users u ON u.id = ce.deleted_by
       WHERE ce.is_deleted = 1
       ORDER BY ce.deleted_at DESC`
    )
    .all();

  const infoFolders = db
    .prepare("SELECT id, name, created_at FROM info_folders ORDER BY LOWER(name) ASC")
    .all();

  const informationFiles = db
    .prepare(
      `SELECT info.id, info.title, info.file_name, info.file_path, info.folder_id, info.uploaded_at, u.display_name AS uploaded_by_name, folder.name AS folder_name
       FROM information_files info
       LEFT JOIN users u ON u.id = info.uploaded_by
       LEFT JOIN info_folders folder ON folder.id = info.folder_id
       ORDER BY LOWER(COALESCE(folder.name, '')), info.uploaded_at DESC, LOWER(info.title) ASC`
    )
    .all();

  const backupDashboard = getBackupDashboardData();
  const kioskRewardRules = db.prepare(`
    SELECT id, label, start_time, end_time, points, COALESCE(is_active, 1) AS is_active
    FROM kiosk_reward_rules
    ORDER BY start_time ASC, end_time ASC, id ASC
  `).all();
  const pointReasons = db.prepare(`
    SELECT pr.id, pr.reason, pr.reason_type, COALESCE(pr.is_custom, 0) AS is_custom, pr.created_at,
           CASE WHEN COALESCE(pr.is_custom, 0) = 0 OR u.role = 'admin' THEN 1 ELSE 0 END AS is_default,
           COALESCE(u.display_name, u.username, 'System') AS created_by_name,
           COALESCE(usage.total_usage, 0) AS total_usage
    FROM point_reasons pr
    LEFT JOIN users u ON u.id = pr.created_by
    LEFT JOIN (
      SELECT reason, COUNT(*) AS total_usage
      FROM point_logs
      GROUP BY reason
    ) usage ON usage.reason = pr.reason
    ORDER BY pr.reason_type ASC, is_default DESC, LOWER(pr.reason) ASC, pr.id ASC
  `).all();
  const userLoginReportRows = getUserLoginReportRows(10).map((row) => ({
    ...row,
    logged_at_display: dayjs(row.logged_at).isValid() ? dayjs(row.logged_at).format("YYYY-MM-DD HH:mm:ss") : row.logged_at
  }));
  const studentEditLogRows = db.prepare(`
    SELECT sel.id, sel.student_pk, sel.student_id, sel.student_full_name, sel.field_key, sel.field_label,
           sel.old_value, sel.new_value, sel.edited_by_label, sel.edited_at,
           c.name AS current_class_name
    FROM student_edit_logs sel
    LEFT JOIN students s ON s.id = sel.student_pk
    LEFT JOIN classes c ON c.id = s.class_id
    ORDER BY sel.edited_at DESC, sel.id DESC
    LIMIT 10
  `).all().map((row) => ({
    ...row,
    edited_at_display: dayjs(row.edited_at).isValid() ? dayjs(row.edited_at).format("YYYY-MM-DD HH:mm:ss") : row.edited_at
  }));
  const photoActivityReportRows = getPhotoActivityReportRows(10).map((row) => ({
    ...row,
    created_at_display: dayjs(row.created_at).isValid() ? dayjs(row.created_at).format("YYYY-MM-DD HH:mm:ss") : row.created_at
  }));
  const dashboardDevices = await Promise.all(getDashboardDevices().map(async (device) => ({
    ...device,
    qr_code_image: await generateDeviceQrDataUrl(device)
  })));
  const schoolCalendar = getSchoolCalendarDashboard(getSchoolCalendarFilters(req.query));
  const adminAuditFilters = {
    search: String(req.query.audit_search || "").trim(),
    result: String(req.query.audit_result || "").trim(),
    dateFrom: String(req.query.audit_from || "").trim(),
    dateTo: String(req.query.audit_to || "").trim()
  };
  const adminAuditRows = getAdminAuditRows(adminAuditFilters, 100);
  let rolloverTargetYear = dayjs().add(1, "year").year();
  try { rolloverTargetYear = normalizeYear(req.query.rollover_year || rolloverTargetYear); } catch (_) {}
  const academicYearRollover = getRolloverPreview(rolloverTargetYear);
  const adminCommandCentre = getAdminCommandCentre({ backupDashboard, academicYearRollover });

  res.render("admin-dashboard", {
    staffUsers,
    classes,
    studentFormGroups: STUDENT_FORM_GROUPS,
    studentFormFieldKeys: STUDENT_CORE_FIELD_KEYS,
    selectedClassId,
    studentsInClass,
    selectedStudentId,
    selectedStudent,
    selectedStudentPhotoSlots: selectedStudent ? getStudentPhotoSlots(selectedStudent) : [],
    activeEvents,
    deletedEvents,
    infoFolders,
    informationFiles,
    backupSettings: backupDashboard.settings,
    backupStatus: backupDashboard.status,
    backupLatest: backupDashboard.latest,
    backupHistory: backupDashboard.history,
    backupSavedBackups: backupDashboard.savedBackups,
    backupRunning: backupDashboard.running,
    calendarLabels,
    schoolCalendar,
    academicYearRollover,
    adminAuditRows,
    adminAuditFilters,
    adminCommandCentre,
    leaderboardSlideshowDurationSeconds: getLeaderboardSlideshowDurationMs() / 1000,
    dashboardDevices,
    dashboardDeviceStatuses: ADMIN_DEVICE_STATUSES,
    dashboardDeviceCategoryOptions: getDashboardDeviceCategories(true),
    dashboardDeviceAvailabilityOptions: getDashboardDeviceAvailability(true),
    dashboardDeviceLocationOptions: getDashboardDeviceLocations(true),
    dashboardAllDeviceLocationOptions: getDashboardDeviceLocations(false),
    dashboardDeviceVenueOptions: getDashboardDeviceVenues(true),
    dashboardAllDeviceVenueOptions: getDashboardDeviceVenues(false),
    kioskRewardRules,
    pointReasons,
    userLoginReportRows,
    studentEditLogRows,
    photoActivityReportRows,
    error: req.query.error || null,
    success: req.query.success || null
  });
});


router.get("/reports/user-logins/export", (req, res) => {
  const rows = getUserLoginReportRows(5000);
  const header = [
    "Date and Time",
    "Display Name",
    "Username",
    "Role",
    "User Type",
    "IP Address",
    "Device Browser"
  ].map(csvEscape).join(",");
  const csvRows = rows.map((row) => [
    dayjs(row.logged_at).isValid() ? dayjs(row.logged_at).format("YYYY-MM-DD HH:mm:ss") : row.logged_at,
    row.display_name,
    row.username,
    row.role,
    row.user_type,
    row.ip_address,
    row.user_agent
  ].map(csvEscape).join(","));
  const csv = [header, ...csvRows].join("\n");
  const stamp = dayjs().format("YYYYMMDD-HHmmss");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="user-login-report-${stamp}.csv"`);
  return res.send(csv);
});


router.get("/reports/student-edits/export", (req, res) => {
  const rows = db.prepare(`
    SELECT student_id, student_full_name, field_key, field_label, old_value, new_value, edited_by_label, edited_at
    FROM student_edit_logs
    ORDER BY edited_at DESC, id DESC
  `).all();
  const header = [
    "Date and Time",
    "Student ID",
    "Student Full Name",
    "Field Key",
    "Field Label",
    "Changed From",
    "Changed To",
    "Edited By"
  ].map(csvEscape).join(",");
  const csvRows = rows.map((row) => [
    dayjs(row.edited_at).isValid() ? dayjs(row.edited_at).format("YYYY-MM-DD HH:mm:ss") : row.edited_at,
    row.student_id,
    row.student_full_name,
    row.field_key,
    row.field_label,
    row.old_value,
    row.new_value,
    row.edited_by_label
  ].map(csvEscape).join(","));
  const csv = [header, ...csvRows].join("\n");
  const stamp = dayjs().format("YYYYMMDD-HHmmss");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="student-edit-log-${stamp}.csv"`);
  return res.send(csv);
});

router.get("/reports/photo-activity/export", (req, res) => {
  const rows = getPhotoActivityReportRows(5000);
  const header = [
    "Date and Time",
    "Display Name",
    "Username",
    "Activity Type",
    "Target Type",
    "Target Label",
    "Folder ID",
    "File ID",
    "Details",
    "IP Address",
    "Device Browser"
  ].map(csvEscape).join(",");
  const csvRows = rows.map((row) => [
    dayjs(row.created_at).isValid() ? dayjs(row.created_at).format("YYYY-MM-DD HH:mm:ss") : row.created_at,
    row.display_name,
    row.username,
    row.activity_type,
    row.target_type,
    row.target_label,
    row.folder_id,
    row.file_id,
    row.details,
    row.ip_address,
    row.user_agent
  ].map(csvEscape).join(","));
  const csv = [header, ...csvRows].join("\n");
  const stamp = dayjs().format("YYYYMMDD-HHmmss");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="photo-activity-report-${stamp}.csv"`);
  return res.send(csv);
});



router.get("/classes/:classId/edit-data", (req, res) => {
  const classId = Number(req.params.classId || 0);

  if (!classId) {
    return res.status(400).json({ error: "class_id is required" });
  }

  const students = db
    .prepare(
      `SELECT id, student_id, no_sb, full_name, COALESCE(NULLIF(name, ''), full_name) AS nickname
       FROM students
       WHERE class_id = ?
       ORDER BY COALESCE(NULLIF(name, ''), full_name) ASC, full_name ASC`
    )
    .all(classId);

  const selectedStudent = students.length ? getStudentForAdminEdit(students[0].id, classId) : null;

  return res.json({
    students,
    selectedStudent: selectedStudent
      ? {
          ...selectedStudent,
          photo_src: selectedStudent.photo_path || "",
          photo_slots: getStudentPhotoSlots(selectedStudent)
        }
      : null
  });
});

router.get("/students/:studentPk/edit-data", (req, res) => {
  const studentPk = Number(req.params.studentPk || 0);
  const classId = Number(req.query.class_id || 0);

  if (!studentPk || !classId) {
    return res.status(400).json({ error: "student_pk and class_id are required" });
  }

  const student = getStudentForAdminEdit(studentPk, classId);
  if (!student) {
    return res.status(404).json({ error: "Student not found" });
  }

  return res.json({
    student: {
      ...student,
      photo_src: student.photo_path || "",
      photo_slots: getStudentPhotoSlots(student)
    }
  });
});

router.get("/staff/template", (_req, res) => {
  const templatePath = path.join(__dirname, "..", "..", "public", "templates", "staff-import-template.csv");
  if (!fs.existsSync(templatePath)) {
    return res.status(404).send("Template not found");
  }
  return res.download(templatePath, "staff-import-template.csv");
});

function parseRoleAndType(roleRaw, userTypeRaw) {
  const roleNorm = String(roleRaw || "teacher").trim().toLowerCase();
  const role = ["admin", "teacher", "staff"].includes(roleNorm) ? roleNorm : "teacher";
  const typeNorm = String(userTypeRaw || role).trim().toLowerCase();
  const userType = ["admin", "teacher", "staff"].includes(typeNorm)
    ? typeNorm
    : (role === "admin" ? "admin" : (role === "staff" ? "staff" : "teacher"));
  return { role, userType };
}

function normalizeEmail(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  return trimmed || null;
}

function isValidEmail(value) {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));
}

function normalizePointReasonType(value) {
  return String(value || "").trim().toLowerCase() === "negative" ? "negative" : "positive";
}

function getPointReasonRedirect(message, isError) {
  const key = isError ? "error" : "success";
  return `/admin/dashboard?${key}=${encodeURIComponent(message)}`;
}

function addUserHandler(req, res) {
  const username = (req.body.username || "").trim();
  const displayName = (req.body.display_name || "").trim();
  const email = normalizeEmail(req.body.email);
  const password = req.body.password || "";
  const { role, userType } = parseRoleAndType(req.body.role, req.body.user_type);
  const isActive = String(req.body.is_active || "1") === "1" ? 1 : 0;

  if (!username || !displayName || !password) {
    return res.redirect("/admin/dashboard?error=USER+ID,+display+name+and+password+are+required");
  }
  if (password.length < 12) {
    return res.redirect("/admin/dashboard?error=Temporary+password+must+be+at+least+12+characters");
  }
  if (!isValidEmail(email)) {
    return res.redirect("/admin/dashboard?error=Invalid+email+format");
  }
  if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
    return res.redirect("/admin/dashboard?error=USER+ID+already+exists");
  }
  if (email) {
    const emailDup = db.prepare("SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))").get(email);
    if (emailDup) return res.redirect("/admin/dashboard?error=Email+already+exists");
  }

  db.prepare(
    `INSERT INTO users (username, email, display_name, role, user_type, password_hash, is_active, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(username, email, displayName, role, userType, bcrypt.hashSync(password, 12), isActive, role === "admin" ? 0 : 1, dayjs().toISOString());

  return res.redirect("/admin/dashboard?success=User+account+added");
}

router.post("/users/add", addUserHandler);
router.post("/teachers/add", addUserHandler);

router.post("/teachers/reset-password", (req, res) => {
  const userId = Number(req.body.teacher_id || req.body.user_id);
  const newPassword = req.body.new_password || "";
  if (!userId || !newPassword) return res.status(400).send("user_id and new_password required");
  if (String(newPassword).length < 12) {
    return res.redirect("/admin/dashboard?error=Password+must+be+at+least+12+characters");
  }

  const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
  if (!target) return res.redirect("/admin/dashboard?error=User+account+not+found");

  const mustChangePassword = target.role === "admin" ? 0 : 1;
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 12), mustChangePassword, userId);
  const success = target.role === "admin"
    ? "Administrator password updated"
    : "Temporary password set; user must choose a new password after login";
  res.redirect(`/admin/dashboard?success=${encodeURIComponent(success)}`);
});

router.post("/users/bulk-manage", (req, res) => {
  const selectedIds = Array.from(new Set(
    (Array.isArray(req.body.selected_user_ids) ? req.body.selected_user_ids : [req.body.selected_user_ids])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  ));
  const action = String(req.body.bulk_action || "").trim().toLowerCase();
  const sessionUserId = Number((req.session.user || {}).id || 0);

  if (!selectedIds.length) {
    return res.redirect("/admin/dashboard?error=Select+at+least+one+user+account");
  }
  if (selectedIds.length > 500) {
    return res.redirect("/admin/dashboard?error=Select+no+more+than+500+user+accounts+at+one+time");
  }
  if (selectedIds.includes(sessionUserId)) {
    return res.redirect("/admin/dashboard?error=For+safety,+your+own+administrator+account+cannot+be+changed+in+a+bulk+action");
  }

  const placeholders = selectedIds.map(() => "?").join(",");
  const targets = db.prepare(`SELECT id, role FROM users WHERE id IN (${placeholders})`).all(...selectedIds);
  if (targets.length !== selectedIds.length) {
    return res.redirect("/admin/dashboard?error=One+or+more+selected+user+accounts+no+longer+exist");
  }

  try {
    if (action === "set-temporary-password") {
      const password = String(req.body.new_password || "");
      const confirmation = String(req.body.confirm_new_password || "");
      if (password.length < 12) {
        return res.redirect("/admin/dashboard?error=Temporary+password+must+be+at+least+12+characters");
      }
      if (password !== confirmation) {
        return res.redirect("/admin/dashboard?error=Temporary+password+confirmation+does+not+match");
      }
      const update = db.prepare("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?");
      const hash = bcrypt.hashSync(password, 12);
      db.transaction(() => targets.forEach((target) => update.run(hash, target.role === "admin" ? 0 : 1, target.id)))();
    } else if (action === "set-active" || action === "set-inactive") {
      db.prepare(`UPDATE users SET is_active = ? WHERE id IN (${placeholders})`).run(action === "set-active" ? 1 : 0, ...selectedIds);
    } else if (action === "set-role") {
      const { role, userType } = parseRoleAndType(req.body.bulk_role, req.body.bulk_user_type);
      db.prepare(`UPDATE users SET role = ?, user_type = ?, must_change_password = CASE WHEN ? = 'admin' THEN 0 ELSE must_change_password END WHERE id IN (${placeholders})`).run(role, userType, role, ...selectedIds);
    } else {
      return res.redirect("/admin/dashboard?error=Choose+a+valid+bulk+user+action");
    }
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Bulk user update failed: ${err.message}`)}`);
  }

  return res.redirect(`/admin/dashboard?success=${encodeURIComponent(`Updated ${selectedIds.length} user account${selectedIds.length === 1 ? "" : "s"}`)}`);
});

router.post("/staff/set-active", (req, res) => {
  const userId = Number(req.body.user_id || 0);
  const isActive = String(req.body.is_active || "1") === "1" ? 1 : 0;
  if (!userId) return res.redirect("/admin/dashboard?error=Invalid+user+ID");

  const sessionUserId = Number((req.session.user || {}).id || 0);
  if (userId === sessionUserId && isActive !== 1) {
    return res.redirect("/admin/dashboard?error=Cannot+deactivate+your+own+account");
  }

  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(isActive, userId);
  return res.redirect("/admin/dashboard?success=User+status+updated");
});

router.post("/users/update", (req, res) => {
  const userId = Number(req.body.user_id || 0);
  const username = String(req.body.username || "").trim();
  const displayName = String(req.body.display_name || "").trim();
  const email = normalizeEmail(req.body.email);
  const { role, userType } = parseRoleAndType(req.body.role, req.body.user_type);
  const isActive = String(req.body.is_active || "1") === "1" ? 1 : 0;

  if (!userId || !username || !displayName) {
    return res.redirect("/admin/dashboard?error=Invalid+user+update+data");
  }

  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!existing) return res.redirect("/admin/dashboard?error=User+not+found");
  if (!isValidEmail(email)) {
    return res.redirect("/admin/dashboard?error=Invalid+email+format");
  }

  const duplicate = db.prepare("SELECT id FROM users WHERE username = ? AND id <> ?").get(username, userId);
  if (duplicate) return res.redirect("/admin/dashboard?error=USER+ID+already+used+by+another+account");
  if (email) {
    const emailDup = db.prepare("SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) AND id <> ?").get(email, userId);
    if (emailDup) return res.redirect("/admin/dashboard?error=Email+already+used+by+another+account");
  }

  const sessionUserId = Number((req.session.user || {}).id || 0);
  if (userId === sessionUserId && role !== "admin") {
    return res.redirect("/admin/dashboard?error=Cannot+change+your+own+admin+role");
  }
  if (userId === sessionUserId && isActive !== 1) {
    return res.redirect("/admin/dashboard?error=Cannot+deactivate+your+own+account");
  }

  db.prepare(
    `UPDATE users
     SET username = ?, email = ?, display_name = ?, role = ?, user_type = ?, is_active = ?
     WHERE id = ?`
  ).run(username, email, displayName, role, userType, isActive, userId);

  return res.redirect("/admin/dashboard?success=User+account+updated");
});

router.post("/points/reasons/add", (req, res) => {
  const reason = String(req.body.reason || "").trim();
  const reasonType = normalizePointReasonType(req.body.reason_type);

  if (!reason) {
    return res.redirect(getPointReasonRedirect("Reason text is required", true));
  }

  const duplicate = db.prepare("SELECT id FROM point_reasons WHERE LOWER(reason) = LOWER(?)").get(reason);
  if (duplicate) {
    return res.redirect(getPointReasonRedirect("Reason already exists", true));
  }

  db.prepare(
    `INSERT INTO point_reasons (reason, reason_type, created_by, is_custom, created_at)
     VALUES (?, ?, ?, 1, ?)`
  ).run(reason, reasonType, Number((req.session.user || {}).id || 0) || null, dayjs().toISOString());

  return res.redirect(getPointReasonRedirect("P.I.T.I.S reason added"));
});

router.post("/points/reasons/:reasonId/update", (req, res) => {
  const reasonId = Number(req.params.reasonId || 0);
  const reason = String(req.body.reason || "").trim();
  const reasonType = normalizePointReasonType(req.body.reason_type);

  if (!reasonId || !reason) {
    return res.redirect(getPointReasonRedirect("Reason and type are required", true));
  }

  const existingReason = db.prepare("SELECT id, reason FROM point_reasons WHERE id = ?").get(reasonId);
  if (!existingReason) {
    return res.redirect(getPointReasonRedirect("Reason not found", true));
  }

  const duplicate = db
    .prepare("SELECT id FROM point_reasons WHERE LOWER(reason) = LOWER(?) AND id <> ?")
    .get(reason, reasonId);
  if (duplicate) {
    return res.redirect(getPointReasonRedirect("Reason already exists", true));
  }

  db.transaction(() => {
    db.prepare("UPDATE point_reasons SET reason = ?, reason_type = ? WHERE id = ?").run(reason, reasonType, reasonId);
    if (reason !== existingReason.reason) {
      db.prepare("UPDATE point_logs SET reason = ? WHERE reason = ?").run(reason, existingReason.reason);
    }
  })();

  return res.redirect(getPointReasonRedirect("P.I.T.I.S reason updated"));
});

router.post("/points/reasons/:reasonId/delete", (req, res) => {
  const reasonId = Number(req.params.reasonId || 0);
  if (!reasonId) {
    return res.redirect(getPointReasonRedirect("Reason not found", true));
  }

  const existingReason = db.prepare("SELECT id, reason FROM point_reasons WHERE id = ?").get(reasonId);
  if (!existingReason) {
    return res.redirect(getPointReasonRedirect("Reason not found", true));
  }

  const usage = db.prepare("SELECT COUNT(*) AS total FROM point_logs WHERE reason = ?").get(existingReason.reason);
  if (Number((usage || {}).total || 0) > 0) {
    return res.redirect(getPointReasonRedirect("Cannot delete a reason already used in point history. Edit it instead.", true));
  }

  db.prepare("DELETE FROM point_reasons WHERE id = ?").run(reasonId);
  return res.redirect(getPointReasonRedirect("P.I.T.I.S reason deleted"));
});

router.post("/staff/import", uploadMemory.single("staff_csv"), (req, res) => {
  if (!req.file) return res.redirect("/admin/dashboard?error=CSV+file+required");

  let records;
  try {
    records = parse(req.file.buffer.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`CSV parse failed: ${err.message}`)}`);
  }

  const findExisting = db.prepare("SELECT id FROM users WHERE username = ?");
  const findExistingEmail = db.prepare("SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))");
  const insertUser = db.prepare(
    `INSERT INTO users (username, email, display_name, role, user_type, password_hash, is_active, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const summary = { inserted: 0, skipped: 0, failed: 0, errors: [] };
  const now = dayjs().toISOString();

  const tx = db.transaction((rows) => {
    for (let i = 0; i < rows.length; i += 1) {
      const rowNum = i + 2;
      const row = rows[i] || {};

      const userId = String(row.user_id || row.username || "").trim();
      const fullName = String(row.full_name || row.display_name || "").trim();
      const email = normalizeEmail(row.email);
      const password = String(row.password || "");
      const roleRaw = String(row.role || "teacher").trim().toLowerCase();
      const role = ["admin", "teacher", "staff"].includes(roleRaw) ? roleRaw : "teacher";
      const userTypeRaw = String(row.user_type || row.member_type || roleRaw || "teacher").trim().toLowerCase();
      const userType = ["admin", "teacher", "staff"].includes(userTypeRaw)
        ? userTypeRaw
        : (role === "admin" ? "admin" : (role === "staff" ? "staff" : "teacher"));
      const isActive = String(row.is_active || "true").trim().toLowerCase();
      const isActiveFlag = ["1", "true", "yes", "y"].includes(isActive) ? 1 : 0;

      if (!userId || !fullName || !password) {
        summary.failed += 1;
        summary.errors.push(`Row ${rowNum}: required fields user_id, full_name, password`);
        continue;
      }

      if (password.length < 12) {
        summary.failed += 1;
        summary.errors.push(`Row ${rowNum}: temporary password must be at least 12 characters`);
        continue;
      }

      if (!isValidEmail(email)) {
        summary.failed += 1;
        summary.errors.push(`Row ${rowNum}: invalid email format`);
        continue;
      }

      if (findExisting.get(userId)) {
        summary.skipped += 1;
        summary.errors.push(`Row ${rowNum}: duplicate USER ID (${userId}) skipped`);
        continue;
      }
      if (email && findExistingEmail.get(email)) {
        summary.skipped += 1;
        summary.errors.push(`Row ${rowNum}: duplicate email (${email}) skipped`);
        continue;
      }
      try {
        insertUser.run(userId, email, fullName, role, userType, bcrypt.hashSync(password, 12), isActiveFlag, role === "admin" ? 0 : 1, now);
        summary.inserted += 1;
      } catch (err) {
        summary.failed += 1;
        summary.errors.push(`Row ${rowNum}: ${err.message}`);
      }
    }
  });

  try {
    tx(records);
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Staff import failed: ${err.message}`)}`);
  }

  const errorText = summary.errors.slice(0, 6).join(" | ");
  const msg = `Staff import complete. Inserted: ${summary.inserted}. Skipped: ${summary.skipped}. Failed: ${summary.failed}${errorText ? `. ${errorText}` : ""}`;
  return res.redirect(`/admin/dashboard?success=${encodeURIComponent(msg)}`);
});

router.post("/informations/folders/add", (req, res) => {
  const name = String(req.body.folder_name || "").trim();
  if (!name) return res.redirect("/admin/dashboard?error=Folder+name+required");
  const existing = db.prepare("SELECT id FROM info_folders WHERE LOWER(name) = LOWER(?)").get(name);
  if (existing) return res.redirect("/admin/dashboard?error=Folder+already+exists");
  db.prepare("INSERT INTO info_folders (name, created_at) VALUES (?, ?)").run(name, dayjs().toISOString());
  return res.redirect("/admin/dashboard?success=Folder+created");
});

router.post("/informations/folders/delete/:id", (req, res) => {
  const folderId = Number(req.params.id || 0);
  if (!folderId) return res.redirect("/admin/dashboard?error=Invalid+folder");
  const linked = db.prepare("SELECT COUNT(*) AS total FROM information_files WHERE folder_id = ?").get(folderId);
  if (Number((linked || {}).total || 0) > 0) {
    return res.redirect("/admin/dashboard?error=Folder+must+be+empty+before+deletion");
  }
  db.prepare("DELETE FROM info_folders WHERE id = ?").run(folderId);
  return res.redirect("/admin/dashboard?success=Folder+deleted");
});

router.post("/informations/update/:id", (req, res) => {
  const infoId = Number(req.params.id || 0);
  const title = String(req.body.title || "").trim();
  const folderIdRaw = String(req.body.folder_id || "").trim();
  const folderId = folderIdRaw ? Number(folderIdRaw) : null;
  if (!infoId || !title) return res.redirect("/admin/dashboard?error=Information+title+required");
  if (folderIdRaw && !folderId) return res.redirect("/admin/dashboard?error=Invalid+folder+selected");
  db.prepare("UPDATE information_files SET title = ?, folder_id = ? WHERE id = ?").run(title, folderId || null, infoId);
  return res.redirect("/admin/dashboard?success=Information+updated");
});

router.post("/informations/delete/:id", (req, res) => {
  const infoId = Number(req.params.id || 0);
  if (!infoId) return res.redirect("/admin/dashboard?error=Invalid+information+file");
  const row = db.prepare("SELECT file_path FROM information_files WHERE id = ?").get(infoId);
  if (!row) return res.redirect("/admin/dashboard?error=Information+file+not+found");
  db.prepare("DELETE FROM information_files WHERE id = ?").run(infoId);
  const rel = String(row.file_path || "").trim();
  if (rel.startsWith("/uploads/informations/")) {
  const abs = path.join(__dirname, "..", "..", "public", rel.replace(/^\//, ""));
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (_) {}
    }
  }
  return res.redirect("/admin/dashboard?success=Information+deleted");
});

router.post("/informations/bulk-manage", (req, res) => {
  try {
    const action = String(req.body.bulk_action || "").trim().toLowerCase();
    const selectedIdsRaw = Array.isArray(req.body.selected_files)
      ? req.body.selected_files
      : (req.body.selected_files ? [req.body.selected_files] : []);
    const selectedIds = Array.from(
      new Set(
        selectedIdsRaw
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      )
    );

    if (!selectedIds.length) {
      return res.redirect("/admin/dashboard?error=Please+select+at+least+one+information+file");
    }

    const placeholders = selectedIds.map(() => "?").join(", ");
    const files = db.prepare(
      `SELECT id, title, file_path
       FROM information_files
       WHERE id IN (${placeholders})`
    ).all(...selectedIds);

    if (!files.length) {
      return res.redirect("/admin/dashboard?error=Selected+information+files+were+not+found");
    }

    if (action === "move") {
      const targetFolder = resolveAdminInformationFolder(req.body.folder_id, req.body.new_folder_name);
      db.transaction(() => {
        db.prepare(`UPDATE information_files SET folder_id = ? WHERE id IN (${placeholders})`).run(targetFolder.folderId, ...selectedIds);
      })();
      return res.redirect(
        `/admin/dashboard?success=${encodeURIComponent(`${files.length} information file(s) moved to ${targetFolder.folderName}`)}`
      );
    }

    if (action === "delete") {
      db.transaction(() => {
        db.prepare(`DELETE FROM information_files WHERE id IN (${placeholders})`).run(...selectedIds);
      })();

      files.forEach((file) => {
        const rel = String(file.file_path || "").trim();
        if (!rel.startsWith("/uploads/informations/")) return;
        const abs = path.join(__dirname, "..", "..", "public", rel.replace(/^\//, ""));
        if (fs.existsSync(abs)) {
          try { fs.unlinkSync(abs); } catch (_) {}
        }
      });

      return res.redirect(
        `/admin/dashboard?success=${encodeURIComponent(`${files.length} information file(s) deleted`)}`
      );
    }

    return res.redirect("/admin/dashboard?error=Please+choose+a+valid+manage+action");
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Information bulk action failed: ${err.message}`)}`);
  }
});

router.post("/informations/upload", informationUpload.single("information_pdf"), (req, res) => {
  const title = String(req.body.title || "").trim();
  const folderIdRaw = String(req.body.folder_id || "").trim();
  const file = req.file;
  if (!file) {
    return res.redirect("/admin/dashboard?error=PDF+file+required");
  }

  const derivedTitle = title || path.basename(file.originalname || file.filename, path.extname(file.originalname || file.filename));
  const filePath = "/uploads/informations/" + file.filename;
  const uploadedBy = Number((req.session.user || {}).id || 0) || null;
  const folderId = folderIdRaw ? Number(folderIdRaw) : null;
  if (folderIdRaw && !folderId) {
    return res.redirect("/admin/dashboard?error=Invalid+folder+selected");
  }

  db.prepare(
    `INSERT INTO information_files (title, file_name, file_path, folder_id, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(derivedTitle, file.originalname || file.filename, filePath, folderId || null, uploadedBy, dayjs().toISOString());

  return res.redirect("/admin/dashboard?success=Information+PDF+uploaded");
});

router.post("/students/add", photoUpload.fields(STUDENT_PHOTO_UPLOAD_FIELDS), (req, res) => {
  const classId = Number(req.body.class_id);
  const baseValues = buildStudentBaseValues(req.body, classId);

  if (!classId || !baseValues.student_id || !baseValues.name || !baseValues.full_name) {
    return res.status(400).send("Required fields missing");
  }

  const now = dayjs().toISOString();
  const insertColumns = ["name", "full_name", "student_id", "qr_token", "no_sb", "no_bruhims", "bangsa", "ugama", "kerakyatan", "gender", "dob", "age", "level", "notes", "emergency_contact", "email", "alamat", "nama_ayah", "pekerjaan_ayah", "dob_ayah", "taraf_ayah", "no_telefon_ayah", "bangsa_ayah", "ugama_ayah", "kerakyatan_ayah", "nama_ibu", "pekerjaan_ibu", "dob_ibu", "taraf_ibu", "no_telefon_ibu", "bangsa_ibu", "ugama_ibu", "kerakyatan_ibu", "family_id", "yiuran_sekolah_paid", "yuran_pibg_paid", "insuran_paid", "photo_path", "photo_uploaded_at", "photo_uploaded_by", "photo_2_path", "photo_2_uploaded_at", "photo_2_uploaded_by", "photo_3_path", "photo_3_uploaded_at", "photo_3_uploaded_by", "photo_4_path", "photo_4_uploaded_at", "photo_4_uploaded_by", "photo_5_path", "photo_5_uploaded_at", "photo_5_uploaded_by", "photo_6_path", "photo_6_uploaded_at", "photo_6_uploaded_by", "class_id", "created_at"];
  const insertValues = { ...baseValues };
  const uploadedPhotoFiles = new Map(
    STUDENT_PHOTO_UPLOAD_FIELDS.map((field, index) => {
      const slot = index + 1;
      return [slot, getUploadedPhoto(req, field.name)];
    })
  );

  uploadedPhotoFiles.forEach((file, slot) => {
    const pathColumn = getPhotoColumnForSlot(slot);
    const uploadedAtColumn = getPhotoUploadedAtColumnForSlot(slot);
    const uploadedByColumn = getPhotoUploadedByColumnForSlot(slot);
    insertValues[pathColumn] = file ? normalizePhotoPath(file) : null;
    insertValues[uploadedAtColumn] = file ? now : null;
    insertValues[uploadedByColumn] = file ? (Number(req.session && req.session.user && req.session.user.id) || null) : null;
  });

  Object.assign(insertValues, {
    qr_token: createStudentQrToken(),
    class_id: classId,
    created_at: now
  });
  if (insertValues.family_id) {
    const familyAlreadyPaid = db
      .prepare("SELECT 1 FROM students WHERE family_id = ? AND yuran_pibg_paid = 1 LIMIT 1")
      .get(insertValues.family_id);
    if (familyAlreadyPaid) {
      insertValues.yuran_pibg_paid = 1;
    }
  }

  const info = db.prepare(
    `INSERT INTO students (${insertColumns.join(", ")})
     VALUES (${insertColumns.map(() => "?").join(", ")})`
  ).run(
    ...insertColumns.map((column) => (Object.prototype.hasOwnProperty.call(insertValues, column) ? insertValues[column] : null))
  );

  const newStudentPk = Number(info.lastInsertRowid);
  const linkSibling = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );
  const findByFamily = db.prepare("SELECT id FROM students WHERE family_id = ?");
  if (insertValues.family_id) {
    db.prepare("UPDATE students SET yuran_pibg_paid = ? WHERE family_id = ?").run(
      insertValues.yuran_pibg_paid,
      insertValues.family_id
    );
  }

  syncFamilyLinks(newStudentPk, insertValues.family_id, now, linkSibling, findByFamily);

  res.redirect("/admin/dashboard?success=Student+added");
});


router.post("/students/update/:studentPk", photoUpload.fields(STUDENT_PHOTO_UPLOAD_FIELDS), (req, res) => {
  const wantsJson = String(req.headers.accept || "").includes("application/json");

  function sendUpdateResponse(statusCode, payload, redirectUrl) {
    if (wantsJson) {
      return res.status(statusCode).json(payload);
    }
    return res.redirect(redirectUrl);
  }

  try {
    const studentPk = Number(req.params.studentPk);
    const classId = Number(req.body.class_id);
    const baseValues = buildStudentBaseValues(req.body, classId);

    if (!studentPk || !classId || !baseValues.student_id || !baseValues.name || !baseValues.full_name) {
      return sendUpdateResponse(
        400,
        { success: false, error: "Required fields missing" },
        `/admin/dashboard?error=Required+fields+missing&class_id=${classId || ""}&student_pk=${studentPk || ""}`
      );
    }

    const existing = db.prepare("SELECT id, photo_path, photo_uploaded_at, photo_uploaded_by, photo_2_path, photo_2_uploaded_at, photo_2_uploaded_by, photo_3_path, photo_3_uploaded_at, photo_3_uploaded_by, photo_4_path, photo_4_uploaded_at, photo_4_uploaded_by, photo_5_path, photo_5_uploaded_at, photo_5_uploaded_by, photo_6_path, photo_6_uploaded_at, photo_6_uploaded_by FROM students WHERE id = ?").get(studentPk);
    if (!existing) {
      return sendUpdateResponse(404, { success: false, error: "Student not found" }, "/admin/dashboard?error=Student+not+found");
    }

    const now = dayjs().toISOString();
    const classNameRow = db.prepare("SELECT name FROM classes WHERE id = ?").get(classId);
    const deleteSiblingLinks = db.prepare("DELETE FROM student_siblings WHERE student_pk = ? OR sibling_student_pk = ?");
    const linkSibling = db.prepare(
      `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
    );
    const findByFamily = db.prepare("SELECT id FROM students WHERE family_id = ?");
    const orderedColumns = ["name", "full_name", "student_id", "no_sb", "no_bruhims", "bangsa", "ugama", "kerakyatan", "gender", "dob", "age", "level", "notes", "emergency_contact", "email", "alamat", "nama_ayah", "pekerjaan_ayah", "dob_ayah", "taraf_ayah", "no_telefon_ayah", "bangsa_ayah", "ugama_ayah", "kerakyatan_ayah", "nama_ibu", "pekerjaan_ibu", "dob_ibu", "taraf_ibu", "no_telefon_ibu", "bangsa_ibu", "ugama_ibu", "kerakyatan_ibu", "family_id", "yiuran_sekolah_paid", "yuran_pibg_paid", "insuran_paid", "photo_path", "photo_uploaded_at", "photo_uploaded_by", "photo_2_path", "photo_2_uploaded_at", "photo_2_uploaded_by", "photo_3_path", "photo_3_uploaded_at", "photo_3_uploaded_by", "photo_4_path", "photo_4_uploaded_at", "photo_4_uploaded_by", "photo_5_path", "photo_5_uploaded_at", "photo_5_uploaded_by", "photo_6_path", "photo_6_uploaded_at", "photo_6_uploaded_by", "class_id"];
    const updateValues = { ...baseValues };
    const uploadedPhotoFiles = new Map(
      STUDENT_PHOTO_UPLOAD_FIELDS.map((field, index) => {
        const slot = index + 1;
        return [slot, getUploadedPhoto(req, field.name)];
      })
    );

    uploadedPhotoFiles.forEach((file, slot) => {
      const pathColumn = getPhotoColumnForSlot(slot);
      const uploadedAtColumn = getPhotoUploadedAtColumnForSlot(slot);
      const uploadedByColumn = getPhotoUploadedByColumnForSlot(slot);
      updateValues[pathColumn] = file ? normalizePhotoPath(file) : existing[pathColumn] || null;
      updateValues[uploadedAtColumn] = file ? now : existing[uploadedAtColumn] || null;
      updateValues[uploadedByColumn] = file ? (Number(req.session && req.session.user && req.session.user.id) || null) : existing[uploadedByColumn] || null;
    });

    const updateStudent = db.prepare(
      `UPDATE students
       SET ${orderedColumns.map((column) => `${column} = ?`).join(", ")}
       WHERE id = ?`
    );

    const tx = db.transaction(() => {
      updateStudent.run(
        ...orderedColumns.map((column) => (Object.prototype.hasOwnProperty.call(updateValues, column) ? updateValues[column] : null)),
        studentPk
      );

      if (updateValues.family_id) {
        db.prepare(
          `UPDATE students
           SET yuran_pibg_paid = ?
           WHERE family_id = ?`
        ).run(updateValues.yuran_pibg_paid, updateValues.family_id);
      }

      uploadedPhotoFiles.forEach((file, slot) => {
        if (!file) return;
        const pathColumn = getPhotoColumnForSlot(slot);
        if (existing[pathColumn] && existing[pathColumn] !== updateValues[pathColumn]) {
          removeManagedPhotoIfExists(existing[pathColumn]);
        }
      });

      deleteSiblingLinks.run(studentPk, studentPk);
      syncFamilyLinks(studentPk, updateValues.family_id, now, linkSibling, findByFamily);
    });

    tx();
    const className = classNameRow ? classNameRow.name : `Class ${classId}`;
    const successMsg = `Student updated: ${baseValues.name} (${baseValues.full_name}) in ${className}`;
    return sendUpdateResponse(
      200,
      { success: true, message: successMsg, studentId: studentPk, classId },
      `/admin/dashboard?success=${encodeURIComponent(successMsg)}&class_id=${encodeURIComponent(classId)}&student_pk=${encodeURIComponent(
        studentPk
      )}`
    );
  } catch (err) {
    const studentPk = Number(req.params.studentPk) || "";
    const classId = Number(req.body.class_id) || "";
    return sendUpdateResponse(
      500,
      { success: false, error: `Update failed: ${err.message}` },
      `/admin/dashboard?error=${encodeURIComponent(`Update failed: ${err.message}`)}&class_id=${classId}&student_pk=${studentPk}`
    );
  }
});

router.get("/backup/download", (req, res) => {
  createManualBackupDownload()
    .then((result) => {
      return res.download(result.zip_file_path, result.zip_file_name, () => {
        try { fs.unlinkSync(result.zip_file_path); } catch (_) {}
      });
    })
    .catch((err) => {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Manual backup download failed: ${err.message}`)}`);
    });
});

router.get("/backup/download-json", (req, res) => {
  const payload = makeBackupSnapshot();
  const fileName = `srkupang-backup-${dayjs().format("YYYYMMDD-HHmmss")}.json`;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
  res.send(JSON.stringify(payload, null, 2));
});

router.post("/attendance/reset", (req, res) => {
  try {
    const classId = Number(req.body.class_id || 0);
    const attendanceDate = String(req.body.attendance_date || '').trim();
    if (!classId || !attendanceDate) {
      return res.redirect('/admin/dashboard?error=Class+and+attendance+date+are+required');
    }

    const cls = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
    if (!cls) {
      return res.redirect('/admin/dashboard?error=Class+not+found');
    }

    const sessionIds = db.prepare('SELECT id FROM attendance_sessions WHERE class_id = ? AND attendance_date = ?').all(classId, attendanceDate).map((row) => Number(row.id));
    const deleteRecords = db.prepare('DELETE FROM attendance_records WHERE session_id = ?');
    const deleteSession = db.prepare('DELETE FROM attendance_sessions WHERE id = ?');
    const tx = db.transaction(() => {
      sessionIds.forEach((sessionId) => {
        deleteRecords.run(sessionId);
        deleteSession.run(sessionId);
      });
    });
    tx();

    return res.redirect('/admin/dashboard?success=Attendance+record+reset');
  } catch (error) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(error.message || 'Unable to reset attendance')}`);
  }
});

router.get("/attendance/export", (req, res) => {
  try {
    const classId = Number(req.query.class_id || 0);
    const attendanceDate = String(req.query.attendance_date || '').trim();
    if (!classId || !attendanceDate) return res.status(400).send('Class and attendance date are required');

    const cls = db.prepare('SELECT id, name FROM classes WHERE id = ?').get(classId);
    if (!cls) return res.status(404).send('Class not found');

    const rows = db.prepare(`
      SELECT
        c.name AS class_name,
        s.full_name,
        ans.session_type,
        ans.recorded_at AS updated_at,
        COALESCE(u.display_name, u.username, 'System') AS updated_by,
        ar.is_present,
        COALESCE(ar.absence_reason, '') AS absence_reason
      FROM students s
      JOIN classes c ON c.id = s.class_id
      LEFT JOIN attendance_records ar ON ar.student_id = s.id
      LEFT JOIN attendance_sessions ans ON ans.id = ar.session_id AND ans.class_id = s.class_id AND ans.attendance_date = ?
      LEFT JOIN users u ON u.id = ans.recorded_by
      WHERE s.class_id = ?
      ORDER BY s.full_name ASC,
               CASE ans.session_type WHEN 'morning' THEN 1 WHEN 'afternoon' THEN 2 ELSE 3 END ASC
    `).all(attendanceDate, classId);

    const header = 'class_name,attendance_date,full_name,session,updated_at,updated_by,status,absence_reason';
    const csvRows = rows.map((row) => {
      const values = [
        row.class_name,
        attendanceDate,
        row.full_name,
        row.session_type || '',
        row.updated_at || '',
        row.updated_by || '',
        Number(row.is_present) === 1 ? 'Present' : 'Absent',
        row.absence_reason || ''
      ].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`);
      return values.join(',');
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance-${classId}-${attendanceDate}.csv`);
    return res.send([header, ...csvRows].join('\n'));
  } catch (error) {
    return res.status(500).send(error.message || 'Unable to export attendance');
  }
});

router.get("/students/export", async (req, res) => {
  try {
    const scope = String(req.query.scope || "school").trim().toLowerCase();
    const selectedClassId = Number(req.query.class_id || 0);
    const selectedGender = normalizeGender(req.query.gender);
    const validScopes = new Set(["school", "class", "gender"]);
    if (!validScopes.has(scope)) {
      return res.status(400).send("Invalid export scope");
    }
    if (scope === "class" && !selectedClassId) {
      return res.status(400).send("Class is required for class export");
    }
    if (scope === "gender" && !selectedGender) {
      return res.status(400).send("Gender is required for gender export");
    }

    const where = [];
    const params = [];
    let fileSuffix = "whole-school";

    if (scope === "class") {
      const cls = db.prepare("SELECT id, name FROM classes WHERE id = ?").get(selectedClassId);
      if (!cls) return res.status(404).send("Class not found");
      where.push("s.class_id = ?");
      params.push(selectedClassId);
      fileSuffix = sanitizeFilenameSegment(normalizeClassName(cls.name), "class");
    } else if (scope === "gender") {
      where.push("LOWER(COALESCE(s.gender, '')) = ?");
      params.push(String(selectedGender).toLowerCase());
      fileSuffix = sanitizeFilenameSegment(selectedGender, "gender");
    }

    const rows = db.prepare(`
      SELECT
        s.*,
        c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC
    `).all(...params);

    const extraHeaders = ["QR CODE PAYLOAD", "QR CODE IMAGE"];
    const header = [...STUDENT_TEMPLATE_COLUMNS.map((column) => csvEscape(column.header)), ...extraHeaders.map(csvEscape)].join(",");
    const csvRows = await Promise.all(rows.map(async (row) => {
      const qrCodeImage = await generateStudentQrDataUrl(row);
      const valueByKey = {
        ...row,
        class_name: normalizeClassName(row.class_name) || "",
        dob: formatStudentExportDate(row.dob),
        dob_ayah: formatStudentExportDate(row.dob_ayah),
        dob_ibu: formatStudentExportDate(row.dob_ibu),
        yiuran_sekolah_paid: formatCheckboxStatus(row.yiuran_sekolah_paid),
        yuran_pibg_paid: formatCheckboxStatus(row.yuran_pibg_paid),
        insuran_paid: formatCheckboxStatus(row.insuran_paid)
      };
      const studentColumns = STUDENT_TEMPLATE_COLUMNS.map((column) => {
        if (!column.key) return csvEscape("");
        return csvEscape(valueByKey[column.key] == null ? "" : valueByKey[column.key]);
      });
      return [
        ...studentColumns,
        csvEscape(buildStudentQrPayload(row)),
        csvEscape(qrCodeImage)
      ].join(",");
    }));

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=student-details-${fileSuffix}.csv`);
    return res.send([header, ...csvRows].join("\n"));
  } catch (error) {
    return res.status(500).send(error.message || "Unable to export student details");
  }
});

router.get("/students/qr-codes/download", async (req, res) => {
  try {
    const scope = String(req.query.scope || "school").trim().toLowerCase();
    const selectedClassId = Number(req.query.class_id || 0);
    if (!["school", "class"].includes(scope)) {
      return res.status(400).send("Invalid QR download scope");
    }
    if (scope === "class" && !selectedClassId) {
      return res.status(400).send("Class is required for class QR download");
    }

    const where = [];
    const params = [];
    let fileSuffix = "whole-school";

    if (scope === "class") {
      const cls = db.prepare("SELECT id, name FROM classes WHERE id = ?").get(selectedClassId);
      if (!cls) return res.status(404).send("Class not found");
      where.push("s.class_id = ?");
      params.push(selectedClassId);
      fileSuffix = sanitizeFilenameSegment(normalizeClassName(cls.name), "class");
    }

    const rows = db.prepare(`
      SELECT
        s.id,
        s.student_id,
        s.qr_token,
        s.full_name,
        COALESCE(NULLIF(s.name, ''), s.full_name) AS name,
        s.no_sb,
        c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC
    `).all(...params);

    if (!rows.length) {
      return res.status(404).send("No students found for QR code download");
    }

    const zipFiles = await buildStudentQrZipFiles(rows, scope);
    const zipBuffer = createStoredZip(zipFiles);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=student-qr-codes-${fileSuffix}.zip`);
    return res.send(zipBuffer);
  } catch (error) {
    return res.status(500).send(error.message || "Unable to download student QR codes");
  }
});

router.post("/kiosk/reward-rules/add", (req, res) => {
  try {
    const label = String(req.body.label || "").trim();
    const startTime = normalizeTimeValue(req.body.start_time);
    const endTime = normalizeTimeValue(req.body.end_time);
    const points = Number.parseInt(String(req.body.points || "").trim(), 10);
    const isActive = String(req.body.is_active || "1") === "1" ? 1 : 0;
    if (!label || !startTime || !endTime || !Number.isInteger(points)) {
      return res.redirect("/admin/dashboard?error=Complete+all+kiosk+reward+rule+fields");
    }
    const now = dayjs().toISOString();
    db.prepare(`
      INSERT INTO kiosk_reward_rules (label, start_time, end_time, points, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(label, startTime, endTime, points, isActive, now, now);
    return res.redirect("/admin/dashboard?success=Kiosk+reward+rule+added");
  } catch (error) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(error.message || "Unable to add kiosk reward rule")}`);
  }
});

router.post("/kiosk/reward-rules/:ruleId/update", (req, res) => {
  try {
    const ruleId = Number(req.params.ruleId || 0);
    const label = String(req.body.label || "").trim();
    const startTime = normalizeTimeValue(req.body.start_time);
    const endTime = normalizeTimeValue(req.body.end_time);
    const points = Number.parseInt(String(req.body.points || "").trim(), 10);
    const isActive = String(req.body.is_active || "0") === "1" ? 1 : 0;
    if (!ruleId || !label || !startTime || !endTime || !Number.isInteger(points)) {
      return res.redirect("/admin/dashboard?error=Invalid+kiosk+reward+rule+update");
    }
    const existing = db.prepare("SELECT id FROM kiosk_reward_rules WHERE id = ?").get(ruleId);
    if (!existing) {
      return res.redirect("/admin/dashboard?error=Kiosk+reward+rule+not+found");
    }
    db.prepare(`
      UPDATE kiosk_reward_rules
      SET label = ?, start_time = ?, end_time = ?, points = ?, is_active = ?, updated_at = ?
      WHERE id = ?
    `).run(label, startTime, endTime, points, isActive, dayjs().toISOString(), ruleId);
    return res.redirect("/admin/dashboard?success=Kiosk+reward+rule+updated");
  } catch (error) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(error.message || "Unable to update kiosk reward rule")}`);
  }
});

router.post("/kiosk/reward-rules/:ruleId/delete", (req, res) => {
  try {
    const ruleId = Number(req.params.ruleId || 0);
    if (!ruleId) return res.redirect("/admin/dashboard?error=Kiosk+reward+rule+not+found");
    db.prepare("DELETE FROM kiosk_reward_rules WHERE id = ?").run(ruleId);
    return res.redirect("/admin/dashboard?success=Kiosk+reward+rule+deleted");
  } catch (error) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(error.message || "Unable to delete kiosk reward rule")}`);
  }
});

router.post("/backup/save-path", (req, res) => {
  const settings = getBackupDashboardData().settings;
  runBackup({
    trigger_type: "manual",
    destination_path: settings.destination_path,
    actor_user_id: req.session && req.session.user ? req.session.user.id : null
  })
    .then((result) => {
      return res.redirect(`/admin/dashboard?success=${encodeURIComponent(`Backup saved to ${result.backup_path}`)}`);
    })
    .catch((err) => {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Backup failed: ${err.message}`)}`);
    });
});

router.post("/leaderboard/slideshow-duration", (req, res) => {
  try {
    const durationMs = setLeaderboardSlideshowDurationSeconds(
      req.body.duration_seconds,
      req.session && req.session.user ? req.session.user.id : null
    );
    return res.redirect(`/admin/dashboard?success=${encodeURIComponent(`PITIS Leaders slide duration saved: ${durationMs / 1000} seconds`)}`);
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Slideshow settings update failed: ${err.message}`)}`);
  }
});

router.post("/backup/settings", (req, res) => {
  try {
    updateBackupSettings({
      destination_path: req.body.destination_path,
      updated_by: req.session && req.session.user ? req.session.user.id : null
    });
    return res.redirect("/admin/dashboard?success=Backup+folder+saved+and+verified");
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Backup settings failed: ${err.message}`)}`);
  }
});

router.post("/backup/run-now", (req, res) => {
  const settings = getBackupDashboardData().settings;
  runBackup({
    trigger_type: "manual",
    destination_path: settings.destination_path,
    actor_user_id: req.session && req.session.user ? req.session.user.id : null
  })
    .then((result) => {
      return res.redirect(`/admin/dashboard?success=${encodeURIComponent(`Manual backup completed: ${result.backup_path}`)}`);
    })
    .catch((err) => {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Manual backup failed: ${err.message}`)}`);
    });
});

router.get("/backup/saved/:backupName/download", (req, res) => {
  try {
    const settings = getBackupDashboardData().settings;
    const result = createSavedBackupDownload(req.params.backupName, settings.destination_path);
    return res.download(result.zip_file_path, result.zip_file_name, () => {
      if (fs.existsSync(result.zip_file_path)) {
        try { fs.unlinkSync(result.zip_file_path); } catch (_) {}
      }
    });
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Backup download failed: ${err.message}`)}`);
  }
});

router.post("/backup/saved/:backupName/delete", (req, res) => {
  try {
    const settings = getBackupDashboardData().settings;
    const result = deleteSavedBackup(req.params.backupName, settings.destination_path);
    return res.redirect(`/admin/dashboard?success=${encodeURIComponent(`Deleted backup ${result.backup_name}`)}`);
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Delete backup failed: ${err.message}`)}`);
  }
});

router.post("/backup/restore", uploadRestore.single("backup_file"), async (req, res) => {
  let uploadsRestore = null;
  const cleanupUploadedFile = () => {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  };
  try {
    if (!req.file) {
      return res.redirect("/admin/dashboard?error=Backup+file+is+required");
    }

    const uploadedName = String(req.file.originalname || "").toLowerCase();
    let payload;
    if (uploadedName.endsWith(".zip")) {
      const archive = preparePortableBackupArchiveRestore(req.file.path);
      payload = archive.payload;
      uploadsRestore = archive.uploadsRestore;
    } else {
      const rawBackup = fs.readFileSync(req.file.path, "utf8").trim();
      if (!rawBackup) {
        cleanupUploadedFile();
        return res.redirect("/admin/dashboard?error=Selected+backup+file+is+empty");
      }
      if (uploadedName === "backup-manifest.json") {
        cleanupUploadedFile();
        return res.redirect("/admin/dashboard?error=Please+restore+using+the+portable+ZIP+or+snapshot.json,+not+backup-manifest.json");
      }
      try {
        payload = JSON.parse(rawBackup);
      } catch (parseError) {
        cleanupUploadedFile();
        return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Invalid backup file: ${parseError.message}. Choose a portal backup ZIP or snapshot.json.`)}`);
      }
    }

    if (!ensureValidBackupPayload(payload)) {
      cleanupUploadedFile();
      return res.redirect("/admin/dashboard?error=Invalid+backup+format.+Choose+a+portal+backup+ZIP+or+snapshot.json");
    }
    cleanupUploadedFile();

    const backupSettings = getBackupDashboardData().settings;
    await runBackup({
      trigger_type: "manual",
      destination_path: backupSettings.destination_path,
      actor_user_id: req.session && req.session.user ? req.session.user.id : null
    });

    const tx = db.transaction((backupData) => {
      db.exec("DELETE FROM admin_action_logs");
      db.exec("DELETE FROM student_academic_history");
      db.exec("DELETE FROM academic_year_rollover_runs");
      db.exec("DELETE FROM point_logs");
      db.exec("DELETE FROM daily_points");
      db.exec("DELETE FROM teacher_usage_weekly_audits");
      db.exec("DELETE FROM teacher_usage_audit_runs");
      db.exec("DELETE FROM rewards_gallery");
      db.exec("DELETE FROM kiosk_scan_logs");
      db.exec("DELETE FROM kiosk_reward_rules");
      db.exec("DELETE FROM qr_quiz_response_answers");
      db.exec("DELETE FROM qr_quiz_responses");
      db.exec("DELETE FROM qr_quiz_target_classes");
      db.exec("DELETE FROM qr_quiz_questions");
      db.exec("DELETE FROM qr_quizzes");
      db.exec("DELETE FROM attendance_records");
      db.exec("DELETE FROM attendance_sessions");
      db.exec("DELETE FROM attendance_logs");
      db.exec("DELETE FROM device_bookings");
      db.exec("DELETE FROM inventory_detail_values");
      db.exec("DELETE FROM inventory_documents");
      db.exec("DELETE FROM school_inventory");
      db.exec("DELETE FROM inventory_detail_fields");
      db.exec("DELETE FROM inventory_availability_options");
      db.exec("DELETE FROM inventory_conditions");
      db.exec("DELETE FROM inventory_categories");
      db.exec("DELETE FROM inventory_locations");
      db.exec("DELETE FROM devices");
      db.exec("DELETE FROM device_venues");
      db.exec("DELETE FROM device_locations");
      db.exec("DELETE FROM information_files");
      db.exec("DELETE FROM info_folders");
      db.exec("DELETE FROM photo_activity_logs");
      db.exec("DELETE FROM photo_files");
      db.exec("DELETE FROM photo_folders");
      db.exec("DELETE FROM catatan_harian_report_items");
      db.exec("DELETE FROM catatan_harian_reports");
      db.exec("DELETE FROM catatan_harian_checklist_items");
      db.exec("DELETE FROM student_siblings");
      db.exec("DELETE FROM student_edit_logs");
      db.exec("DELETE FROM students");
      db.exec("DELETE FROM point_reasons");
      db.exec("DELETE FROM calendar_school_days");
      db.exec("DELETE FROM calendar_event_users");
      db.exec("DELETE FROM calendar_event_labels");
      db.exec("DELETE FROM calendar_labels");
      db.exec("DELETE FROM calendar_events");
      db.exec("DELETE FROM user_login_logs");
      db.exec("DELETE FROM app_settings");
      db.exec("DELETE FROM classes");
      db.exec("DELETE FROM users");

      insertRows("users", BACKUP_TABLES.users, backupData.users);
      insertRows("app_settings", BACKUP_TABLES.app_settings, backupData.app_settings || []);
      insertRows("classes", BACKUP_TABLES.classes, backupData.classes);
      insertRows("academic_year_rollover_runs", BACKUP_TABLES.academic_year_rollover_runs, backupData.academic_year_rollover_runs || []);
      insertRows("students", BACKUP_TABLES.students, backupData.students);
      insertRows("student_academic_history", BACKUP_TABLES.student_academic_history, backupData.student_academic_history || []);
      insertRows("admin_action_logs", BACKUP_TABLES.admin_action_logs, backupData.admin_action_logs || []);
      insertRows("student_siblings", BACKUP_TABLES.student_siblings, backupData.student_siblings);
      insertRows("student_edit_logs", BACKUP_TABLES.student_edit_logs, backupData.student_edit_logs || []);
      insertRows("catatan_harian_checklist_items", BACKUP_TABLES.catatan_harian_checklist_items, backupData.catatan_harian_checklist_items || []);
      insertRows("catatan_harian_reports", BACKUP_TABLES.catatan_harian_reports, backupData.catatan_harian_reports || []);
      insertRows("catatan_harian_report_items", BACKUP_TABLES.catatan_harian_report_items, backupData.catatan_harian_report_items || []);
      ensureCatatanHarianChecklistAfterRestore();
      insertRows("point_reasons", BACKUP_TABLES.point_reasons, backupData.point_reasons);
      insertRows("point_logs", BACKUP_TABLES.point_logs, backupData.point_logs);
      insertRows("daily_points", BACKUP_TABLES.daily_points, backupData.daily_points);
      insertRows("kiosk_reward_rules", BACKUP_TABLES.kiosk_reward_rules, backupData.kiosk_reward_rules || []);
      insertRows("kiosk_scan_logs", BACKUP_TABLES.kiosk_scan_logs, backupData.kiosk_scan_logs || []);
      insertRows("qr_quizzes", BACKUP_TABLES.qr_quizzes, backupData.qr_quizzes || []);
      insertRows("qr_quiz_questions", BACKUP_TABLES.qr_quiz_questions, backupData.qr_quiz_questions || []);
      insertRows("qr_quiz_target_classes", BACKUP_TABLES.qr_quiz_target_classes, backupData.qr_quiz_target_classes || []);
      insertRows("qr_quiz_responses", BACKUP_TABLES.qr_quiz_responses, backupData.qr_quiz_responses || []);
      insertRows("qr_quiz_response_answers", BACKUP_TABLES.qr_quiz_response_answers, backupData.qr_quiz_response_answers || []);
      insertRows("rewards_gallery", BACKUP_TABLES.rewards_gallery, backupData.rewards_gallery || []);
      insertRows("calendar_events", BACKUP_TABLES.calendar_events, backupData.calendar_events);
      insertRows("calendar_labels", BACKUP_TABLES.calendar_labels, backupData.calendar_labels || []);
      insertRows("calendar_event_labels", BACKUP_TABLES.calendar_event_labels, backupData.calendar_event_labels || []);
      insertRows("calendar_event_users", BACKUP_TABLES.calendar_event_users, backupData.calendar_event_users || []);
      insertRows("calendar_school_days", BACKUP_TABLES.calendar_school_days, backupData.calendar_school_days || []);
      insertRows("user_login_logs", BACKUP_TABLES.user_login_logs, backupData.user_login_logs || []);
      insertRows("teacher_usage_audit_runs", BACKUP_TABLES.teacher_usage_audit_runs, backupData.teacher_usage_audit_runs || []);
      insertRows("teacher_usage_weekly_audits", BACKUP_TABLES.teacher_usage_weekly_audits, backupData.teacher_usage_weekly_audits || []);
      insertRows("attendance_logs", BACKUP_TABLES.attendance_logs, backupData.attendance_logs || []);
      insertRows("attendance_sessions", BACKUP_TABLES.attendance_sessions, backupData.attendance_sessions || []);
      insertRows("attendance_records", BACKUP_TABLES.attendance_records, backupData.attendance_records || []);
      insertRows("device_locations", BACKUP_TABLES.device_locations, backupData.device_locations || []);
      insertRows("device_venues", BACKUP_TABLES.device_venues, backupData.device_venues || []);
      insertRows("devices", BACKUP_TABLES.devices, backupData.devices || []);
      insertRows("inventory_locations", BACKUP_TABLES.inventory_locations, backupData.inventory_locations || []);
      insertRows("inventory_categories", BACKUP_TABLES.inventory_categories, backupData.inventory_categories || []);
      insertRows("inventory_conditions", BACKUP_TABLES.inventory_conditions, backupData.inventory_conditions || []);
      insertRows("inventory_availability_options", BACKUP_TABLES.inventory_availability_options, backupData.inventory_availability_options || []);
      insertRows("inventory_detail_fields", BACKUP_TABLES.inventory_detail_fields, backupData.inventory_detail_fields || []);
      insertRows("school_inventory", BACKUP_TABLES.school_inventory, backupData.school_inventory || []);
      insertRows("inventory_documents", BACKUP_TABLES.inventory_documents, backupData.inventory_documents || []);
      insertRows("inventory_detail_values", BACKUP_TABLES.inventory_detail_values, backupData.inventory_detail_values || []);
      ensureInventoryOptionsAfterRestore();
      ensureInventoryDetailFieldsAfterRestore();
      insertRows("device_bookings", BACKUP_TABLES.device_bookings, backupData.device_bookings || []);
      insertRows("info_folders", BACKUP_TABLES.info_folders, backupData.info_folders || []);
      insertRows("information_files", BACKUP_TABLES.information_files, backupData.information_files || []);
      insertRows("photo_folders", BACKUP_TABLES.photo_folders, backupData.photo_folders || []);
      insertRows("photo_files", BACKUP_TABLES.photo_files, backupData.photo_files || []);
      insertRows("photo_activity_logs", BACKUP_TABLES.photo_activity_logs, backupData.photo_activity_logs || []);

      db.exec("DELETE FROM sqlite_sequence");
      for (const [table, rows] of Object.entries(backupData)) {
        const maxId = rows.reduce((max, r) => Math.max(max, Number(r.id || 0)), 0);
        if (maxId > 0) {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, maxId);
        }
      }

      assertNoRestoreForeignKeyViolations();
    });

    db.pragma("foreign_keys = OFF");
    try {
      tx(payload.data);
    } finally {
      db.pragma("foreign_keys = ON");
    }
    if (uploadsRestore) uploadsRestore.commit();
    if (uploadsRestore) uploadsRestore.cleanup();

    req.session.destroy(() => {
      res.redirect("/login");
    });
  } catch (err) {
    cleanupUploadedFile();
    if (uploadsRestore) uploadsRestore.cleanup();
    res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Restore failed: ${err.message}`)}`);
  }
});

router.get("/reports/admin-audit/export", (req, res) => {
  const filters = {
    search: String(req.query.audit_search || "").trim(),
    result: String(req.query.audit_result || "").trim(),
    dateFrom: String(req.query.audit_from || "").trim(),
    dateTo: String(req.query.audit_to || "").trim()
  };
  const rows = getAdminAuditRows(filters, 5000);
  const headers = ["Date and Time", "Administrator", "User ID", "Action", "Target", "Result", "Status", "Request", "IP Address", "Duration ms", "Safe Details"];
  const csv = [headers, ...rows.map((row) => [
    row.created_at, row.display_name, row.username, row.action_label, row.target_label,
    row.result, row.response_status, `${row.request_method} ${row.request_path}`, row.ip_address,
    row.duration_ms, JSON.stringify(row.details)
  ])].map((line) => line.map(csvEscape).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=administrator-audit-${dayjs().format("YYYY-MM-DD")}.csv`);
  return res.send(`\uFEFF${csv}`);
});

router.post("/academic-year/rollover", async (req, res) => {
  let targetYear;
  try {
    targetYear = normalizeYear(req.body.target_year);
    const backup = await runBackup({ trigger_type: "manual" });
    const result = applyAcademicYearRollover({
      targetYear,
      confirmation: req.body.confirmation,
      resetFees: req.body.reset_fees === "1",
      backupPath: backup.backup_path,
      userId: req.session.user.id
    });
    const message = `Academic year ${targetYear} opened: ${result.promoted} students promoted and ${result.graduated} YEAR 6 students archived in ${result.alumniName}. Safety backup: ${backup.backup_path}`;
    return res.redirect(`/admin/dashboard?success=${encodeURIComponent(message)}&rollover_year=${targetYear}`);
  } catch (error) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Academic-year rollover failed: ${error.message}`)}${targetYear ? `&rollover_year=${targetYear}` : ""}`);
  }
});

router.post("/calendar/delete/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.redirect("/admin/dashboard?error=Invalid+event+ID");

  const target = db.prepare("SELECT id, event_source FROM calendar_events WHERE id = ? AND is_deleted = 0").get(eventId);
  if (!target) return res.redirect("/admin/dashboard?error=Event+not+found");
  if ((target.event_source || "manual") !== "manual") {
    return res.redirect("/admin/dashboard?error=System+events+cannot+be+deleted");
  }

  db.prepare(
    `UPDATE calendar_events
     SET is_deleted = 1, deleted_by = ?, deleted_at = ?
     WHERE id = ? AND is_deleted = 0`
  ).run(req.session.user.id, dayjs().toISOString(), eventId);

  return res.redirect("/admin/dashboard?success=Event+deleted");
});

router.post("/school-calendar/day/update", (req, res) => {
  const returnParams = new URLSearchParams();
  ["sip_month", "sip_term", "sip_type"].forEach((key) => {
    if (req.body[key]) returnParams.set(key, String(req.body[key]));
  });
  try {
    updateSchoolCalendarDay(req.body, req.session.user.id);
    returnParams.set("success", "SIP school calendar date updated");
  } catch (error) {
    returnParams.set("error", error.message || "Unable to update SIP school calendar date");
  }
  return res.redirect(`/admin/dashboard?${returnParams.toString()}`);
});

router.post("/calendar/add", (req, res) => {
  const title = String(req.body.title || "").trim();
  const details = String(req.body.details || "").trim();
  const eventDate = String(req.body.event_date || "").trim();
  const endDate = String(req.body.end_date || eventDate).trim();
  const labelIds = parseCalendarLabelIds(req.body.label_ids);

  if (!title || !eventDate) {
    return res.redirect("/admin/dashboard?error=Title+and+start+date+are+required");
  }
  if (dayjs(endDate).isBefore(dayjs(eventDate), "day")) {
    return res.redirect("/admin/dashboard?error=End+date+cannot+be+earlier+than+start+date");
  }

  const now = dayjs().toISOString();
  const info = db.prepare(`
    INSERT INTO calendar_events
      (title, details, event_date, end_date, event_source, created_by, created_at, is_deleted,
       event_type, editable_flag)
    VALUES (?, ?, ?, ?, 'manual', ?, ?, 0, 'school_event', 1)
  `).run(title, details, eventDate, endDate, req.session.user.id, now);
  assignCalendarEventLabels(Number(info.lastInsertRowid), labelIds);

  return res.redirect("/admin/dashboard?success=School+event+added");
});

router.post("/calendar/update/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  const title = String(req.body.title || "").trim();
  const details = String(req.body.details || "").trim();
  const eventDate = String(req.body.event_date || "").trim();
  const endDate = String(req.body.end_date || eventDate).trim();
  const labelIds = parseCalendarLabelIds(req.body.label_ids);

  if (!eventId || !title || !eventDate) {
    return res.redirect("/admin/dashboard?error=Event+ID%2C+title+and+start+date+are+required");
  }
  if (dayjs(endDate).isBefore(dayjs(eventDate), "day")) {
    return res.redirect("/admin/dashboard?error=End+date+cannot+be+earlier+than+start+date");
  }

  const target = db.prepare("SELECT id FROM calendar_events WHERE id = ? AND is_deleted = 0 AND event_source = 'manual'").get(eventId);
  if (!target) {
    return res.redirect("/admin/dashboard?error=Only+manual+active+events+can+be+edited");
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE calendar_events
      SET title = ?, details = ?, event_date = ?, end_date = ?
      WHERE id = ? AND is_deleted = 0 AND event_source = 'manual'
    `).run(title, details, eventDate, endDate, eventId);
    assignCalendarEventLabels(eventId, labelIds);
  });
  tx();

  return res.redirect("/admin/dashboard?success=Event+updated");
});

router.post("/events/purge/:eventId", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.redirect("/admin/dashboard?error=Invalid+event+ID");

  db.prepare("DELETE FROM calendar_events WHERE id = ? AND is_deleted = 1").run(eventId);
  return res.redirect("/admin/dashboard?success=Deleted+event+removed+permanently");
});

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function buildInClause(values) {
  const placeholders = values.map(() => "?").join(", ");
  return `(${placeholders})`;
}

router.post("/points/reset", (req, res) => {
  try {
    const selectedClassId = Number(req.body.class_id || 0);
    const includeAllStudents = String(req.body.scope_all_students || "") === "1";
    const includeWholeClassRaw = String(req.body.scope_whole_class || "") === "1";
    const includeSelectedStudentsRaw = String(req.body.scope_selected_students || "") === "1";
    const includeWholeClass = !includeAllStudents && includeWholeClassRaw;
    const includeSelectedStudents = !includeAllStudents && includeSelectedStudentsRaw;
    const selectedStudentsRaw = req.body.selected_students;
    const includeAllTime = String(req.body.filter_all_time || "") === "1";
    const includeSpecificDate = String(req.body.filter_specific_date || "") === "1";
    const includeDateRange = String(req.body.filter_date_range || "") === "1";
    const selectedDate = String(req.body.selected_date || "").trim();
    let rangeStart = String(req.body.range_start || "").trim();
    let rangeEnd = String(req.body.range_end || "").trim();

    if (!includeAllStudents && !includeWholeClass && !includeSelectedStudents) {
      return res.redirect("/admin/dashboard?error=Select+at+least+one+target+scope");
    }
    if ((includeWholeClass || includeSelectedStudents) && !selectedClassId) {
      return res.redirect("/admin/dashboard?error=Class+is+required+for+point+reset");
    }
    if (!includeAllTime && !includeSpecificDate && !includeDateRange) {
      return res.redirect("/admin/dashboard?error=Select+at+least+one+time+filter");
    }

    const targetStudentIds = new Set();
    if (includeAllStudents) {
      const allStudents = db.prepare("SELECT id FROM students").all();
      allStudents.forEach((s) => targetStudentIds.add(Number(s.id)));
    }
    if (includeWholeClass) {
      const classStudents = db.prepare("SELECT id FROM students WHERE class_id = ?").all(selectedClassId);
      classStudents.forEach((s) => targetStudentIds.add(Number(s.id)));
    }
    if (includeSelectedStudents) {
      const normalized = Array.isArray(selectedStudentsRaw)
        ? selectedStudentsRaw
        : (selectedStudentsRaw ? [selectedStudentsRaw] : []);
      const isStudentInClass = db.prepare("SELECT id FROM students WHERE id = ? AND class_id = ? LIMIT 1");
      normalized
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0)
        .forEach((v) => {
          if (includeAllStudents || isStudentInClass.get(v, selectedClassId)) {
            targetStudentIds.add(v);
          }
        });
    }

    const targetIds = Array.from(targetStudentIds);
    if (!targetIds.length) {
      return res.redirect("/admin/dashboard?error=No+students+matched+the+selected+scope");
    }

    const studentWhere = `student_id IN ${buildInClause(targetIds)}`;
    const timeConditions = [];
    const timeArgs = [];

    if (includeSpecificDate) {
      if (!isValidIsoDate(selectedDate)) {
        return res.redirect("/admin/dashboard?error=Valid+specific+date+is+required+%28YYYY-MM-DD%29");
      }
      timeConditions.push("date(awarded_at) = ?");
      timeArgs.push(selectedDate);
    }
    if (includeDateRange) {
      if (!isValidIsoDate(rangeStart) || !isValidIsoDate(rangeEnd)) {
        return res.redirect("/admin/dashboard?error=Valid+date+range+is+required+%28YYYY-MM-DD%29");
      }
      if (rangeStart > rangeEnd) {
        const temp = rangeStart;
        rangeStart = rangeEnd;
        rangeEnd = temp;
      }
      timeConditions.push("date(awarded_at) BETWEEN ? AND ?");
      timeArgs.push(rangeStart, rangeEnd);
    }

    const whereSql = includeAllTime
      ? studentWhere
      : `${studentWhere} AND (${timeConditions.join(" OR ")})`;
    const whereArgs = includeAllTime ? [...targetIds] : [...targetIds, ...timeArgs];

    const selectAffectedStudents = db.prepare(`SELECT DISTINCT student_id FROM point_logs WHERE ${whereSql}`);
    const countTargetLogs = db.prepare(`SELECT COUNT(*) AS total FROM point_logs WHERE ${whereSql}`);
    const deleteTargetLogs = db.prepare(`DELETE FROM point_logs WHERE ${whereSql}`);
    const deleteDailyForStudents = db.prepare(`DELETE FROM daily_points WHERE student_id IN ${buildInClause(targetIds)}`);
    const rebuildDailyForStudents = db.prepare(
      `INSERT INTO daily_points (snapshot_date, student_id, total_points, last_updated_at)
       SELECT date(awarded_at) AS snapshot_date, student_id, SUM(points) AS total_points, ? AS last_updated_at
       FROM point_logs
       WHERE student_id IN ${buildInClause(targetIds)}
       GROUP BY date(awarded_at), student_id`
    );

    const nowIso = dayjs().toISOString();
    const tx = db.transaction(() => {
      const beforeCount = Number(countTargetLogs.get(...whereArgs).total || 0);
      const affectedStudents = selectAffectedStudents.all(...whereArgs).map((r) => Number(r.student_id));
      deleteTargetLogs.run(...whereArgs);
      deleteDailyForStudents.run(...targetIds);
      rebuildDailyForStudents.run(nowIso, ...targetIds);
      return { beforeCount, affectedStudentCount: affectedStudents.length };
    });

    const result = tx();
    const selectedScopes = [
      includeAllStudents ? "all students" : null,
      includeWholeClass ? `class ${selectedClassId}` : null,
      includeSelectedStudents ? "selected students" : null
    ].filter(Boolean).join(", ");
    const selectedTime = includeAllTime
      ? "all time"
      : [
          includeSpecificDate ? `date ${selectedDate}` : null,
          includeDateRange ? `range ${rangeStart} to ${rangeEnd}` : null
        ].filter(Boolean).join(" OR ");
    const success = `Points reset complete. Deleted ${result.beforeCount} log entries for ${result.affectedStudentCount} student(s). Scope: ${selectedScopes}. Time: ${selectedTime}.`;
    return res.redirect(`/admin/dashboard?success=${encodeURIComponent(success)}&class_id=${encodeURIComponent(selectedClassId)}`);
  } catch (err) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Point reset failed: ${err.message}`)}`);
  }
});
router.use((err, req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    return res.redirect("/admin/dashboard?error=" + encodeURIComponent("Upload failed: " + err.message));
  }
  if (String(err.message || "").includes("Only image files are allowed")) {
    return res.redirect("/admin/dashboard?error=" + encodeURIComponent("Upload failed: only image files are allowed"));
  }

  if (String(err.message || "").includes("Only PDF files are allowed")) {
    return res.redirect("/admin/dashboard?error=" + encodeURIComponent("Upload failed: only PDF files are allowed"));
  }
  return next(err);
});
module.exports = router;









