const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const dayjs = require("dayjs");
const { db } = require("../db/init");

const CALENDAR_UPLOADS_FOLDER = "Calendar uploads";
const INFORMATION_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "informations");
const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".csv", ".txt", ".jpg", ".jpeg", ".png", ".webp"
]);

fs.mkdirSync(INFORMATION_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, INFORMATION_UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    const base = path.basename(file.originalname || "calendar-file", extension)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80) || "calendar-file";
    callback(null, `${base}-${crypto.randomUUID()}${extension}`);
  }
});

const calendarAttachmentUpload = multer({
  storage,
  limits: { files: 10, fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (ALLOWED_EXTENSIONS.has(extension)) return callback(null, true);
    return callback(new Error("Unsupported calendar attachment type"));
  }
}).array("calendar_attachments", 10);

function removeUploadedCalendarFiles(files = []) {
  for (const file of files) {
    const filePath = path.resolve(String(file.path || ""));
    if (!filePath.startsWith(path.resolve(INFORMATION_UPLOAD_DIR) + path.sep)) continue;
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

function ensureCalendarUploadsFolder() {
  const existing = db.prepare("SELECT id FROM info_folders WHERE LOWER(name) = LOWER(?)").get(CALENDAR_UPLOADS_FOLDER);
  if (existing) return Number(existing.id);
  const maxRow = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS maximum FROM info_folders").get();
  return Number(db.prepare(`
    INSERT INTO info_folders (name, created_at, sort_order)
    VALUES (?, ?, ?)
  `).run(CALENDAR_UPLOADS_FOLDER, dayjs().toISOString(), Number(maxRow.maximum || 0) + 1).lastInsertRowid);
}

function saveCalendarAttachments(eventId, eventTitle, files, uploadedBy) {
  const attachments = Array.isArray(files) ? files : [];
  if (!attachments.length) return [];
  const folderId = ensureCalendarUploadsFolder();
  const insert = db.prepare(`
    INSERT INTO information_files
      (title, file_name, file_path, folder_id, calendar_event_id, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = dayjs().toISOString();
  const inserted = [];
  try {
    db.transaction(() => {
      attachments.forEach((file) => {
        const originalName = path.basename(file.originalname || file.filename);
        const baseTitle = path.basename(originalName, path.extname(originalName));
        const title = `${String(eventTitle || "Calendar event").trim()} — ${baseTitle}`;
        const filePath = `/uploads/informations/${path.basename(file.filename)}`;
        const result = insert.run(title, originalName, filePath, folderId, Number(eventId), Number(uploadedBy), now);
        inserted.push({ id: Number(result.lastInsertRowid), title, file_name: originalName, file_path: filePath });
      });
    })();
    return inserted;
  } catch (error) {
    removeUploadedCalendarFiles(attachments);
    throw error;
  }
}

function getCalendarAttachmentsByEventIds(eventIds) {
  const ids = Array.from(new Set((eventIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const grouped = new Map();
  if (!ids.length) return grouped;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, calendar_event_id, title, file_name, file_path, uploaded_at
    FROM information_files
    WHERE calendar_event_id IN (${placeholders})
    ORDER BY uploaded_at ASC, id ASC
  `).all(...ids);
  rows.forEach((row) => {
    const eventId = Number(row.calendar_event_id);
    if (!grouped.has(eventId)) grouped.set(eventId, []);
    grouped.get(eventId).push(row);
  });
  return grouped;
}

module.exports = {
  ALLOWED_EXTENSIONS,
  CALENDAR_UPLOADS_FOLDER,
  calendarAttachmentUpload,
  getCalendarAttachmentsByEventIds,
  removeUploadedCalendarFiles,
  saveCalendarAttachments
};
