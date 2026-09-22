const Database = require("better-sqlite3");
const path = require("path");

const databasePath = path.resolve(process.env.DB_PATH || path.join(__dirname, "..", "data.db"));
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT
    s.id,
    COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
    COALESCE(SUM(pl.points), 0) AS leaderboard_total,
    (SELECT COALESCE(SUM(p.points), 0) FROM point_logs p WHERE p.student_id = s.id) AS report_total
  FROM students s
  LEFT JOIN point_logs pl ON pl.student_id = s.id
  LEFT JOIN (
    SELECT student_id, awarded_at, reason
    FROM (
      SELECT student_id, awarded_at, reason,
             ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY awarded_at DESC, id DESC) AS row_number
      FROM point_logs
      WHERE points > 0
    ) ranked_logs
    WHERE row_number = 1
  ) last_log ON last_log.student_id = s.id
  GROUP BY s.id, s.name, s.full_name, last_log.awarded_at, last_log.reason
`).all();

db.close();

const mismatches = rows.filter((row) => Number(row.leaderboard_total) !== Number(row.report_total));
if (mismatches.length) {
  console.error(JSON.stringify(mismatches, null, 2));
  throw new Error(`${mismatches.length} leaderboard total(s) do not match the student report total.`);
}

const rayyan = rows.find((row) => Number(row.id) === 107);
console.log(`Leaderboard totals match student report totals for ${rows.length} students.`);
if (rayyan) console.log(`Rayyan total: ${rayyan.leaderboard_total}`);
