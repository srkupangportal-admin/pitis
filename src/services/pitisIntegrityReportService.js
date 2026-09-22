const dayjs = require("dayjs");
const { db } = require("../db/init");
const { schoolLeaderboardQuery } = require("./leaderboardQueryService");

const DETAIL_LIMIT = 250;

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildCheck(key, title, severity, description, rows, total = rows.length) {
  return {
    key,
    title,
    severity,
    description,
    total: Number(total || 0),
    truncated: Number(total || 0) > rows.length,
    status: Number(total || 0) > 0 ? "review" : "passed",
    rows
  };
}

function buildPitisIntegrityReport() {
  const weekStart = dayjs().subtract((dayjs().day() + 6) % 7, "day").format("YYYY-MM-DD");
  const leaderboardRows = db.prepare(schoolLeaderboardQuery).all(weekStart);
  const ledgerRows = db.prepare(`
    SELECT s.id, COALESCE(SUM(pl.points), 0) AS ledger_total
    FROM students s
    LEFT JOIN point_logs pl ON pl.student_id = s.id
    GROUP BY s.id
  `).all();
  const ledgerTotals = new Map(ledgerRows.map((row) => [Number(row.id), Number(row.ledger_total || 0)]));
  const leaderboardMismatches = leaderboardRows
    .filter((row) => Number(row.total_points || 0) !== Number(ledgerTotals.get(Number(row.id)) || 0))
    .map((row) => ({
      student: row.nickname,
      class_name: row.class_name,
      expected: Number(ledgerTotals.get(Number(row.id)) || 0),
      actual: Number(row.total_points || 0),
      details: `Student ID ${row.id}`
    }));

  const exactDuplicateTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM point_logs
      GROUP BY student_id, class_id, points, reason, awarded_by, awarded_at
      HAVING COUNT(*) > 1
    ) duplicate_groups
  `).get().total || 0);
  const exactDuplicates = db.prepare(`
    SELECT COALESCE(NULLIF(s.name, ''), s.full_name) AS student, c.name AS class_name,
           pl.points AS actual, COUNT(*) AS occurrence_count, pl.reason,
           pl.awarded_at, COALESCE(u.display_name, u.username, 'Unknown') AS awarded_by
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    LEFT JOIN classes c ON c.id = pl.class_id
    LEFT JOIN users u ON u.id = pl.awarded_by
    GROUP BY pl.student_id, pl.class_id, pl.points, pl.reason, pl.awarded_by, pl.awarded_at
    HAVING COUNT(*) > 1
    ORDER BY occurrence_count DESC, pl.awarded_at DESC
    LIMIT ?
  `).all(DETAIL_LIMIT).map((row) => ({
    student: row.student,
    class_name: row.class_name,
    expected: "1 transaction",
    actual: `${row.occurrence_count} transactions`,
    details: `${row.actual} PITIS · ${row.reason} · ${row.awarded_by} · ${row.awarded_at}`
  }));

  const collisionTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM point_logs GROUP BY student_id, awarded_at HAVING COUNT(*) > 1
    ) timestamp_groups
  `).get().total || 0);
  const timestampCollisions = db.prepare(`
    SELECT COALESCE(NULLIF(s.name, ''), s.full_name) AS student, c.name AS class_name,
           pl.awarded_at, COUNT(*) AS occurrence_count, SUM(pl.points) AS point_total
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    JOIN classes c ON c.id = s.class_id
    GROUP BY pl.student_id, pl.awarded_at
    HAVING COUNT(*) > 1
    ORDER BY occurrence_count DESC, pl.awarded_at DESC
    LIMIT ?
  `).all(DETAIL_LIMIT).map((row) => ({
    student: row.student,
    class_name: row.class_name,
    expected: "Review",
    actual: `${row.occurrence_count} transactions`,
    details: `${row.point_total} net PITIS at ${row.awarded_at}`
  }));

  const classMismatchTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM point_logs pl JOIN students s ON s.id = pl.student_id
    WHERE pl.class_id <> s.class_id
  `).get().total || 0);
  const classMismatches = db.prepare(`
    SELECT COALESCE(NULLIF(s.name, ''), s.full_name) AS student,
           current_class.name AS class_name, logged_class.name AS logged_class,
           pl.points, pl.reason, pl.awarded_at
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    LEFT JOIN classes current_class ON current_class.id = s.class_id
    LEFT JOIN classes logged_class ON logged_class.id = pl.class_id
    WHERE pl.class_id <> s.class_id
    ORDER BY pl.awarded_at DESC
    LIMIT ?
  `).all(DETAIL_LIMIT).map((row) => ({
    student: row.student,
    class_name: row.class_name,
    expected: row.class_name,
    actual: row.logged_class || "Missing class",
    details: `${row.points} PITIS · ${row.reason} · ${row.awarded_at}`
  }));

  const futureTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total FROM point_logs
    WHERE datetime(awarded_at) > datetime('now', '+5 minutes')
  `).get().total || 0);
  const futureTransactions = db.prepare(`
    SELECT COALESCE(NULLIF(s.name, ''), s.full_name) AS student, c.name AS class_name,
           pl.points, pl.reason, pl.awarded_at
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    LEFT JOIN classes c ON c.id = pl.class_id
    WHERE datetime(pl.awarded_at) > datetime('now', '+5 minutes')
    ORDER BY pl.awarded_at DESC
    LIMIT ?
  `).all(DETAIL_LIMIT).map((row) => ({
    student: row.student,
    class_name: row.class_name,
    expected: "Not future-dated",
    actual: row.awarded_at,
    details: `${row.points} PITIS · ${row.reason}`
  }));

  const unusualPointTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total FROM point_logs WHERE points = 0 OR ABS(points) > 5
  `).get().total || 0);
  const unusualPoints = db.prepare(`
    SELECT COALESCE(NULLIF(s.name, ''), s.full_name) AS student, c.name AS class_name,
           pl.points, pl.reason, pl.awarded_at
    FROM point_logs pl
    JOIN students s ON s.id = pl.student_id
    LEFT JOIN classes c ON c.id = pl.class_id
    WHERE pl.points = 0 OR ABS(pl.points) > 5
    ORDER BY ABS(pl.points) DESC, pl.awarded_at DESC
    LIMIT ?
  `).all(DETAIL_LIMIT).map((row) => ({
    student: row.student,
    class_name: row.class_name,
    expected: "1 to 5 or -1 to -5",
    actual: row.points,
    details: `${row.reason} · ${row.awarded_at}`
  }));

  const snapshotDate = dayjs().format("YYYY-MM-DD");
  const snapshotMismatchTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM daily_points dp
    LEFT JOIN (SELECT student_id, SUM(points) AS total FROM point_logs GROUP BY student_id) ledger
      ON ledger.student_id = dp.student_id
    WHERE dp.snapshot_date = ? AND dp.total_points <> COALESCE(ledger.total, 0)
  `).get(snapshotDate).total || 0);
  const snapshotMismatches = db.prepare(`
    SELECT COALESCE(NULLIF(s.name, ''), s.full_name) AS student, c.name AS class_name,
           dp.total_points AS snapshot_total, COALESCE(ledger.total, 0) AS ledger_total
    FROM daily_points dp
    JOIN students s ON s.id = dp.student_id
    JOIN classes c ON c.id = s.class_id
    LEFT JOIN (SELECT student_id, SUM(points) AS total FROM point_logs GROUP BY student_id) ledger
      ON ledger.student_id = dp.student_id
    WHERE dp.snapshot_date = ? AND dp.total_points <> COALESCE(ledger.total, 0)
    ORDER BY s.full_name
    LIMIT ?
  `).all(snapshotDate, DETAIL_LIMIT).map((row) => ({
    student: row.student,
    class_name: row.class_name,
    expected: row.ledger_total,
    actual: row.snapshot_total,
    details: `Snapshot date ${snapshotDate}`
  }));

  const missingReferenceTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM point_logs pl
    LEFT JOIN students s ON s.id = pl.student_id
    LEFT JOIN classes c ON c.id = pl.class_id
    LEFT JOIN users u ON u.id = pl.awarded_by
    WHERE s.id IS NULL OR c.id IS NULL OR u.id IS NULL OR TRIM(COALESCE(pl.reason, '')) = ''
  `).get().total || 0);
  const missingReferences = db.prepare(`
    SELECT pl.id, COALESCE(NULLIF(s.name, ''), s.full_name, 'Missing student') AS student,
           COALESCE(c.name, 'Missing class') AS class_name, pl.points, pl.reason, pl.awarded_at,
           CASE WHEN s.id IS NULL THEN 'Missing student' WHEN c.id IS NULL THEN 'Missing class'
                WHEN u.id IS NULL THEN 'Missing awarding user' ELSE 'Missing reason' END AS problem
    FROM point_logs pl
    LEFT JOIN students s ON s.id = pl.student_id
    LEFT JOIN classes c ON c.id = pl.class_id
    LEFT JOIN users u ON u.id = pl.awarded_by
    WHERE s.id IS NULL OR c.id IS NULL OR u.id IS NULL OR TRIM(COALESCE(pl.reason, '')) = ''
    ORDER BY pl.id DESC
    LIMIT ?
  `).all(DETAIL_LIMIT).map((row) => ({
    student: row.student,
    class_name: row.class_name,
    expected: "Complete references",
    actual: row.problem,
    details: `Transaction ${row.id} · ${row.points} PITIS · ${row.awarded_at}`
  }));

  const checks = [
    buildCheck("leaderboard", "Leaderboard and ledger totals", "critical", "Confirms that the displayed leaderboard total equals the transaction ledger for every student.", leaderboardMismatches),
    buildCheck("references", "Missing transaction references", "critical", "Finds transactions with a missing student, class, awarding user, or reason.", missingReferences, missingReferenceTotal),
    buildCheck("future", "Future-dated transactions", "critical", "Finds transactions recorded more than five minutes in the future.", futureTransactions, futureTotal),
    buildCheck("duplicates", "Exact duplicate transactions", "warning", "Finds identical transaction groups. Review before removing because legitimate bulk records can share some values.", exactDuplicates, exactDuplicateTotal),
    buildCheck("timestamps", "Same-student timestamp collisions", "warning", "Finds multiple transactions for one student at the exact same time. These are retained but must never multiply report totals.", timestampCollisions, collisionTotal),
    buildCheck("classes", "Logged class differs from current class", "warning", "Highlights historical transactions whose logged class differs from the student's current class. A class move can be legitimate.", classMismatches, classMismatchTotal),
    buildCheck("points", "Unusual PITIS amounts", "warning", "Finds zero-value transactions or single transactions outside the normal -5 to +5 range.", unusualPoints, unusualPointTotal),
    buildCheck("snapshots", "Today's snapshot and ledger totals", "warning", "Confirms today's cached student total matches the transaction ledger.", snapshotMismatches, snapshotMismatchTotal)
  ];
  const criticalIssues = checks.filter((check) => check.severity === "critical").reduce((sum, check) => sum + check.total, 0);
  const warnings = checks.filter((check) => check.severity === "warning").reduce((sum, check) => sum + check.total, 0);
  return {
    generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    status: criticalIssues ? "critical" : warnings ? "review" : "healthy",
    summary: {
      students: leaderboardRows.length,
      transactions: Number(db.prepare("SELECT COUNT(*) AS total FROM point_logs").get().total || 0),
      checks: checks.length,
      passed: checks.filter((check) => check.status === "passed").length,
      criticalIssues,
      warnings
    },
    checks
  };
}

function pitisIntegrityReportToCsv(report) {
  const header = ["check", "severity", "status", "student", "class", "expected", "actual", "details"];
  const rows = [];
  report.checks.forEach((check) => {
    if (!check.rows.length) {
      rows.push([check.title, check.severity, "passed", "", "", "", "", check.description]);
      return;
    }
    check.rows.forEach((row) => rows.push([
      check.title,
      check.severity,
      "review",
      row.student,
      row.class_name,
      row.expected,
      row.actual,
      row.details
    ]));
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

module.exports = { buildPitisIntegrityReport, pitisIntegrityReportToCsv };
