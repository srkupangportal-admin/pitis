const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { requireAnyAuth } = require("../middleware/auth");

const router = express.Router();

const INFORMATION_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "informations");
if (!fs.existsSync(INFORMATION_UPLOAD_DIR)) {
  fs.mkdirSync(INFORMATION_UPLOAD_DIR, { recursive: true });
}

const informationStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, INFORMATION_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".pdf";
    const base = path.basename(file.originalname || "information", ext).replace(/[^a-zA-Z0-9_-]/g, "_") || "information";
    cb(null, `${base}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const informationUpload = multer({
  storage: informationStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if ((file.mimetype || "").includes("pdf") || ext === ".pdf") return cb(null, true);
    return cb(new Error("Only PDF files are allowed"));
  }
});

function resolveInformationCategory(existingCategoryRaw, newCategoryRaw) {
  const existingCategory = String(existingCategoryRaw || "").trim();
  const newCategory = String(newCategoryRaw || "").trim();

  if (newCategory) {
    const existingFolder = db.prepare("SELECT id FROM info_folders WHERE LOWER(name) = LOWER(?)").get(newCategory);
    if (existingFolder && existingFolder.id) {
      return { folderId: Number(existingFolder.id), folderName: newCategory };
    }

    const maxSortOrderRow = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS maxSortOrder FROM info_folders").get();
    const nextSortOrder = Number((maxSortOrderRow || {}).maxSortOrder || 0) + 1;
    const folderId = Number(
      db.prepare("INSERT INTO info_folders (name, created_at, sort_order) VALUES (?, ?, ?)").run(newCategory, dayjs().toISOString(), nextSortOrder).lastInsertRowid
    );
    return { folderId, folderName: newCategory };
  }

  if (!existingCategory) {
    throw new Error("Please choose an existing category or enter a new category");
  }

  if (existingCategory === "__guidelines__") {
    return { folderId: null, folderName: "Guidelines" };
  }

  const existingFolder = db.prepare("SELECT id, name FROM info_folders WHERE id = ?").get(Number(existingCategory));
  if (!existingFolder || !existingFolder.id) {
    throw new Error("Selected category is invalid");
  }

  return { folderId: Number(existingFolder.id), folderName: String(existingFolder.name || "").trim() || "Guidelines" };
}

router.use("/informations", requireAnyAuth);

function requireAdmin(req, res, next) {
  if ((req.session.user || {}).role !== "admin") {
    return res.redirect("/informations?error=Admin+access+required");
  }
  return next();
}

function getFolderById(folderId) {
  return db.prepare("SELECT id, name, sort_order FROM info_folders WHERE id = ?").get(Number(folderId));
}

function getInformationFileById(infoId) {
  return db.prepare("SELECT id, title, file_path, folder_id FROM information_files WHERE id = ?").get(Number(infoId));
}

router.get("/informations", (req, res) => {
  const sort = String(req.query.sort || "date").trim().toLowerCase() === "alpha" ? "alpha" : "date";
  const orderBy = sort === "alpha"
    ? "ORDER BY LOWER(COALESCE(folder.name, '')), LOWER(info.title) ASC, info.uploaded_at DESC"
    : "ORDER BY LOWER(COALESCE(folder.name, '')), info.uploaded_at DESC, LOWER(info.title) ASC";

  const files = db
    .prepare(
      `SELECT info.id, info.title, info.file_name, info.file_path, info.uploaded_at, info.folder_id, info.uploaded_by,
              u.display_name AS uploaded_by_name,
              folder.name AS folder_name
       FROM information_files info
       LEFT JOIN users u ON u.id = info.uploaded_by
       LEFT JOIN info_folders folder ON folder.id = info.folder_id
       ${orderBy}`
    )
    .all();

  const infoFolders = db.prepare(
    `SELECT folder.id, folder.name, folder.sort_order, COUNT(info.id) AS file_count
     FROM info_folders folder
     LEFT JOIN information_files info ON info.folder_id = folder.id
     GROUP BY folder.id, folder.name, folder.sort_order
     ORDER BY COALESCE(folder.sort_order, folder.id) ASC, LOWER(folder.name) ASC`
  ).all();
  const groupedMap = new Map();

  infoFolders.forEach((folder) => {
    const folderId = Number(folder.id);
    groupedMap.set(`folder:${folderId}`, {
      groupLabel: String(folder.name || "").trim() || "Guidelines",
      folderId,
      sortOrder: Number(folder.sort_order || folder.id || 0),
      fileCount: Number(folder.file_count || 0),
      items: []
    });
  });

  files.forEach((file) => {
    const groupLabel = String(file.folder_name || "").trim() || "Guidelines";
    const folderId = file.folder_id == null ? null : Number(file.folder_id);
    const groupKey = folderId == null ? "folder:guidelines" : `folder:${folderId}`;

    if (!groupedMap.has(groupKey)) {
      groupedMap.set(groupKey, {
        groupLabel,
        folderId,
        sortOrder: folderId == null ? -1 : Number(file.folder_id || 0),
        fileCount: 0,
        items: []
      });
    }

    const group = groupedMap.get(groupKey);
    group.items.push(file);
    group.fileCount += 1;
  });

  const groupedFiles = Array.from(groupedMap.values());
  groupedFiles.sort((a, b) => {
    if (a.groupLabel === "Guidelines" && b.groupLabel !== "Guidelines") return -1;
    if (b.groupLabel === "Guidelines" && a.groupLabel !== "Guidelines") return 1;
    return Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || a.groupLabel.localeCompare(b.groupLabel);
  });

  res.render("informations", {
    user: req.session.user,
    sort,
    infoFolders,
    groupedFiles,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.post("/informations/upload", informationUpload.array("information_pdf", 20), (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.redirect("/informations?error=At+least+one+PDF+file+is+required");
    }

    const category = resolveInformationCategory(req.body.folder_id, req.body.new_category);
    const uploadedBy = Number((req.session.user || {}).id || 0) || null;
    const insertFile = db.prepare(
      `INSERT INTO information_files (title, file_name, file_path, folder_id, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const now = dayjs().toISOString();

    files.forEach((file) => {
      const derivedTitle = path.basename(file.originalname || file.filename, path.extname(file.originalname || file.filename));
      const filePath = "/uploads/informations/" + file.filename;
      insertFile.run(derivedTitle, file.originalname || file.filename, filePath, category.folderId, uploadedBy, now);
    });

    const successLabel = files.length === 1 ? "1 PDF uploaded" : `${files.length} PDFs uploaded`;
    return res.redirect(`/informations?success=${encodeURIComponent(`${successLabel} to ${category.folderName}`)}`);
  } catch (err) {
    return res.redirect(`/informations?error=${encodeURIComponent(err.message || "Upload failed")}`);
  }
});

