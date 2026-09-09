const express = require("express");
const dayjs = require("dayjs");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

const REWARD_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "rewards");
if (!fs.existsSync(REWARD_UPLOAD_DIR)) {
  fs.mkdirSync(REWARD_UPLOAD_DIR, { recursive: true });
}

const rewardImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, REWARD_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const base = path.basename(file.originalname || "reward", ext).replace(/[^a-zA-Z0-9_-]/g, "_") || "reward";
    cb(null, `${base}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const rewardImageUpload = multer({
  storage: rewardImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowedExt = [".jpg", ".jpeg", ".png", ".webp"];
    if (mime.startsWith("image/") && allowedExt.includes(ext)) return cb(null, true);
    return cb(new Error("Only JPG, JPEG, PNG, and WEBP image files are allowed"));
  }
});

function removeManagedRewardImageIfExists(imagePath) {
  const rel = String(imagePath || "").trim();
  if (!rel || !rel.startsWith("/uploads/rewards/")) return;
  const abs = path.join(__dirname, "..", "..", "public", rel.replace(/^\//, ""));
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (_) {}
  }
}

function normalizeRewardImagePath(file) {
  if (!file) return "";
  const rel = path.join("uploads", "rewards", file.filename).replace(/\\/g, "/");
  return `/${rel}`;
}

function normalizeRewardPayload(body) {
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const pointsRequired = Number.parseInt(String(body.points_required || "").trim(), 10);
  const isActive = String(body.is_active || "1") === "1" ? 1 : 0;
  return {
    title,
    description,
    pointsRequired,
    isActive
  };
}

function validateRewardPayload(payload) {
  if (!payload.title) return "Reward title is required";
  if (!Number.isInteger(payload.pointsRequired) || payload.pointsRequired <= 0) {
    return "Points required must be a positive integer";
  }
  return "";
}

function listRewards(includeInactive = false) {
  const whereSql = includeInactive ? "" : "WHERE COALESCE(r.is_active, 1) = 1";
  return db.prepare(
    `SELECT
       r.id,
       r.title,
       COALESCE(r.description, '') AS description,
       r.points_required,
       COALESCE(r.image_path, '') AS image_path,
       COALESCE(r.is_active, 1) AS is_active,
       r.created_by,
       r.created_at,
       r.updated_at,
       u.display_name AS creator_name
     FROM rewards_gallery r
     LEFT JOIN users u ON u.id = r.created_by
     ${whereSql}
     ORDER BY COALESCE(r.is_active, 1) DESC, r.points_required ASC, LOWER(r.title) ASC, r.created_at DESC`
  ).all();
}

function listRewardCreators(includeInactive = false) {
  const whereSql = includeInactive ? "" : "WHERE COALESCE(r.is_active, 1) = 1";
  return db.prepare(
    `SELECT DISTINCT
       u.id,
       COALESCE(u.display_name, u.username, 'Teacher') AS display_name
     FROM rewards_gallery r
     LEFT JOIN users u ON u.id = r.created_by
     ${whereSql}
       ${whereSql ? "AND" : "WHERE"} u.id IS NOT NULL
     ORDER BY LOWER(COALESCE(u.display_name, u.username, 'Teacher')) ASC`
  ).all();
}

function getRewardById(rewardId) {
  return db.prepare(
    `SELECT id, title, COALESCE(description, '') AS description, points_required, COALESCE(image_path, '') AS image_path,
            COALESCE(is_active, 1) AS is_active, created_by, created_at, updated_at
     FROM rewards_gallery
     WHERE id = ?`
  ).get(rewardId);
}

router.get("/rewards", (req, res) => {
  const rewards = listRewards(false);
  const rewardCreators = listRewardCreators(false);
  res.render("rewards-gallery", {
    user: req.session.user || null,
    rewards,
    rewardCreators,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/teacher/rewards", requireRole(["teacher", "staff", "admin"]), (req, res) => {
  const rewards = listRewards(true);
  res.render("rewards-manage", {
    user: req.session.user,
    rewards,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/teacher/rewards", requireRole(["teacher", "staff", "admin"]), rewardImageUpload.single("reward_image"), (req, res) => {
  const payload = normalizeRewardPayload(req.body);
  const validationError = validateRewardPayload(payload);
  if (validationError) {
    if (req.file) removeManagedRewardImageIfExists(normalizeRewardImagePath(req.file));
    return res.redirect(`/teacher/rewards?error=${encodeURIComponent(validationError)}`);
  }

  const imagePath = req.file ? normalizeRewardImagePath(req.file) : null;
  db.prepare(
    `INSERT INTO rewards_gallery
     (title, description, points_required, image_path, is_active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    payload.title,
    payload.description || null,
    payload.pointsRequired,
    imagePath,
    payload.isActive,
    req.session.user.id,
    dayjs().toISOString(),
    dayjs().toISOString()
  );

  return res.redirect("/teacher/rewards?success=Reward+added");
});

router.post("/teacher/rewards/:id/update", requireRole(["teacher", "staff", "admin"]), rewardImageUpload.single("reward_image"), (req, res) => {
  const rewardId = Number(req.params.id || 0);
  const existing = getRewardById(rewardId);
  if (!rewardId || !existing) {
    if (req.file) removeManagedRewardImageIfExists(normalizeRewardImagePath(req.file));
    return res.redirect("/teacher/rewards?error=Reward+not+found");
  }

  const payload = normalizeRewardPayload(req.body);
  const validationError = validateRewardPayload(payload);
  if (validationError) {
    if (req.file) removeManagedRewardImageIfExists(normalizeRewardImagePath(req.file));
    return res.redirect(`/teacher/rewards?error=${encodeURIComponent(validationError)}`);
  }

  const shouldRemoveImage = String(req.body.remove_image || "") === "1";
  let nextImagePath = existing.image_path || null;

  if (req.file) {
    nextImagePath = normalizeRewardImagePath(req.file);
  } else if (shouldRemoveImage) {
    nextImagePath = null;
  }

  db.prepare(
    `UPDATE rewards_gallery
     SET title = ?, description = ?, points_required = ?, image_path = ?, is_active = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    payload.title,
    payload.description || null,
    payload.pointsRequired,
    nextImagePath,
    payload.isActive,
    dayjs().toISOString(),
    rewardId
  );

  if ((req.file || shouldRemoveImage) && existing.image_path && existing.image_path !== nextImagePath) {
    removeManagedRewardImageIfExists(existing.image_path);
  }

  return res.redirect("/teacher/rewards?success=Reward+updated");
});

router.post("/teacher/rewards/:id/delete", requireRole(["teacher", "staff", "admin"]), (req, res) => {
  const rewardId = Number(req.params.id || 0);
  const existing = getRewardById(rewardId);
  if (!rewardId || !existing) {
    return res.redirect("/teacher/rewards?error=Reward+not+found");
  }

  db.prepare("DELETE FROM rewards_gallery WHERE id = ?").run(rewardId);
  removeManagedRewardImageIfExists(existing.image_path);
  return res.redirect("/teacher/rewards?success=Reward+deleted");
});

router.use((err, _req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    return res.redirect(`/teacher/rewards?error=${encodeURIComponent(`Upload failed: ${err.message}`)}`);
  }

  if (String(err.message || "").includes("Only JPG, JPEG, PNG, and WEBP image files are allowed")) {
    return res.redirect("/teacher/rewards?error=Upload+failed:+only+JPG,+JPEG,+PNG,+and+WEBP+images+are+allowed");
  }

  return next(err);
});

module.exports = router;
