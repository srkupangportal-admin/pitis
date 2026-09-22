const dayjs = require("dayjs");
const { db } = require("../db/init");

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function normalizeFilters(query = {}) {
  const today = dayjs().format("YYYY-MM-DD");
  const defaultFrom = dayjs(today).subtract(27, "day").format("YYYY-MM-DD");
  const rawFrom = String(query.from || "").trim();
  const rawTo = String(query.to || "").trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) && dayjs(rawFrom).isValid() ? rawFrom : defaultFrom;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(rawTo) && dayjs(rawTo).isValid() ? rawTo : today;
  const classIdRaw = String(query.classId || "all").trim();
  const classId = classIdRaw === "all" ? "all" : Number(classIdRaw);
  let error = "";
  if (dayjs(from).isAfter(dayjs(to), "day")) error = "The From date must be on or before the To date.";
  if (classId !== "all" && (!Number.isInteger(classId) || classId <= 0)) error = "Choose a valid class.";
  return { from, to, classId, error };
}

function buildStudentRecognitionCoverageReport(query = {}) {
  const filters = normalizeFilters(query);
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  if (filters.error) return { ...filters, classes, generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"), summary: {}, classRows: [], studentRows: [], priorityStudents: [], weeklyRows: [], reasonRows: [] };

  const classClause = filters.classId === "all" ? "" : "WHERE c.id = ?";
  const params = filters.classId === "all" ? [filters.from, filters.to] : [filters.from, filters.to, filters.classId];
  const studentRows = db.prepare(`
    WITH period_activity AS (
      SELECT student_id,
             COUNT(CASE WHEN points > 0 THEN 1 END) AS positive_transactions,
             COUNT(DISTINCT CASE WHEN points > 0 THEN date(awarded_at, '+8 hours') END) AS recognition_days,
             SUM(CASE WHEN points > 0 THEN points ELSE 0 END) AS positive_points,
             ABS(SUM(CASE WHEN points < 0 THEN points ELSE 0 END)) AS deductions,
             MAX(CASE WHEN points > 0 THEN awarded_at END) AS last_recognised_at
      FROM point_logs
      WHERE date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
      GROUP BY student_id
    ),
    lifetime AS (
      SELECT student_id, SUM(points) AS total_points,
             MAX(CASE WHEN points > 0 THEN awarded_at END) AS lifetime_last_recognised_at
      FROM point_logs GROUP BY student_id
    )
    SELECT s.id, COALESCE(NULLIF(s.name, ''), s.full_name) AS name, s.full_name,
           c.id AS class_id, c.name AS class_name,
           COALESCE(p.positive_transactions, 0) AS positive_transactions,
           COALESCE(p.recognition_days, 0) AS recognition_days,
           COALESCE(p.positive_points, 0) AS positive_points,
           COALESCE(p.deductions, 0) AS deductions,
           p.last_recognised_at,
           COALESCE(l.total_points, 0) AS total_points,
           l.lifetime_last_recognised_at
    FROM students s
    JOIN classes c ON c.id = s.class_id
    LEFT JOIN period_activity p ON p.student_id = s.id
    LEFT JOIN lifetime l ON l.student_id = s.id
    ${classClause}
    ORDER BY c.name, recognition_days ASC, positive_transactions ASC, name
  `).all(...params).map((row) => ({
    id: Number(row.id),
    name: row.name,
    fullName: row.full_name,
    classId: Number(row.class_id),
    className: row.class_name,
    positiveTransactions: Number(row.positive_transactions || 0),
    recognitionDays: Number(row.recognition_days || 0),
    positivePoints: Number(row.positive_points || 0),
    deductions: Number(row.deductions || 0),
    lastRecognisedAt: row.last_recognised_at || "Not recognised in period",
    lifetimeLastRecognisedAt: row.lifetime_last_recognised_at || "Never",
    totalPoints: Number(row.total_points || 0),
    coverageStatus: Number(row.recognition_days || 0) === 0 ? "Not recognised" : Number(row.recognition_days || 0) === 1 ? "Recognised once" : "Recognised regularly"
  }));

  const rowsByClass = new Map();
  studentRows.forEach((student) => {
    if (!rowsByClass.has(student.classId)) rowsByClass.set(student.classId, []);
    rowsByClass.get(student.classId).push(student);
  });
  const classRows = classes
    .filter((item) => filters.classId === "all" || Number(item.id) === filters.classId)
    .map((item) => {
      const students = rowsByClass.get(Number(item.id)) || [];
      const recognised = students.filter((student) => student.recognitionDays > 0).length;
      return {
        id: Number(item.id), name: item.name, students: students.length, recognised,
        notRecognised: students.length - recognised,
        coverage: students.length ? Math.round((recognised / students.length) * 100) : 0,
        recognitionDays: students.reduce((sum, student) => sum + student.recognitionDays, 0),
        positivePoints: students.reduce((sum, student) => sum + student.positivePoints, 0),
        deductions: students.reduce((sum, student) => sum + student.deductions, 0)
      };
    });

  const weeklyParams = filters.classId === "all" ? [filters.from, filters.to] : [filters.from, filters.to, filters.classId];
  const weeklyClassClause = filters.classId === "all" ? "" : "AND s.class_id = ?";
  const weeklyRows = db.prepare(`
    SELECT strftime('%Y-%W', date(pl.awarded_at, '+8 hours')) AS week_key,
           MIN(date(pl.awarded_at, '+8 hours')) AS first_activity_date,
           COUNT(DISTINCT CASE WHEN pl.points > 0 THEN pl.student_id END) AS recognised_students,
           COUNT(CASE WHEN pl.points > 0 THEN 1 END) AS positive_transactions,
           SUM(CASE WHEN pl.points > 0 THEN pl.points ELSE 0 END) AS positive_points,
           ABS(SUM(CASE WHEN pl.points < 0 THEN pl.points ELSE 0 END)) AS deductions
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    WHERE date(pl.awarded_at, '+8 hours') BETWEEN date(?) AND date(?) ${weeklyClassClause}
    GROUP BY week_key ORDER BY week_key
  `).all(...weeklyParams).map((row) => {
    const activityDate = dayjs(row.first_activity_date);
    const daysSinceMonday = (activityDate.day() + 6) % 7;
    return {
      weekKey: row.week_key,
      weekStarting: activityDate.subtract(daysSinceMonday, "day").format("YYYY-MM-DD"),
      recognisedStudents: Number(row.recognised_students || 0),
      coverage: studentRows.length ? Math.round((Number(row.recognised_students || 0) / studentRows.length) * 100) : 0,
      positiveTransactions: Number(row.positive_transactions || 0),
      positivePoints: Number(row.positive_points || 0),
      deductions: Number(row.deductions || 0)
    };
  });

  const reasonParams = filters.classId === "all" ? [filters.from, filters.to] : [filters.from, filters.to, filters.classId];
  const reasonClassClause = filters.classId === "all" ? "" : "AND s.class_id = ?";
  const reasonRows = db.prepare(`
    SELECT pl.reason, COUNT(*) AS uses, COUNT(DISTINCT pl.student_id) AS students,
           SUM(pl.points) AS points
    FROM point_logs pl JOIN students s ON s.id = pl.student_id
    WHERE pl.points > 0 AND date(pl.awarded_at, '+8 hours') BETWEEN date(?) AND date(?) ${reasonClassClause}
    GROUP BY pl.reason ORDER BY uses DESC, pl.reason LIMIT 10
  `).all(...reasonParams).map((row) => ({ reason: row.reason, uses: Number(row.uses), students: Number(row.students), points: Number(row.points) }));

  const recognisedStudents = studentRows.filter((student) => student.recognitionDays > 0).length;
  const priorityStudents = studentRows.filter((student) => student.recognitionDays <= 1);
  return {
    ...filters,
    classes,
    generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    summary: {
      students: studentRows.length,
      recognisedStudents,
      notRecognisedStudents: studentRows.length - recognisedStudents,
      coverage: studentRows.length ? Math.round((recognisedStudents / studentRows.length) * 100) : 0,
      recognisedOnce: studentRows.filter((student) => student.recognitionDays === 1).length,
      recognisedRegularly: studentRows.filter((student) => student.recognitionDays >= 2).length
    },
    classRows,
    studentRows,
    priorityStudents,
    weeklyRows,
    reasonRows
  };
}

function studentRecognitionCoverageToCsv(report) {
  const rows = [["student", "full_name", "class", "status", "recognition_days", "positive_transactions", "positive_points", "deductions", "last_recognised_in_period", "lifetime_total"]];
  report.studentRows.forEach((row) => rows.push([row.name, row.fullName, row.className, row.coverageStatus, row.recognitionDays, row.positiveTransactions, row.positivePoints, row.deductions, row.lastRecognisedAt, row.totalPoints]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

module.exports = { buildStudentRecognitionCoverageReport, studentRecognitionCoverageToCsv };
