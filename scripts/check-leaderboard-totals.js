const Database = require("better-sqlite3");
const path = require("path");
const dayjs = require("dayjs");
const { schoolLeaderboardQuery } = require("../src/services/leaderboardQueryService");

const databasePath = path.resolve(process.env.DB_PATH || path.join(__dirname, "..", "data.db"));
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

const weekStart = dayjs().subtract((dayjs().day() + 6) % 7, "day").format("YYYY-MM-DD");
const leaderboardRows = db.prepare(schoolLeaderboardQuery).all(weekStart);
const reportTotals = new Map(db.prepare(`
  SELECT s.id, COALESCE(SUM(pl.points), 0) AS total
  FROM students s
  LEFT JOIN point_logs pl ON pl.student_id = s.id
  GROUP BY s.id
`).all().map((row) => [Number(row.id), Number(row.total || 0)]));
const rows = leaderboardRows.map((row) => ({
  ...row,
  leaderboard_total: Number(row.total_points || 0),
  report_total: Number(reportTotals.get(Number(row.id)) || 0)
}));

db.close();

const mismatches = rows.filter((row) => Number(row.leaderboard_total) !== Number(row.report_total));
if (mismatches.length) {
  console.error(JSON.stringify(mismatches, null, 2));
  throw new Error(`${mismatches.length} leaderboard total(s) do not match the student report total.`);
}

const rayyan = rows.find((row) => Number(row.id) === 107);
console.log(`Leaderboard totals match student report totals for ${rows.length} students.`);
if (rayyan) console.log(`Rayyan total: ${rayyan.leaderboard_total}`);
