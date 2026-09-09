const express = require("express");
const multer = require("multer");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");
const { importStudentsFromCsv } = require("../services/csvImportService");
const { buildStudentTemplateCsv } = require("../services/studentSchema");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const isCsv = (file.mimetype || "").includes("csv") || /\.csv$/i.test(file.originalname || "");
    if (isCsv) return cb(null, true);
    return cb(new Error("Only CSV files are allowed"));
  },
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

router.use(requireRole("admin"));

router.get("/students/template", (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="student-import-template.csv"');
  return res.send(buildStudentTemplateCsv());
});

router.post("/students/import", upload.single("students_csv"), async (req, res) => {
  try {
    if (!req.file) {
      return res.redirect("/admin/dashboard?error=CSV+file+required");
    }

    const replaceAll = String(req.body.replace_all_students || "") === "1";
    const result = await importStudentsFromCsv({
      db,
      fileBuffer: req.file.buffer,
      replaceAll
    });

    const summary = [
      `Students imported: ${result.importedCount}`,
      `Updated: ${result.updatedCount}`
    ];

    if (result.backupPath) {
      summary.push(`Backup: ${result.backupPath}`);
    }

    return res.redirect(`/admin/dashboard?success=${encodeURIComponent(summary.join(". "))}`);
  } catch (error) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Import failed: ${error.message}`)}`);
  }
});

router.use((err, _req, res, next) => {
  if (!err) {
    return next();
  }

  if (err instanceof multer.MulterError) {
    return res.redirect(`/admin/dashboard?error=${encodeURIComponent(`Upload failed: ${err.message}`)}`);
  }

  if (String(err.message || "").includes("Only CSV files are allowed")) {
    return res.redirect("/admin/dashboard?error=Upload+failed:+only+CSV+files+are+allowed");
  }

  return next(err);
});

module.exports = router;
