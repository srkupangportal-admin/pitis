const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pitis-calendar-attachments-"));
process.env.DB_PATH = path.join(testDirectory, "data.db");

const { db, initializeDatabase } = require("../src/db/init");
const {
  CALENDAR_UPLOADS_FOLDER,
  getCalendarAttachmentsByEventIds,
  saveCalendarAttachments
} = require("../src/services/calendarAttachmentService");

try {
  initializeDatabase();
  const userId = Number(db.prepare(`
    INSERT INTO users (username, password_hash, role, display_name, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run("attachment-check", "not-used", "admin", "Attachment Check", new Date().toISOString()).lastInsertRowid);
  const eventId = Number(db.prepare(`
    INSERT INTO calendar_events (title, details, event_date, end_date, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("Staff meeting", "Test event", "2026-09-25", "2026-09-25", userId, new Date().toISOString()).lastInsertRowid);

  const inserted = saveCalendarAttachments(eventId, "Staff meeting", [{
    originalname: "Agenda.docx",
    filename: "calendar-attachment-check.docx"
  }], userId);

  assert.equal(inserted.length, 1);
  const folder = db.prepare("SELECT id, name FROM info_folders WHERE name = ?").get(CALENDAR_UPLOADS_FOLDER);
  assert(folder, "Calendar uploads folder should be created");
  const row = db.prepare("SELECT * FROM information_files WHERE id = ?").get(inserted[0].id);
  assert.equal(Number(row.folder_id), Number(folder.id));
  assert.equal(Number(row.calendar_event_id), eventId);
  assert.equal(row.file_name, "Agenda.docx");
  assert.equal(row.file_path, "/uploads/informations/calendar-attachment-check.docx");

  const grouped = getCalendarAttachmentsByEventIds([eventId]);
  assert.equal(grouped.get(eventId).length, 1);
  assert.equal(grouped.get(eventId)[0].file_name, "Agenda.docx");

  console.log("Calendar attachment lifecycle check passed.");
} finally {
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
