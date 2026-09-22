const dayjs = require("dayjs");

if (process.env.PITIS_AUTOMATION_TEST_DB !== "1" || !process.env.DB_PATH) {
  throw new Error("Set PITIS_AUTOMATION_TEST_DB=1 and DB_PATH to a disposable database copy.");
}

const { db } = require("../src/db/init");
const {
  initializeNotificationTables,
  isOfficialSchoolDay,
  processPitisDailyNotifications
} = require("../src/services/notificationService");

async function main() {
  initializeNotificationTables();
  const date = "2026-09-23";
  const entityId = 20260923;
  db.prepare("DELETE FROM notifications WHERE entity_id = ? AND type IN ('pitis_first_award','pitis_0930_reminder')").run(entityId);
  db.prepare("DELETE FROM pitis_notification_events WHERE event_date = ?").run(date);
  db.prepare("DELETE FROM point_logs WHERE reason = 'AUTOMATION TEST'").run();

  const teacher = db.prepare("SELECT id FROM users WHERE is_active=1 AND role='teacher' AND COALESCE(user_type,role)='teacher' ORDER BY id LIMIT 1").get();
  const student = db.prepare("SELECT id,class_id FROM students ORDER BY id LIMIT 1").get();
  if (!teacher || !student) throw new Error("Test requires one active teacher and one student.");

  db.prepare("INSERT INTO point_logs(student_id,class_id,points,reason,awarded_by,awarded_at) VALUES(?,?,?,?,?,?)")
    .run(student.id, student.class_id, 1, "AUTOMATION TEST", teacher.id, "2026-09-23T00:01:00.000Z");

  const first = await processPitisDailyNotifications(dayjs("2026-09-23T08:05:00+08:00"));
  const morning = await processPitisDailyNotifications(dayjs("2026-09-23T09:31:00+08:00"));
  const repeated = await processPitisDailyNotifications(dayjs("2026-09-23T09:32:00+08:00"));
  const nonSchoolDay = await processPitisDailyNotifications(dayjs("2026-09-27T09:31:00+08:00"));
  const counts = db.prepare("SELECT type,COUNT(*) total FROM notifications WHERE entity_id=? AND type IN ('pitis_first_award','pitis_0930_reminder') GROUP BY type ORDER BY type").all(entityId);
  const winnerMessage = db.prepare("SELECT title,message FROM notifications WHERE user_id=? AND type='pitis_first_award' AND entity_id=?").get(teacher.id, entityId);
  const peerMessage = db.prepare("SELECT title,message FROM notifications WHERE user_id<>? AND type='pitis_first_award' AND entity_id=? LIMIT 1").get(teacher.id, entityId);

  if (!isOfficialSchoolDay(date)) throw new Error("Test date should be an official school day.");
  if (!first.firstAward) throw new Error("First-award notification was not claimed.");
  if (morning.reminders < 1) throw new Error("9:30 reminder was not created.");
  if (repeated.firstAward || repeated.reminders) throw new Error("Daily notifications were duplicated.");
  if (nonSchoolDay.schoolDay || nonSchoolDay.reminders || nonSchoolDay.firstAward) throw new Error("Notification was created on a non-school day.");
  if (!winnerMessage || !/First PITIS award/.test(winnerMessage.title)) throw new Error("Winner congratulations are missing.");
  if (!peerMessage || !/recognition has started/.test(peerMessage.title)) throw new Error("Peer motivation announcement is missing.");
  console.log({ first, morning, repeated, nonSchoolDay, counts, winnerMessage, peerMessage });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
