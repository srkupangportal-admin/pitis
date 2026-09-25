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
         SUM(CASE WHEN avatar_path LIKE '/images/student-avatars/%' THEN 1 ELSE 0 END) AS default_avatars,
         SUM(CASE
           WHEN NULLIF(TRIM(avatar_path), '') IS NOT NULL
             AND avatar_path NOT LIKE '/images/student-avatars/%'
           THEN 1 ELSE 0
         END) AS custom_avatars
  FROM students
`).get();
db.close();

const forbiddenStudentPhotoColumn = /^photo(?:_[2-6])?_(?:path|uploaded_at|uploaded_by)$/;
assert(studentColumns.includes("avatar_path"), "students.avatar_path is missing");
assert(!studentColumns.some((name) => forbiddenStudentPhotoColumn.test(name)), "Legacy student-photo columns still exist");
assert(!fs.existsSync(path.join(projectRoot, "src/services/studentPhotoStorageService.js")), "Legacy student-photo storage service still exists");
assert(!fs.existsSync(path.join(projectRoot, "private/student-photos")), "Private student-photo files still exist");
assert(!fs.existsSync(path.join(projectRoot, "public/uploads/students")), "Public student-photo files still exist");

const leaderboardQueries = read("src/services/leaderboardQueryService.js");
const pwaRoutes = read("src/routes/pwaRoutes.js");
const teacherRoutes = read("src/routes/teacherRoutes.js");
const adminRoutes = read("src/routes/adminRoutes.js");
const studentDetail = read("views/student-detail.ejs");
const adminDashboard = read("views/admin-dashboard.ejs");
const attendanceView = read("views/teacher-attendance.ejs");
const rewardView = read("views/teacher-reward.ejs");
const serverSource = read("src/server.js");

assert(!leaderboardQueries.includes("photo_path"), "Leaderboard queries must never use student photographs");
assert(!pwaRoutes.includes("photo_path"), "PWA routes must never use student photographs");
assert(!pwaRoutes.includes("SELECT s.id, s.class_id, s.student_id"), "PWA scan responses must not select registration identifiers");
assert(!pwaRoutes.includes("s.full_name, NULLIF(s.avatar_path"), "PWA student responses must not expose full legal names");
assert(leaderboardQueries.includes("s.avatar_path"), "Leaderboard queries must use student avatars");
assert(pwaRoutes.includes("s.avatar_path"), "PWA routes must use student avatars");
assert(teacherRoutes.includes('router.use("/students"'), "Student details role boundary is missing");
assert(!teacherRoutes.includes("photo_file"), "Teacher routes still accept student photographs");
assert(!teacherRoutes.includes("/photos/:slot"), "Teacher student-photo routes still exist");
assert(!adminRoutes.includes("STUDENT_PHOTO_UPLOAD_FIELDS") && !adminRoutes.includes('single("photo_file")'), "Admin routes still accept student photographs");
assert(!adminRoutes.includes("studentPhotoStorageService"), "Admin routes still load student-photo storage");
assert(!studentDetail.includes("photo_file") && !studentDetail.includes("Take Photo"), "Student Details still offers photograph capture/upload");
assert(!adminDashboard.includes("Private Reference Photos") && !adminDashboard.includes("photo_file"), "Admin dashboard still offers student photograph upload");
assert(attendanceView.includes("student.avatar_path"), "Attendance must display student avatars");
assert(!rewardView.includes("api.dicebear.com"), "Student names must not be sent to an external avatar provider");
assert(!serverSource.includes('app.use("/uploads/students"'), "Student photographs must not be mounted as static web files");
assert(serverSource.includes('app.use("/uploads/avatars"'), "Customized avatars must have a dedicated public mount");
assert(adminRoutes.includes('avatarUpload.single("avatar_file")'), "Admin avatar upload is not configured");
assert(adminRoutes.includes('["image/jpeg", "image/png", "image/webp"]'), "Avatar uploads must be restricted to safe raster formats");

console.log(`Student privacy check passed: ${counts.students} students, no real-photo fields or files, ${counts.default_avatars || 0} default avatars, ${counts.custom_avatars || 0} customized avatars.`);
