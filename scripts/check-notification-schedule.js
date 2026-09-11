const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dayjs = require("dayjs");

const testDb = path.join(os.tmpdir(), `schoolportal-notifications-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = testDb;

const { db, initializeDatabase } = require("../src/db/init");
const { initializeNotificationTables, scheduleEvent } = require("../src/services/notificationService");

try {
  initializeDatabase();
  initializeNotificationTables();
  const createdUser = db.prepare("INSERT INTO users(username,display_name,role,user_type,password_hash,is_active,must_change_password,created_at) VALUES(?,?,?,?,?,1,0,?)").run("notification-test", "Notification Test", "teacher", "teacher", "not-used", dayjs().toISOString());
  const user = { id: Number(createdUser.lastInsertRowid) };
  const eventDate = dayjs().add(10, "day").format("YYYY-MM-DD");
  const event = db.prepare("INSERT INTO calendar_events(title,event_date,end_date,event_source,created_by,created_at,is_deleted) VALUES(?,?,?,?,?,?,0)").run("Schedule test", eventDate, eventDate, "manual", user.id, dayjs().toISOString());
  scheduleEvent(Number(event.lastInsertRowid), [user.id], eventDate, "09:00");
  const offsets = db.prepare("SELECT offset_minutes FROM calendar_notification_jobs WHERE event_id=? ORDER BY offset_minutes").all(event.lastInsertRowid).map(row => row.offset_minutes);
  assert.deepStrictEqual(offsets, [0, 4320, 7200]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) count FROM calendar_notification_jobs WHERE offset_minutes IN (15,60,1440)").get().count, 0);
  console.log("Notification schedule check passed: event day, 3 days, and 5 days; birthdays excluded.");
} finally {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(testDb + suffix); } catch {}
  }
}
