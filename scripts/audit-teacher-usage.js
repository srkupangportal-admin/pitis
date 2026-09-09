const { initializeDatabase } = require("../src/db/init");
const { runTeacherUsageAudit } = require("../src/services/teacherUsageAuditService");

initializeDatabase();

try {
  const result = runTeacherUsageAudit({ trigger_type: "manual" });
  console.log(`Teacher usage audit complete: ${result.date_from} to ${result.date_to}`);
  console.log(`Users: ${result.user_count}, weeks: ${result.week_count}, run id: ${result.id}`);
} catch (error) {
  console.error("Teacher usage audit failed:", error.message || error);
  process.exitCode = 1;
}
