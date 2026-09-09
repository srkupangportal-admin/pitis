const dayjs = require("dayjs");
const { db } = require("../db/init");

const PROMOTION_RULES = [
  ["PRA", "YEAR 1"],
  ["YEAR 1", "YEAR 2"],
  ["YEAR 2", "YEAR 3"],
  ["YEAR 3", "YEAR 4"],
  ["YEAR 4", "YEAR 5"],
  ["YEAR 5", "YEAR 6"]
];

function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error("Enter a valid target academic year between 2020 and 2100");
  }
  return year;
}

function getClassMap() {
  return new Map(db.prepare("SELECT id, name FROM classes").all().map((row) => [String(row.name).toUpperCase(), row]));
}

function getRolloverPreview(targetYear = dayjs().add(1, "year").year()) {
  const year = normalizeYear(targetYear);
  const classMap = getClassMap();
  const movements = PROMOTION_RULES.map(([sourceName, destinationName]) => {
    const source = classMap.get(sourceName);
    const destination = classMap.get(destinationName);
    const studentCount = source
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM students WHERE class_id = ?").get(source.id).count || 0)
      : 0;
    return {
      sourceClassId: source ? source.id : null,
      sourceName,
      destinationClassId: destination ? destination.id : null,
      destinationName,
      studentCount,
      ready: Boolean(source && destination)
    };
  });
  const yearSix = classMap.get("YEAR 6");
  const graduatingCount = yearSix
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM students WHERE class_id = ?").get(yearSix.id).count || 0)
    : 0;
  const previousRun = db.prepare(`
    SELECT id, from_year, to_year, status, students_promoted, students_graduated,
           reset_fees, backup_path, started_at, completed_at
    FROM academic_year_rollover_runs
    ORDER BY id DESC LIMIT 1
  `).get() || null;
  const alreadyCompleted = db.prepare(
    "SELECT id FROM academic_year_rollover_runs WHERE to_year = ? AND status = 'completed' LIMIT 1"
  ).get(year);

  return {
    targetYear: year,
    fromYear: year - 1,
    movements,
    graduatingCount,
    totalPromoted: movements.reduce((sum, item) => sum + item.studentCount, 0),
    totalStudents: movements.reduce((sum, item) => sum + item.studentCount, 0) + graduatingCount,
    ready: movements.every((item) => item.ready) && Boolean(yearSix) && !alreadyCompleted,
    alreadyCompleted: Boolean(alreadyCompleted),
    confirmationText: `ROLL OVER ${year}`,
    previousRun
  };
}

function applyAcademicYearRollover(options) {
  const targetYear = normalizeYear(options.targetYear);
  const preview = getRolloverPreview(targetYear);
  if (!preview.ready) {
    throw new Error(preview.alreadyCompleted
      ? `The ${targetYear} academic-year rollover has already been completed`
      : "Rollover cannot continue because one or more standard classes are missing");
  }
  if (String(options.confirmation || "").trim().toUpperCase() !== preview.confirmationText) {
    throw new Error(`Type ${preview.confirmationText} to confirm`);
  }

  const now = dayjs().toISOString();
  const resetFees = options.resetFees ? 1 : 0;
  const run = db.prepare(`
    INSERT INTO academic_year_rollover_runs
      (from_year, to_year, status, reset_fees, backup_path, started_at, created_by)
    VALUES (?, ?, 'running', ?, ?, ?, ?)
  `).run(targetYear - 1, targetYear, resetFees, options.backupPath || null, now, options.userId || null);

  try {
    const result = db.transaction(() => {
      const classMap = getClassMap();
      const initialRosters = new Map(
        [...PROMOTION_RULES.map(([sourceName]) => sourceName), "YEAR 6"].map((className) => {
          const classRow = classMap.get(className);
          return [className, db.prepare("SELECT id FROM students WHERE class_id = ? ORDER BY id").all(classRow.id)];
        })
      );
      const historyInsert = db.prepare(`
        INSERT INTO student_academic_history
          (rollover_run_id, student_id, academic_year, class_id, class_name, outcome, destination_class_id, destination_class_name, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const moveStudent = db.prepare("UPDATE students SET class_id = ?, level = ? WHERE id = ?");
      let promoted = 0;

      for (const [sourceName, destinationName] of PROMOTION_RULES) {
        const source = classMap.get(sourceName);
        const destination = classMap.get(destinationName);
        const students = initialRosters.get(sourceName);
        for (const student of students) {
          historyInsert.run(run.lastInsertRowid, student.id, targetYear - 1, source.id, sourceName, "promoted", destination.id, destinationName, now);
          moveStudent.run(destination.id, destinationName, student.id);
          promoted += 1;
        }
      }

      const yearSix = classMap.get("YEAR 6");
      const alumniName = `ALUMNI ${targetYear - 1}`;
      db.prepare("INSERT OR IGNORE INTO classes (name) VALUES (?)").run(alumniName);
      const alumni = db.prepare("SELECT id, name FROM classes WHERE name = ?").get(alumniName);
      const graduates = initialRosters.get("YEAR 6");
      for (const student of graduates) {
        historyInsert.run(run.lastInsertRowid, student.id, targetYear - 1, yearSix.id, "YEAR 6", "graduated", alumni.id, alumniName, now);
        moveStudent.run(alumni.id, alumniName, student.id);
      }

      if (resetFees) {
        db.prepare("UPDATE students SET yiuran_sekolah_paid = 0, yuran_pibg_paid = 0, insuran_paid = 0 WHERE class_id <> ?").run(alumni.id);
      }
      db.prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by)
        VALUES ('academic_year', ?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(String(targetYear), now, options.userId || null);
      db.prepare(`
        UPDATE academic_year_rollover_runs
        SET status = 'completed', students_promoted = ?, students_graduated = ?, completed_at = ?
        WHERE id = ?
      `).run(promoted, graduates.length, now, run.lastInsertRowid);
      return { runId: Number(run.lastInsertRowid), promoted, graduated: graduates.length, alumniName };
    })();
    return result;
  } catch (error) {
    db.prepare("UPDATE academic_year_rollover_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?")
      .run(String(error.message || error), dayjs().toISOString(), run.lastInsertRowid);
    throw error;
  }
}

module.exports = { applyAcademicYearRollover, getRolloverPreview, normalizeYear };
