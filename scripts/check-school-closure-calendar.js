const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pitis-school-closure-"));
process.env.DB_PATH = path.join(testDirectory, "data.db");

const { db, initializeDatabase } = require("../src/db/init");
const {
  seedOfficialSchoolCalendar2026,
  synchronizeManualNonSchoolEvents
} = require("../src/services/schoolCalendarService");
const { isOfficialSchoolDay } = require("../src/services/notificationService");

try {
  initializeDatabase();
  const adminId = Number(db.prepare(`
    INSERT INTO users (username, display_name, role, user_type, password_hash, is_active, created_at)
    VALUES ('calendar-test-admin', 'Calendar Test Admin', 'admin', 'admin', 'test-only', 1, ?)
  `).run(new Date().toISOString()).lastInsertRowid);

  seedOfficialSchoolCalendar2026();
  const testDate = "2026-09-28";
  assert.equal(isOfficialSchoolDay(testDate), true, "Test date must begin as an official school day");

  const label = db.prepare("SELECT id FROM calendar_labels WHERE name = 'School Closure'").get();
  assert.ok(label, "School Closure label must be seeded");

  const eventId = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, details, event_date, end_date, event_source, created_by, created_at, is_deleted)
    VALUES ('Emergency closure', 'Test closure', ?, ?, 'manual', ?, ?, 0)
  `).run(testDate, testDate, adminId, new Date().toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO calendar_event_labels (event_id, label_id) VALUES (?, ?)").run(eventId, label.id);

  const applied = synchronizeManualNonSchoolEvents(adminId);
  assert.equal(applied.events, 1);
  assert.equal(applied.affectedDays, 1);
  const closedDay = db.prepare("SELECT * FROM calendar_school_days WHERE calendar_date = ?").get(testDate);
  assert.equal(closedDay.is_available_for_pitis, 0);
  assert.equal(closedDay.event_type, "school_closure");
  assert.equal(closedDay.source, "calendar_event");
  assert.equal(isOfficialSchoolDay(testDate), false, "Closure must suppress school-day notifications");

  db.prepare("UPDATE calendar_events SET is_deleted = 1 WHERE id = ?").run(eventId);
  synchronizeManualNonSchoolEvents(adminId);
  const restoredDay = db.prepare("SELECT * FROM calendar_school_days WHERE calendar_date = ?").get(testDate);
  assert.equal(restoredDay.is_available_for_pitis, 1);
  assert.equal(restoredDay.event_type, "normal_school_day");
  assert.equal(restoredDay.source, "moe_2026");
  assert.equal(isOfficialSchoolDay(testDate), true, "Deleting the closure must restore the official school day");

  console.log("School Closure calendar synchronization passed.");
} finally {
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