router.post("/informations/folders/:id/rename", requireAdmin, (req, res) => {
  const folderId = Number(req.params.id || 0);
  const name = String(req.body.name || "").trim();

  if (!folderId || !name) {
    return res.redirect("/informations?error=Category+name+required");
  }

  const existingFolder = getFolderById(folderId);
  if (!existingFolder) {
    return res.redirect("/informations?error=Category+not+found");
  }

  const duplicate = db.prepare("SELECT id FROM info_folders WHERE LOWER(name) = LOWER(?) AND id <> ?").get(name, folderId);
  if (duplicate) {
    return res.redirect("/informations?error=Another+category+already+uses+that+name");
  }

  db.prepare("UPDATE info_folders SET name = ? WHERE id = ?").run(name, folderId);
  return res.redirect("/informations?success=Category+renamed");
});

router.post("/informations/folders/:id/delete", requireAdmin, (req, res) => {
  const folderId = Number(req.params.id || 0);
  if (!folderId) {
    return res.redirect("/informations?error=Category+not+found");
  }

  const existingFolder = getFolderById(folderId);
  if (!existingFolder) {
    return res.redirect("/informations?error=Category+not+found");
  }

  const moveFiles = db.prepare("UPDATE information_files SET folder_id = NULL WHERE folder_id = ?");
  const deleteFolder = db.prepare("DELETE FROM info_folders WHERE id = ?");
  const tx = db.transaction(() => {
    moveFiles.run(folderId);
    deleteFolder.run(folderId);
  });

  tx();
  return res.redirect("/informations?success=Category+deleted.+Files+moved+to+Guidelines");
});

