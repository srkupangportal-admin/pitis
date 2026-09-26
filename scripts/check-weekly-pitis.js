const fs = require("fs");
const os = require("os");
const path = require("path");

const sourceDb = path.join(__dirname, "..", "data.db");
const testDb = path.join(os.tmpdir(), `pitis-weekly-${process.pid}-${Date.now()}.db`);
fs.copyFileSync(sourceDb, testDb);
process.env.DB_PATH = testDb;

const { getWeeklyPitisWindow } = require("../src/services/weeklyPitisService");
const { initializeDatabase, db } = require("../src/db/init");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const saturday = getWeeklyPitisWindow("2026-09-26");
  assert(saturday.isOpen, "Saturday should allow weekly PITIS");
  assert(saturday.weekStart === "2026-09-21", "Weekly PITIS should begin on Monday");
  assert(saturday.weekEnd === "2026-09-26", "Weekly PITIS should end on Saturday");
  assert(!getWeeklyPitisWindow("2026-09-27").isOpen, "Sunday should close weekly PITIS");

  initializeDatabase();
  const columns = db.prepare("PRAGMA table_info(point_logs)").all().map((column) => column.name);
  assert(columns.includes("award_mode"), "point_logs.award_mode was not created");
  assert(columns.includes("award_week_start"), "point_logs.award_week_start was not created");
  assert(columns.includes("award_day"), "point_logs.award_day was not created");

  const user = db.prepare("SELECT id FROM users WHERE role IN ('teacher','staff') LIMIT 1").get();
  const student = db.prepare("SELECT id, class_id FROM students LIMIT 1").get();
  assert(user && student, "A teacher and student are required for this check");

  db.exec("BEGIN");
  try {
    const insert = db.prepare(`
      INSERT INTO point_logs
        (student_id, class_id, points, reason, awarded_by, awarded_at, award_mode, award_week_start, award_day)
      VALUES (?, ?, ?, ?, ?, ?, 'weekly', ?, ?)
    `);
    insert.run(student.id, student.class_id, 2, "Weekly test", user.id, new Date().toISOString(), saturday.weekStart, "2026-09-24");
    let duplicateBlocked = false;
    try {
      insert.run(student.id, student.class_id, 3, "Duplicate test", user.id, new Date().toISOString(), saturday.weekStart, "2026-09-24");
    } catch (error) {
      duplicateBlocked = String(error && error.code).includes("CONSTRAINT");
    }
    assert(duplicateBlocked, "Duplicate weekly award was not blocked");
    insert.run(student.id, student.class_id, 3, "Different day test", user.id, new Date().toISOString(), saturday.weekStart, "2026-09-25");
  } finally {
    db.exec("ROLLBACK");
  }

  console.log("Weekly PITIS window, migration, and duplicate guard passed.");
} finally {
  if (db.open) db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${testDb}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
