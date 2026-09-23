const express = require("express");
const dayjs = require("dayjs");
const { db, updateDailySnapshot } = require("../db/init");
const { parseStudentQrPayload } = require("../services/qrCodeService");

const router = express.Router();

function recordPwaActivity(userId, counter, classId = null) {
  const allowedCounters = new Set(["page_views", "bootstrap_count", "scan_count", "transaction_count"]);
  if (!allowedCounters.has(counter)) return;
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO pwa_user_activity (user_id, first_seen_at, last_seen_at, ${counter}, last_class_id, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      ${counter} = ${counter} + 1,
      last_class_id = COALESCE(excluded.last_class_id, last_class_id),
      updated_at = excluded.updated_at
  `).run(userId, now, now, classId || null, now);
}

router.use((req, res, next) => {
  const user = req.session.user;
  if (!user) return res.redirect(`/login?next=${encodeURIComponent("/pwa")}`);
  if (user.mustChangePassword) return res.redirect("/account/change-password");
  if (!["teacher", "staff", "admin"].includes(user.role)) return res.status(403).send("Forbidden");
  res.set("Cache-Control", "private, no-store");
  return next();
});

router.get("/", (req, res) => {
  recordPwaActivity(req.session.user.id, "page_views", Number(req.session.pwaQuickPitisClassId || 0));
  res.render("pwa-quick-pitis", { user: req.session.user });
});

router.get("/api/bootstrap", (req, res) => {
  recordPwaActivity(req.session.user.id, "bootstrap_count", Number(req.session.pwaQuickPitisClassId || 0));
  const classes = db.prepare(`
    SELECT c.id, c.name, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.name COLLATE NOCASE
  `).all();
  const reasons = db.prepare(`
    SELECT pr.id, pr.reason, pr.reason_type, pr.is_custom,
           CASE WHEN COALESCE(pr.is_custom, 0) = 0
                  OR EXISTS (SELECT 1 FROM users creator WHERE creator.id = pr.created_by AND creator.role = 'admin')
                THEN 1 ELSE 0 END AS is_default
    FROM point_reasons pr
    ORDER BY pr.reason_type, is_default DESC, pr.reason COLLATE NOCASE, pr.id
  `).all();
  res.json({
    user: {
      id: req.session.user.id,
      displayName: req.session.user.displayName,
      role: req.session.user.role
    },
    selectedClassId: Number(req.session.pwaQuickPitisClassId || 0) || null,
    classes,
    reasons
  });
});

router.post("/api/preferences", (req, res) => {
  const classId = Number(req.body.class_id || 0);
  if (classId) {
    const exists = db.prepare("SELECT id FROM classes WHERE id = ?").get(classId);
    if (!exists) return res.status(404).json({ error: "Class not found." });
    req.session.pwaQuickPitisClassId = classId;
  } else {
    delete req.session.pwaQuickPitisClassId;
  }
  req.session.save((error) => {
    if (error) return res.status(500).json({ error: "Unable to remember the selected class." });
    return res.json({ ok: true, class_id: classId || null });
  });
});

router.get("/api/classes/:classId/students", (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId) || classId < 1) return res.status(400).json({ error: "Choose a valid class." });
  const cls = db.prepare("SELECT id, name FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).json({ error: "Class not found." });
  const students = db.prepare(`
    SELECT s.id,
           COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
           s.full_name,
           NULLIF(s.photo_path, '') AS photo_src,
           COALESCE(SUM(pl.points), 0) AS total_points
    FROM students s
    LEFT JOIN point_logs pl ON pl.student_id = s.id
    WHERE s.class_id = ?
    GROUP BY s.id
    ORDER BY COALESCE(NULLIF(s.name, ''), s.full_name) COLLATE NOCASE
  `).all(classId);
  res.json({ class: cls, students });
});

router.post("/api/scan", (req, res) => {
  const qrText = String(req.body.qr_text || "").trim();
  if (!qrText) return res.status(400).json({ error: "Scan or enter a student QR code." });
  try {
    const parsed = parseStudentQrPayload(qrText);
    const student = db.prepare(`
      SELECT s.id, s.class_id, s.student_id, s.qr_token,
             COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
             s.full_name, NULLIF(s.photo_path, '') AS photo_src,
             c.name AS class_name,
             COALESCE((SELECT SUM(points) FROM point_logs WHERE student_id = s.id), 0) AS total_points
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE s.id = ? AND s.student_id = ? AND s.qr_token = ?
    `).get(parsed.student_pk, parsed.student_id, parsed.qr_token);
    if (!student) return res.status(404).json({ error: "Student was not found for this QR code." });
    recordPwaActivity(req.session.user.id, "scan_count", Number(student.class_id));
    return res.json({ student });
  } catch (_error) {
    return res.status(400).json({ error: "This is not a valid student QR code." });
  }
});

router.post("/api/transactions", (req, res) => {
  const classId = Number(req.body.class_id);
  const studentId = Number(req.body.student_id);
  const action = String(req.body.action || "").trim().toLowerCase();
  const amount = Number(req.body.amount);
  const reasonId = Number(req.body.reason_id || 0);
  const customReason = String(req.body.custom_reason || "").trim().replace(/\s+/g, " ");

  if (!Number.isInteger(classId) || classId < 1 || !Number.isInteger(studentId) || studentId < 1) {
    return res.status(400).json({ error: "Choose a class and student." });
  }
  if (!["award", "deduct"].includes(action)) return res.status(400).json({ error: "Choose Award or Deduct." });
  if (!Number.isInteger(amount) || amount < 1 || amount > 5) {
    return res.status(400).json({ error: "Choose a PITIS value from 1 to 5." });
  }
  if (customReason.length > 120) return res.status(400).json({ error: "Reason must be 120 characters or fewer." });

  const student = db.prepare(`
    SELECT id, class_id, COALESCE(NULLIF(name, ''), full_name) AS nickname, full_name
    FROM students WHERE id = ? AND class_id = ?
  `).get(studentId, classId);
  if (!student) return res.status(404).json({ error: "Student was not found in that class." });

  const reasonType = action === "award" ? "positive" : "negative";
  let reason = customReason;
  if (!reason) {
    const selectedReason = db.prepare("SELECT id, reason, reason_type FROM point_reasons WHERE id = ?").get(reasonId);
    if (!selectedReason) return res.status(400).json({ error: "Choose a reason or create a new reason." });
    if (String(selectedReason.reason_type) !== reasonType) {
      return res.status(400).json({ error: "The reason does not match the selected action." });
    }
    reason = selectedReason.reason;
  }

  const points = action === "deduct" ? -amount : amount;
  const now = dayjs().toISOString();
  let createdReasonId = null;

  const save = db.transaction(() => {
    if (customReason) {
      const existing = db.prepare("SELECT id, reason_type FROM point_reasons WHERE LOWER(reason) = LOWER(?)").get(customReason);
      if (existing && String(existing.reason_type) !== reasonType) {
        const error = new Error("This reason already exists for the opposite action.");
        error.code = "REASON_TYPE_CONFLICT";
        throw error;
      }
      if (existing) {
        createdReasonId = Number(existing.id);
      } else {
        const inserted = db.prepare(`
          INSERT INTO point_reasons (reason, reason_type, created_by, is_custom, created_at)
          VALUES (?, ?, ?, 1, ?)
        `).run(customReason, reasonType, req.session.user.id, now);
        createdReasonId = Number(inserted.lastInsertRowid);
      }
    }
    db.prepare(`
      INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(student.id, student.class_id, points, reason, req.session.user.id, now);
    updateDailySnapshot(student.id);
  });

  try {
    save();
  } catch (error) {
    if (error && error.code === "REASON_TYPE_CONFLICT") return res.status(409).json({ error: error.message });
    throw error;
  }

  const total = Number(db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM point_logs WHERE student_id = ?").get(student.id).total || 0);
  recordPwaActivity(req.session.user.id, "transaction_count", Number(student.class_id));
  return res.status(201).json({
    ok: true,
    student: { id: student.id, name: student.nickname || student.full_name, total_points: total },
    transaction: { action, amount, points, reason },
    reason: customReason ? { id: createdReasonId, reason, reason_type: reasonType, is_custom: 1 } : null
  });
});

module.exports = router;