router.post("/informations/folders/:id/move", requireAdmin, (req, res) => {
  const folderId = Number(req.params.id || 0);
  const direction = String(req.body.direction || "").trim().toLowerCase();
  if (!folderId || !["up", "down"].includes(direction)) {
    return res.redirect("/informations?error=Unable+to+rearrange+category");
  }

  const currentFolder = getFolderById(folderId);
  if (!currentFolder) {
    return res.redirect("/informations?error=Category+not+found");
  }

  const comparator = direction === "up" ? "<" : ">";
  const sortDirection = direction === "up" ? "DESC" : "ASC";
  const neighbor = db.prepare(
    `SELECT id, sort_order
     FROM info_folders
     WHERE sort_order ${comparator} ?
     ORDER BY sort_order ${sortDirection}, LOWER(name) ${sortDirection}
     LIMIT 1`
  ).get(Number(currentFolder.sort_order || 0));

  if (!neighbor) {
    return res.redirect("/informations?success=Category+order+already+at+the+edge");
  }

  const updateSortOrder = db.prepare("UPDATE info_folders SET sort_order = ? WHERE id = ?");
  const tx = db.transaction(() => {
    updateSortOrder.run(Number(neighbor.sort_order), folderId);
    updateSortOrder.run(Number(currentFolder.sort_order), Number(neighbor.id));
  });

  tx();
  return res.redirect("/informations?success=Category+order+updated");
});

router.post("/informations/update-title/:id", (req, res) => {
  const infoId = Number(req.params.id || 0);
  const title = String(req.body.title || "").trim();
  const sessionUser = req.session.user || {};
  const isAdmin = sessionUser.role === "admin";

  if (!infoId || !title) {
    return res.redirect("/informations?error=Information+title+required");
  }

  const row = db.prepare("SELECT id, uploaded_by FROM information_files WHERE id = ?").get(infoId);
  if (!row) {
    return res.redirect("/informations?error=Information+file+not+found");
  }

  if (!isAdmin) {
    return res.redirect("/informations?error=Only+admin+can+rename+information+files");
  }

  db.prepare("UPDATE information_files SET title = ? WHERE id = ?").run(title, infoId);
  return res.redirect("/informations?success=Information+title+updated");
});

router.post("/informations/files/:id/move", requireAdmin, (req, res) => {
  const infoId = Number(req.params.id || 0);
  if (!infoId) {
    return res.redirect("/informations?error=Information+file+not+found");
  }

  const row = getInformationFileById(infoId);
  if (!row) {
    return res.redirect("/informations?error=Information+file+not+found");
  }

  try {
    const category = resolveInformationCategory(req.body.folder_id, req.body.new_category);
    db.prepare("UPDATE information_files SET folder_id = ? WHERE id = ?").run(category.folderId, infoId);
    return res.redirect(`/informations?success=${encodeURIComponent(`Information file moved to ${category.folderName}`)}`);
  } catch (err) {
    return res.redirect(`/informations?error=${encodeURIComponent(err.message || "Unable to move information file")}`);
  }
});

router.post("/informations/files/:id/delete", requireAdmin, (req, res) => {
  const infoId = Number(req.params.id || 0);
  if (!infoId) {
    return res.redirect("/informations?error=Information+file+not+found");
  }

  const row = getInformationFileById(infoId);
  if (!row) {
    return res.redirect("/informations?error=Information+file+not+found");
  }

  db.prepare("DELETE FROM information_files WHERE id = ?").run(infoId);

  const relativePath = String(row.file_path || "").trim();
  if (relativePath.startsWith("/uploads/informations/")) {
    const absolutePath = path.join(__dirname, "..", "..", "public", relativePath.replace(/^\//, ""));
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  }

  return res.redirect("/informations?success=Information+file+deleted");
});

router.use((err, _req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    return res.redirect(`/informations?error=${encodeURIComponent(`Upload failed: ${err.message}`)}`);
  }

  if (String(err.message || "").includes("Only PDF files are allowed")) {
    return res.redirect("/informations?error=Upload+failed:+only+PDF+files+are+allowed");
  }

  return next(err);
});

module.exports = router;
