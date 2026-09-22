const dayjs = require("dayjs");
const { db } = require("../db/init");

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function normalizeDateRange(query = {}, defaultDays = 28) {
  const today = dayjs().format("YYYY-MM-DD");
  const defaultFrom = dayjs(today).subtract(defaultDays - 1, "day").format("YYYY-MM-DD");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || "")) && dayjs(query.from).isValid() ? String(query.from) : defaultFrom;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || "")) && dayjs(query.to).isValid() ? String(query.to) : today;
  return { from, to, error: dayjs(from).isAfter(dayjs(to), "day") ? "The From date must be on or before the To date." : "" };
}

function listStudentChoices() {
  return db.prepare(`
    SELECT s.id, COALESCE(NULLIF(s.name, ''), s.full_name) AS name, s.full_name, c.name AS class_name
    FROM students s JOIN classes c ON c.id = s.class_id
    ORDER BY c.name, name
  `).all();
}

function buildStudentStatement(query = {}) {
  const range = normalizeDateRange(query, 28);
  const studentId = Number(query.studentId || 0);
  const students = listStudentChoices();
  if (range.error || !studentId) return { ...range, studentId, students, hasStudent: false, error: range.error, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss") };
  const student = db.prepare(`
    SELECT s.id, COALESCE(NULLIF(s.name, ''), s.full_name) AS name, s.full_name, s.student_id,
           c.id AS class_id, c.name AS class_name
    FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?
  `).get(studentId);
  if (!student) return { ...range, studentId, students, hasStudent: false, error: "Student not found.", generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss") };

  const opening = Number(db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM point_logs WHERE student_id = ? AND date(awarded_at, '+8 hours') < date(?)").get(studentId, range.from).total || 0);
  const transactions = db.prepare(`
    SELECT pl.id, pl.awarded_at, pl.points, pl.reason,
           COALESCE(NULLIF(u.display_name, ''), u.username) AS teacher
    FROM point_logs pl JOIN users u ON u.id = pl.awarded_by
    WHERE pl.student_id = ? AND date(pl.awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    ORDER BY pl.awarded_at, pl.id
  `).all(studentId, range.from, range.to).map((row) => ({
    id: Number(row.id),
    awardedAt: row.awarded_at,
    points: Number(row.points),
    reason: row.reason,
    teacher: row.teacher,
    type: Number(row.points) >= 0 ? "Award" : "Deduction"
  }));
  const awarded = transactions.reduce((sum, row) => sum + Math.max(0, row.points), 0);
  const deducted = transactions.reduce((sum, row) => sum + Math.abs(Math.min(0, row.points)), 0);
  const netChange = awarded - deducted;
  const reasonRows = db.prepare(`
    SELECT reason, CASE WHEN points >= 0 THEN 'Award' ELSE 'Deduction' END AS type,
           COUNT(*) AS uses, SUM(points) AS net_points
    FROM point_logs
    WHERE student_id = ? AND date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    GROUP BY reason, type ORDER BY uses DESC, reason
  `).all(studentId, range.from, range.to).map((row) => ({ reason: row.reason, type: row.type, uses: Number(row.uses), netPoints: Number(row.net_points) }));
  return {
    ...range, studentId, students, student, hasStudent: true, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    summary: { openingBalance: opening, awarded, deducted, netChange, closingBalance: opening + netChange, transactions: transactions.length },
    transactions, reasonRows
  };
}

function studentStatementToCsv(report) {
  const rows = [["date_time", "type", "points", "reason", "teacher"]];
  report.transactions.forEach((row) => rows.push([row.awardedAt, row.type, row.points, row.reason, row.teacher]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function buildClassWeeklyDigest(query = {}) {
  const range = normalizeDateRange(query, 7);
  const classId = Number(query.classId || 0);
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  if (range.error || !classId) return { ...range, classId, classes, hasClass: false, error: range.error, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss") };
  const selectedClass = classes.find((item) => Number(item.id) === classId);
  if (!selectedClass) return { ...range, classId, classes, hasClass: false, error: "Class not found.", generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss") };

  const studentRows = db.prepare(`
    WITH activity AS (
      SELECT student_id,
             COUNT(CASE WHEN points > 0 THEN 1 END) AS awards,
             COUNT(DISTINCT CASE WHEN points > 0 THEN date(awarded_at, '+8 hours') END) AS recognition_days,
             SUM(CASE WHEN points > 0 THEN points ELSE 0 END) AS positive_points,
             ABS(SUM(CASE WHEN points < 0 THEN points ELSE 0 END)) AS deductions,
             MAX(CASE WHEN points > 0 THEN awarded_at END) AS last_recognised_at
      FROM point_logs WHERE class_id = ? AND date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
      GROUP BY student_id
    )
    SELECT s.id, COALESCE(NULLIF(s.name, ''), s.full_name) AS name, s.full_name,
           COALESCE(a.awards, 0) AS awards, COALESCE(a.recognition_days, 0) AS recognition_days,
           COALESCE(a.positive_points, 0) AS positive_points, COALESCE(a.deductions, 0) AS deductions,
           a.last_recognised_at
    FROM students s LEFT JOIN activity a ON a.student_id = s.id
    WHERE s.class_id = ? ORDER BY recognition_days, awards, name
  `).all(classId, range.from, range.to, classId).map((row) => ({
    id: Number(row.id), name: row.name, fullName: row.full_name,
    awards: Number(row.awards), recognitionDays: Number(row.recognition_days),
    positivePoints: Number(row.positive_points), deductions: Number(row.deductions),
    lastRecognisedAt: row.last_recognised_at || "Not recognised"
  }));
  const recognised = studentRows.filter((row) => row.recognitionDays > 0).length;
  const dailyRows = db.prepare(`
    SELECT date(awarded_at, '+8 hours') AS activity_date,
           COUNT(CASE WHEN points > 0 THEN 1 END) AS awards,
           COUNT(DISTINCT CASE WHEN points > 0 THEN student_id END) AS students,
           SUM(CASE WHEN points > 0 THEN points ELSE 0 END) AS positive_points,
           ABS(SUM(CASE WHEN points < 0 THEN points ELSE 0 END)) AS deductions
    FROM point_logs WHERE class_id = ? AND date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    GROUP BY activity_date ORDER BY activity_date
  `).all(classId, range.from, range.to).map((row) => ({ date: row.activity_date, awards: Number(row.awards), students: Number(row.students), positivePoints: Number(row.positive_points), deductions: Number(row.deductions) }));
  const reasonRows = db.prepare(`
    SELECT reason, CASE WHEN points > 0 THEN 'Award' ELSE 'Deduction' END AS type,
           COUNT(*) AS uses, COUNT(DISTINCT student_id) AS students, SUM(points) AS net_points
    FROM point_logs WHERE class_id = ? AND date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    GROUP BY reason, type ORDER BY uses DESC, reason LIMIT 12
  `).all(classId, range.from, range.to).map((row) => ({ reason: row.reason, type: row.type, uses: Number(row.uses), students: Number(row.students), netPoints: Number(row.net_points) }));
  const teacherRows = db.prepare(`
    SELECT COALESCE(NULLIF(u.display_name, ''), u.username) AS teacher,
           COUNT(*) AS transactions, COUNT(DISTINCT pl.student_id) AS students,
           SUM(CASE WHEN pl.points > 0 THEN pl.points ELSE 0 END) AS positive_points,
           ABS(SUM(CASE WHEN pl.points < 0 THEN pl.points ELSE 0 END)) AS deductions
    FROM point_logs pl JOIN users u ON u.id = pl.awarded_by
    WHERE pl.class_id = ? AND date(pl.awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    GROUP BY pl.awarded_by, teacher ORDER BY transactions DESC, teacher
  `).all(classId, range.from, range.to).map((row) => ({ teacher: row.teacher, transactions: Number(row.transactions), students: Number(row.students), positivePoints: Number(row.positive_points), deductions: Number(row.deductions) }));
  const awarded = studentRows.reduce((sum, row) => sum + row.positivePoints, 0);
  const deducted = studentRows.reduce((sum, row) => sum + row.deductions, 0);
  return {
    ...range, classId, classes, selectedClass, hasClass: true, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    summary: { students: studentRows.length, recognised, notRecognised: studentRows.length - recognised, coverage: studentRows.length ? Math.round((recognised / studentRows.length) * 100) : 0, awarded, deducted, net: awarded - deducted },
    studentRows, unrecognisedStudents: studentRows.filter((row) => row.recognitionDays === 0), dailyRows, reasonRows, teacherRows
  };
}

function classWeeklyDigestToCsv(report) {
  const rows = [["student", "full_name", "recognition_days", "awards", "positive_points", "deductions", "last_recognised"]];
  report.studentRows.forEach((row) => rows.push([row.name, row.fullName, row.recognitionDays, row.awards, row.positivePoints, row.deductions, row.lastRecognisedAt]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

module.exports = { buildStudentStatement, studentStatementToCsv, buildClassWeeklyDigest, classWeeklyDigestToCsv };
