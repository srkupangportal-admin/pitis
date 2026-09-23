const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const projectRoot = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const dbPath = path.resolve(projectRoot, process.env.DB_PATH || "data.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const studentColumns = db.prepare("PRAGMA table_info(students)").all().map((row) => row.name);
const counts = db.prepare(`
  SELECT COUNT(*) AS students,
         SUM(CASE WHEN NULLIF(TRIM(photo_path), '') IS NOT NULL THEN 1 ELSE 0 END) AS reference_photos,
         SUM(CASE WHEN NULLIF(TRIM(avatar_path), '') IS NOT NULL THEN 1 ELSE 0 END) AS avatars
  FROM students
`).get();
db.close();

assert(studentColumns.includes("avatar_path"), "students.avatar_path is missing");

const leaderboardQueries = read("src/services/leaderboardQueryService.js");
const pwaRoutes = read("src/routes/pwaRoutes.js");
const teacherRoutes = read("src/routes/teacherRoutes.js");
const attendanceView = read("views/teacher-attendance.ejs");
const rewardView = read("views/teacher-reward.ejs");

assert(!leaderboardQueries.includes("photo_path"), "Leaderboard queries must never use student reference photos");
assert(!pwaRoutes.includes("photo_path"), "PWA routes must never use student reference photos");
assert(leaderboardQueries.includes("s.avatar_path"), "Leaderboard queries must use student avatars");
assert(pwaRoutes.includes("s.avatar_path"), "PWA routes must use student avatars");
assert(teacherRoutes.includes('router.use("/students"'), "Student details route privacy boundary is missing");
assert(teacherRoutes.includes('NULLIF(s.avatar_path, \'\') AS photo_src'), "Teacher operational tools must use student avatars");
assert(!attendanceView.includes("student.photo_path"), "Attendance must not display student reference photos");
assert(attendanceView.includes("student.avatar_path"), "Attendance must display student avatars");
assert(!rewardView.includes("api.dicebear.com"), "Student names must not be sent to an external avatar provider");

console.log(`Student privacy check passed: ${counts.students} students, ${counts.reference_photos || 0} preserved reference-photo records, ${counts.avatars || 0} customized avatars.`);
