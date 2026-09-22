const dayjs = require("dayjs");
const { db } = require("../db/init");
const { buildSipPitisDashboard } = require("./sipPitisDashboardService");

function normalizeAsOf(value) {
  const raw = String(value || "").trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? dayjs(raw) : dayjs();
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : dayjs().format("YYYY-MM-DD");
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildWeeklyPitisActionReport(query = {}) {
  const asOf = normalizeAsOf(query.asOf);
  const dashboard = buildSipPitisDashboard({ asOf });
  const week = dashboard.currentWeek || null;
  if (!week) {
    return {
      asOf,
      generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      outsideTerm: true,
      message: "The selected date is outside an official school week.",
      summary: { teachersNeedingAction: 0, inactiveClasses: 0, unrecognisedStudents: 0, recognitionCoverage: 0 },
      teacherActions: [], classActions: [], unrecognisedStudents: [], unusualActivity: []
    };
  }

  const activityEnd = dayjs(asOf).isAfter(dayjs(week.end), "day") ? week.end : asOf;
  const weekStart = week.start;
  const weekEnd = week.end;
  const currentTeacherWeeks = dashboard.allTeacherReports.map((teacher) => {
    const teacherWeek = teacher.weeks.find((item) => item.weekKey === week.weekKey) || null;
    if (!teacherWeek) return null;
    const remainingTargetDays = Math.max(0, Number(teacherWeek.requiredDays || 0) - Number(teacherWeek.activeDays || 0));
    const availableDaysRemaining = teacherWeek.days.filter((day) => (
      day.type === "school_day"
      && !dayjs(day.date).isBefore(dayjs(asOf), "day")
      && !dayjs(day.date).isAfter(dayjs(week.end), "day")
    )).length;
    return {
      id: teacher.id,
      displayName: teacher.display_name,
      username: teacher.username,
      status: teacherWeek.status,
      activeDays: teacherWeek.activeDays,
      requiredDays: teacherWeek.requiredDays,
      remainingTargetDays,
      availableDaysRemaining,
      transactions: teacherWeek.totalTransactions,
      studentsRewarded: teacherWeek.totalStudentsRewarded,
      pointsAwarded: teacherWeek.totalPointsAwarded,
      action: teacherWeek.status === "Met"
        ? "Target met"
        : remainingTargetDays > availableDaysRemaining
          ? "Target can no longer be met this week; review support needed"
          : `${remainingTargetDays} more active day${remainingTargetDays === 1 ? "" : "s"} needed`
    };
  }).filter(Boolean);
  const teacherActions = currentTeacherWeeks.filter((teacher) => !["Met", "Future", "Excluded"].includes(teacher.status));

  const classRows = db.prepare(`
    WITH weekly AS (
      SELECT student_id,
             COUNT(*) AS transaction_count,
             SUM(CASE WHEN points > 0 THEN points ELSE 0 END) AS positive_points,
             ABS(SUM(CASE WHEN points < 0 THEN points ELSE 0 END)) AS deductions
      FROM point_logs
      WHERE date(awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
      GROUP BY student_id
    )
    SELECT c.id, c.name,
           COUNT(s.id) AS student_count,
           SUM(CASE WHEN COALESCE(w.positive_points, 0) > 0 THEN 1 ELSE 0 END) AS recognised_students,
           COALESCE(SUM(w.transaction_count), 0) AS transactions,
           COALESCE(SUM(w.positive_points), 0) AS positive_points,
           COALESCE(SUM(w.deductions), 0) AS deductions
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id
    LEFT JOIN weekly w ON w.student_id = s.id
    GROUP BY c.id, c.name
    ORDER BY c.name
  `).all(weekStart, activityEnd).map((row) => {
    const studentCount = Number(row.student_count || 0);
    const recognisedStudents = Number(row.recognised_students || 0);
    const coverage = studentCount ? Math.round((recognisedStudents / studentCount) * 100) : 0;
    return {
      id: Number(row.id),
      name: row.name,
      studentCount,
      recognisedStudents,
      unrecognisedStudents: Math.max(0, studentCount - recognisedStudents),
      coverage,
      transactions: Number(row.transactions || 0),
      positivePoints: Number(row.positive_points || 0),
      deductions: Number(row.deductions || 0),
      action: studentCount === 0 ? "No students in class" : recognisedStudents === 0 ? "No students recognised this week" : coverage < 50 ? "Recognition coverage below 50%" : "Monitor"
    };
  });
  const classActions = classRows.filter((row) => row.studentCount > 0 && (row.recognisedStudents === 0 || row.coverage < 50));

  const unrecognisedStudents = db.prepare(`
    SELECT s.id, COALESCE(NULLIF(s.name, ''), s.full_name) AS name, s.full_name,
           c.id AS class_id, c.name AS class_name,
           COALESCE(all_time.total_points, 0) AS total_points,
           all_time.last_positive_at
    FROM students s
    JOIN classes c ON c.id = s.class_id
    LEFT JOIN (
      SELECT student_id, SUM(points) AS total_points,
             MAX(CASE WHEN points > 0 THEN awarded_at END) AS last_positive_at
      FROM point_logs GROUP BY student_id
    ) all_time ON all_time.student_id = s.id
    WHERE NOT EXISTS (
      SELECT 1 FROM point_logs pl
      WHERE pl.student_id = s.id AND pl.points > 0
        AND date(pl.awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    )
    ORDER BY c.name, COALESCE(NULLIF(s.name, ''), s.full_name)
  `).all(weekStart, activityEnd).map((row) => ({
    id: Number(row.id),
    name: row.name,
    fullName: row.full_name,
    classId: Number(row.class_id),
    className: row.class_name,
    totalPoints: Number(row.total_points || 0),
    lastPositiveAt: row.last_positive_at || "Never"
  }));

  const unusualActivity = db.prepare(`
    SELECT s.id, COALESCE(NULLIF(s.name, ''), s.full_name) AS name, c.name AS class_name,
           SUM(CASE WHEN pl.points > 0 THEN pl.points ELSE 0 END) AS positive_points,
           ABS(SUM(CASE WHEN pl.points < 0 THEN pl.points ELSE 0 END)) AS deductions,
           COUNT(*) AS transactions
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    JOIN classes c ON c.id = s.class_id
    WHERE date(pl.awarded_at, '+8 hours') BETWEEN date(?) AND date(?)
    GROUP BY s.id, s.name, s.full_name, c.name
    HAVING SUM(CASE WHEN pl.points > 0 THEN pl.points ELSE 0 END) > 50
        OR ABS(SUM(CASE WHEN pl.points < 0 THEN pl.points ELSE 0 END)) >= 10
    ORDER BY positive_points DESC, deductions DESC
  `).all(weekStart, activityEnd).map((row) => ({
    id: Number(row.id),
    name: row.name,
    className: row.class_name,
    positivePoints: Number(row.positive_points || 0),
    deductions: Number(row.deductions || 0),
    transactions: Number(row.transactions || 0),
    action: Number(row.deductions || 0) >= 10 ? "Review deduction volume" : "Review unusually high weekly award total"
  }));

  const totalStudents = classRows.reduce((sum, row) => sum + row.studentCount, 0);
  const recognisedStudents = classRows.reduce((sum, row) => sum + row.recognisedStudents, 0);
  return {
    asOf,
    generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    outsideTerm: false,
    week: { term: week.term, weekNumber: week.weekNumber, start: weekStart, end: weekEnd, activityEnd, requiredDays: week.requiredDays },
    summary: {
      teachersNeedingAction: teacherActions.length,
      inactiveClasses: classRows.filter((row) => row.studentCount > 0 && row.recognisedStudents === 0).length,
      unrecognisedStudents: unrecognisedStudents.length,
      recognitionCoverage: totalStudents ? Math.round((recognisedStudents / totalStudents) * 100) : 0,
      unusualActivity: unusualActivity.length
    },
    teacherActions,
    classActions,
    classRows,
    unrecognisedStudents,
    unusualActivity
  };
}

function weeklyPitisActionReportToCsv(report) {
  const rows = [["section", "name", "class", "status", "value", "action"]];
  report.teacherActions.forEach((row) => rows.push(["Teacher action", row.displayName, "", row.status, `${row.activeDays}/${row.requiredDays} active days`, row.action]));
  report.classActions.forEach((row) => rows.push(["Class action", row.name, row.name, `${row.coverage}% coverage`, `${row.recognisedStudents}/${row.studentCount} recognised`, row.action]));
  report.unrecognisedStudents.forEach((row) => rows.push(["Student recognition", row.name, row.className, "Not recognised this week", `${row.totalPoints} total PITIS`, `Last positive award: ${row.lastPositiveAt}`]));
  report.unusualActivity.forEach((row) => rows.push(["Unusual activity", row.name, row.className, `${row.positivePoints} awarded / ${row.deductions} deducted`, `${row.transactions} transactions`, row.action]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

module.exports = { buildWeeklyPitisActionReport, weeklyPitisActionReportToCsv };
