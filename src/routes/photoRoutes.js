const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { requireAnyAuth } = require("../middleware/auth");
const { recordPhotoActivity } = require("../services/photoActivityLogService");
const { extractPhotoMetadataFromFile } = require("../services/photoMetadataService");

const router = express.Router();

const PHOTO_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "photos");
if (!fs.existsSync(PHOTO_UPLOAD_DIR)) {
  fs.mkdirSync(PHOTO_UPLOAD_DIR, { recursive: true });
}

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PHOTO_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const base = path.basename(file.originalname || "photo", ext).replace(/[^a-zA-Z0-9_-]/g, "_") || "photo";
    cb(null, `${base}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 20 * 1024 * 1024, files: 15 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image files are allowed"));
  }
});

function normalizeFolderName(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function formatDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "-";
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm:ss") : raw;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function removeManagedPhotoIfExists(photoPath) {
  const relativePath = String(photoPath || "").trim();
  if (!relativePath.startsWith("/uploads/photos/")) return;
  const absolutePath = path.join(__dirname, "..", "..", "public", relativePath.replace(/^\//, ""));
  if (fs.existsSync(absolutePath)) {
    try { fs.unlinkSync(absolutePath); } catch (_) {}
  }
}

function getFolderRows() {
  return db.prepare(
    `SELECT pf.id, pf.name, pf.parent_id, pf.created_by, pf.created_at,
            COALESCE(u.display_name, u.username, 'User') AS created_by_name,
            COUNT(ph.id) AS direct_file_count
     FROM photo_folders pf
     LEFT JOIN users u ON u.id = pf.created_by
     LEFT JOIN photo_files ph ON ph.folder_id = pf.id
     GROUP BY pf.id, pf.name, pf.parent_id, pf.created_by, pf.created_at, u.display_name, u.username
     ORDER BY LOWER(pf.name) ASC, pf.id ASC`
  ).all();
}

function buildFolderTree(folderRows, selectedFolderId = null) {
  const nodeById = new Map();
  const roots = [];

  folderRows.forEach((row) => {
    nodeById.set(Number(row.id), {
      id: Number(row.id),
      name: String(row.name || "").trim() || "Untitled Folder",
      parent_id: row.parent_id == null ? null : Number(row.parent_id),
      created_at: row.created_at,
      created_by_name: row.created_by_name || "User",
      direct_file_count: Number(row.direct_file_count || 0),
      total_file_count: Number(row.direct_file_count || 0),
      subfolder_count: 0,
      children: [],
      is_selected: false,
      is_open: false
    });
  });

  nodeById.forEach((node) => {
    if (node.parent_id && nodeById.has(node.parent_id)) {
      nodeById.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  });

  function walk(node) {
    node.children.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    node.subfolder_count = node.children.length;
    node.total_file_count = node.direct_file_count;
    node.children.forEach((child) => {
      walk(child);
      node.total_file_count += child.total_file_count;
    });
  }

  roots.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  roots.forEach(walk);

  const selectedId = Number(selectedFolderId) || null;
  if (selectedId && nodeById.has(selectedId)) {
    let cursor = nodeById.get(selectedId);
    while (cursor) {
      cursor.is_open = true;
      cursor.is_selected = cursor.id === selectedId;
      cursor = cursor.parent_id && nodeById.has(cursor.parent_id) ? nodeById.get(cursor.parent_id) : null;
    }
  }

  return { roots, nodeById };
}

function getFolderPath(folderId, nodeById) {
  const parts = [];
  let cursor = nodeById.get(Number(folderId) || 0) || null;
  while (cursor) {
    parts.unshift({ id: cursor.id, name: cursor.name });
    cursor = cursor.parent_id && nodeById.has(cursor.parent_id) ? nodeById.get(cursor.parent_id) : null;
  }
  return parts;
}

function getSortClause(sort) {
  if (sort === "oldest") return "ph.uploaded_at ASC, ph.id ASC";
  if (sort === "alpha") return "LOWER(ph.original_name) ASC, ph.uploaded_at DESC";
  return "ph.uploaded_at DESC, ph.id DESC";
}

function normalizeViewMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["list", "thumbnails", "icons"].includes(mode) ? mode : "thumbnails";
}

function normalizeSortMode(value) {
  const sort = String(value || "").trim().toLowerCase();
  return ["latest", "oldest", "alpha"].includes(sort) ? sort : "latest";
}

function listPhotoFiles(folderId, sort = "latest") {
  const whereSql = folderId ? "WHERE ph.folder_id = ?" : "";
  const rows = db.prepare(
    `SELECT ph.id, ph.folder_id, ph.original_name, ph.stored_name, ph.file_path, ph.mime_type, ph.file_size_bytes, ph.captured_at, ph.captured_at_source, ph.uploaded_by, ph.uploaded_at,
            COALESCE(u.display_name, u.username, 'User') AS uploaded_by_name,
            pf.name AS folder_name
     FROM photo_files ph
     LEFT JOIN users u ON u.id = ph.uploaded_by
     LEFT JOIN photo_folders pf ON pf.id = ph.folder_id
     ${whereSql}
     ORDER BY ${getSortClause(sort)}`
  ).all(...(folderId ? [Number(folderId)] : []));

  return rows.map((row) => ({
    ...row,
    captured_at_display: formatDateTime(row.captured_at),
    uploaded_at_display: formatDateTime(row.uploaded_at),
    file_size_display: formatBytes(row.file_size_bytes)
  }));
}

function getPhotoFileById(fileId) {
  const row = db.prepare(
    `SELECT ph.id, ph.folder_id, ph.original_name, ph.stored_name, ph.file_path, ph.mime_type, ph.file_size_bytes, ph.captured_at, ph.captured_at_source, ph.uploaded_by, ph.uploaded_at,
            COALESCE(u.display_name, u.username, 'User') AS uploaded_by_name,
            pf.name AS folder_name
     FROM photo_files ph
     LEFT JOIN users u ON u.id = ph.uploaded_by
     LEFT JOIN photo_folders pf ON pf.id = ph.folder_id
     WHERE ph.id = ?`
  ).get(Number(fileId) || 0);

  if (!row) return null;
  return {
    ...row,
    captured_at_display: formatDateTime(row.captured_at),
    uploaded_at_display: formatDateTime(row.uploaded_at),
    file_size_display: formatBytes(row.file_size_bytes)
  };
}

function createPhotoFolder(name, parentId, createdBy) {
  const normalized = normalizeFolderName(name);
  const safeParentId = Number(parentId) || null;
  if (!normalized) {
    throw new Error("Folder name is required");
  }

  if (safeParentId) {
    const parentExists = db.prepare("SELECT id FROM photo_folders WHERE id = ?").get(safeParentId);
    if (!parentExists) {
      throw new Error("Selected parent folder was not found");
    }
  }

  const duplicate = db.prepare(
    `SELECT id
     FROM photo_folders
     WHERE LOWER(name) = LOWER(?)
       AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
     LIMIT 1`
  ).get(normalized, safeParentId, safeParentId);

  if (duplicate) {
    throw new Error("A folder with that name already exists in the selected location");
  }

  return Number(
    db.prepare(
      `INSERT INTO photo_folders (name, parent_id, created_by, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(normalized, safeParentId, Number(createdBy) || null, dayjs().toISOString()).lastInsertRowid
  );
}

function resolveUploadFolder(req) {
  const existingFolderId = Number(req.body.folder_id) || null;
  const newFolderName = normalizeFolderName(req.body.new_folder_name);
  const newFolderParentId = Number(req.body.new_folder_parent_id) || null;
  const currentUserId = Number((req.session.user || {}).id) || null;

  if (newFolderName) {
    const createdFolderId = createPhotoFolder(newFolderName, newFolderParentId, currentUserId);
    recordPhotoActivity(req, req.session.user, {
      activityType: "folder_created",
      targetType: "folder",
      targetLabel: newFolderName,
      folderId: createdFolderId,
      details: newFolderParentId ? `Subfolder created under folder #${newFolderParentId}` : "Top-level folder created"
    });
    return createdFolderId;
  }

  if (!existingFolderId) {
    throw new Error("Please select an existing folder or create a new folder");
  }

  const folder = db.prepare("SELECT id FROM photo_folders WHERE id = ?").get(existingFolderId);
  if (!folder) {
    throw new Error("Selected folder was not found");
  }

  return Number(folder.id);
}

function resolveFolderSelection(existingFolderRaw, newFolderNameRaw, newFolderParentRaw, createdBy) {
  const existingFolderId = Number(existingFolderRaw) || null;
  const newFolderName = normalizeFolderName(newFolderNameRaw);
  const newFolderParentId = Number(newFolderParentRaw) || null;

  if (newFolderName) {
    const folderId = createPhotoFolder(newFolderName, newFolderParentId, createdBy);
    return {
      folderId,
      createdFolderName: newFolderName,
      createdFolderParentId: newFolderParentId
    };
  }

  if (!existingFolderId) {
    throw new Error("Please select an existing folder or enter a new folder name");
  }

  const folder = db.prepare("SELECT id, name FROM photo_folders WHERE id = ?").get(existingFolderId);
  if (!folder) {
    throw new Error("Selected folder was not found");
  }

  return {
    folderId: Number(folder.id),
    existingFolderName: String(folder.name || "").trim()
  };
}

function parseSelectedPhotoIds(raw) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return Array.from(new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)));
}

router.use("/photos-upload", requireAnyAuth);

router.get("/photos-upload", (req, res) => {
  const viewMode = normalizeViewMode(req.query.view);
  const sort = normalizeSortMode(req.query.sort);
  const requestedFolderId = Number(req.query.folder_id) || null;
  const folderRows = getFolderRows();
  const { roots, nodeById } = buildFolderTree(folderRows, requestedFolderId);
  const selectedFolder = requestedFolderId && nodeById.has(requestedFolderId) ? nodeById.get(requestedFolderId) : null;
  const files = listPhotoFiles(selectedFolder ? selectedFolder.id : null, sort);
  const recentFiles = selectedFolder ? files.slice(0, 12) : files.slice(0, 18);
  const folderPath = selectedFolder ? getFolderPath(selectedFolder.id, nodeById) : [];
  const folderOptions = folderRows.map((row) => ({
    id: Number(row.id),
    label: getFolderPath(Number(row.id), nodeById).map((part) => part.name).join(" / ")
  }));

  res.render("photos-upload", {
    user: req.session.user,
    error: req.query.error || null,
    success: req.query.success || null,
    folderTree: roots,
    folderOptions,
    selectedFolder,
    folderPath,
    files,
    recentFiles,
    viewMode,
    sort
  });
});

router.post("/photos-upload/folders/create", (req, res) => {
  try {
    const folderName = normalizeFolderName(req.body.folder_name);
    const parentFolderId = Number(req.body.parent_folder_id) || null;
    const folderId = createPhotoFolder(folderName, parentFolderId, Number((req.session.user || {}).id) || null);
    recordPhotoActivity(req, req.session.user, {
      activityType: "folder_created",
      targetType: "folder",
      targetLabel: folderName,
      folderId,
      details: parentFolderId ? `Subfolder created under folder #${parentFolderId}` : "Top-level folder created"
    });
    return res.redirect(`/photos-upload?success=${encodeURIComponent("Folder created")}&folder_id=${encodeURIComponent(folderId)}`);
  } catch (error) {
    return res.redirect(`/photos-upload?error=${encodeURIComponent(error.message || "Unable to create folder")}`);
  }
});

router.post("/photos-upload/bulk-manage", (req, res) => {
  const selectedPhotoIds = parseSelectedPhotoIds(req.body.selected_files);
  const bulkAction = String(req.body.bulk_action || "").trim().toLowerCase();
  const currentUser = req.session.user || {};
  const actorUserId = Number(currentUser.id) || null;

  try {
    if (!selectedPhotoIds.length) {
      throw new Error("Please select at least one photo");
    }

    const placeholders = selectedPhotoIds.map(() => "?").join(", ");
    const files = db.prepare(
      `SELECT id, folder_id, original_name, file_path
       FROM photo_files
       WHERE id IN (${placeholders})`
    ).all(...selectedPhotoIds);

    if (!files.length) {
      throw new Error("Selected photo files were not found");
    }

    const selectedFolderId = Number(req.body.current_folder_id) || null;

    if (bulkAction === "move") {
      const folderSelection = resolveFolderSelection(req.body.folder_id, req.body.new_folder_name, req.body.new_folder_parent_id, actorUserId);
      const targetFolderId = Number(folderSelection.folderId);
      const targetFolder = db.prepare("SELECT id, name FROM photo_folders WHERE id = ?").get(targetFolderId);
      const updateFolder = db.prepare("UPDATE photo_files SET folder_id = ? WHERE id = ?");
      files.forEach((file) => {
        updateFolder.run(targetFolderId, Number(file.id));
        recordPhotoActivity(req, currentUser, {
          activityType: "photo_moved",
          targetType: "file",
          targetLabel: file.original_name,
          folderId: targetFolderId,
          fileId: Number(file.id),
          details: `Moved to ${targetFolder ? targetFolder.name : "target folder"}`
        });
      });

      if (folderSelection.createdFolderName) {
        recordPhotoActivity(req, currentUser, {
          activityType: "folder_created",
          targetType: "folder",
          targetLabel: folderSelection.createdFolderName,
          folderId: targetFolderId,
          details: folderSelection.createdFolderParentId ? `Created during bulk move under folder #${folderSelection.createdFolderParentId}` : "Created during bulk move"
        });
      }

      return res.redirect(`/photos-upload?success=${encodeURIComponent(`${files.length} photo(s) moved`) }&folder_id=${encodeURIComponent(targetFolderId)}`);
    }

    if (bulkAction === "delete") {
      const deleteFile = db.prepare("DELETE FROM photo_files WHERE id = ?");
      files.forEach((file) => {
        recordPhotoActivity(req, currentUser, {
          activityType: "photo_deleted",
          targetType: "file",
          targetLabel: file.original_name,
          folderId: Number(file.folder_id) || null,
          fileId: Number(file.id),
          details: "Deleted photo"
        });
        deleteFile.run(Number(file.id));
        removeManagedPhotoIfExists(file.file_path);
      });

      return res.redirect(`/photos-upload?success=${encodeURIComponent(`${files.length} photo(s) deleted`) }${selectedFolderId ? `&folder_id=${encodeURIComponent(selectedFolderId)}` : ""}`);
    }

    throw new Error("Please choose a valid photo action");
  } catch (error) {
    const selectedFolderId = Number(req.body.current_folder_id) || null;
    return res.redirect(`/photos-upload?error=${encodeURIComponent(error.message || "Unable to manage selected photos")}${selectedFolderId ? `&folder_id=${encodeURIComponent(selectedFolderId)}` : ""}`);
  }
});

router.post("/photos-upload/upload", photoUpload.array("photo_files", 15), (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.redirect("/photos-upload?error=Please+select+at+least+one+photo");
    }

    const targetFolderId = resolveUploadFolder(req);
    const folder = db.prepare("SELECT id, name FROM photo_folders WHERE id = ?").get(targetFolderId);
    const insertFile = db.prepare(
      `INSERT INTO photo_files
        (folder_id, original_name, stored_name, file_path, mime_type, file_size_bytes, captured_at, captured_at_source, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const uploadedAt = dayjs().toISOString();
    const uploaderId = Number((req.session.user || {}).id) || null;

    files.forEach((file) => {
      const metadata = extractPhotoMetadataFromFile(file.path, file.mimetype || "");
      const fileId = Number(insertFile.run(
        targetFolderId,
        file.originalname || file.filename,
        file.filename,
        `/uploads/photos/${file.filename}`,
        file.mimetype || "",
        Number(file.size) || 0,
        metadata.capturedAt,
        metadata.capturedAtSource,
        uploaderId,
        uploadedAt
      ).lastInsertRowid);

      recordPhotoActivity(req, req.session.user, {
        activityType: "photo_uploaded",
        targetType: "file",
        targetLabel: file.originalname || file.filename,
        folderId: targetFolderId,
        fileId,
        details: `Uploaded into ${folder ? folder.name : "selected folder"}${metadata.capturedAt ? ` | Taken at ${metadata.capturedAt}` : ""}`
      });
    });

    return res.redirect(`/photos-upload?success=${encodeURIComponent(`${files.length} photo(s) uploaded`) }&folder_id=${encodeURIComponent(targetFolderId)}`);
  } catch (error) {
    return res.redirect(`/photos-upload?error=${encodeURIComponent(error.message || "Upload failed")}`);
  }
});

router.get("/photos-upload/files/:id", (req, res) => {
  const file = getPhotoFileById(req.params.id);
  if (!file) {
    return res.status(404).send("Photo not found");
  }

  const viewMode = normalizeViewMode(req.query.view);
  const sort = normalizeSortMode(req.query.sort);
  const requestedFolderId = Number(req.query.folder_id) || Number(file.folder_id) || null;

  const folderRows = getFolderRows();
  const { nodeById } = buildFolderTree(folderRows, requestedFolderId);
  const folderPath = getFolderPath(Number(file.folder_id) || 0, nodeById);
  const contextFiles = listPhotoFiles(requestedFolderId, sort);
  const currentIndex = contextFiles.findIndex((item) => Number(item.id) === Number(file.id));
  const previousFile = currentIndex > 0 ? contextFiles[currentIndex - 1] : null;
  const nextFile = currentIndex >= 0 && currentIndex < contextFiles.length - 1 ? contextFiles[currentIndex + 1] : null;

  recordPhotoActivity(req, req.session.user, {
    activityType: "photo_viewed",
    targetType: "file",
    targetLabel: file.original_name,
    folderId: Number(file.folder_id) || null,
    fileId: Number(file.id),
    details: "Opened photo details"
  });

  return res.render("photos-upload-file", {
    user: req.session.user,
    file,
    folderPath,
    previousFile,
    nextFile,
    viewMode,
    sort,
    selectedFolderId: requestedFolderId,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/photos-upload/files/:id/download", (req, res) => {
  const file = getPhotoFileById(req.params.id);
  if (!file) {
    return res.status(404).send("Photo not found");
  }

  const relativePath = String(file.file_path || "").trim();
  const absolutePath = path.join(__dirname, "..", "..", "public", relativePath.replace(/^\//, ""));
  if (!relativePath.startsWith("/uploads/photos/") || !fs.existsSync(absolutePath)) {
    return res.status(404).send("Stored photo file not found");
  }

  recordPhotoActivity(req, req.session.user, {
    activityType: "photo_downloaded",
    targetType: "file",
    targetLabel: file.original_name,
    folderId: Number(file.folder_id) || null,
    fileId: Number(file.id),
    details: "Downloaded photo"
  });

  return res.download(absolutePath, file.original_name);
});

router.post("/photos-upload/files/:id/rename", (req, res) => {
  const fileId = Number(req.params.id) || 0;
  const newName = normalizeFolderName(req.body.original_name);

  try {
    if (!fileId || !newName) {
      throw new Error("Photo filename is required");
    }

    const file = getPhotoFileById(fileId);
    if (!file) {
      throw new Error("Photo not found");
    }

    db.prepare("UPDATE photo_files SET original_name = ? WHERE id = ?").run(newName, fileId);
    recordPhotoActivity(req, req.session.user, {
      activityType: "photo_renamed",
      targetType: "file",
      targetLabel: newName,
      folderId: Number(file.folder_id) || null,
      fileId,
      details: `Renamed from ${file.original_name} to ${newName}`
    });

    const query = new URLSearchParams();
    if (req.body.folder_id) query.set("folder_id", String(req.body.folder_id));
    if (req.body.view) query.set("view", String(req.body.view));
    if (req.body.sort) query.set("sort", String(req.body.sort));
    query.set("success", "Photo filename updated");
    return res.redirect(`/photos-upload/files/${encodeURIComponent(fileId)}?${query.toString()}`);
  } catch (error) {
    const query = new URLSearchParams();
    if (req.body.folder_id) query.set("folder_id", String(req.body.folder_id));
    if (req.body.view) query.set("view", String(req.body.view));
    if (req.body.sort) query.set("sort", String(req.body.sort));
    query.set("error", error.message || "Unable to rename photo");
    return res.redirect(`/photos-upload/files/${encodeURIComponent(fileId || 0)}?${query.toString()}`);
  }
});

router.post("/photos-upload/files/:id/delete", (req, res) => {
  const fileId = Number(req.params.id) || 0;

  try {
    const file = getPhotoFileById(fileId);
    if (!file) {
      throw new Error("Photo not found");
    }

    recordPhotoActivity(req, req.session.user, {
      activityType: "photo_deleted",
      targetType: "file",
      targetLabel: file.original_name,
      folderId: Number(file.folder_id) || null,
      fileId,
      details: "Deleted photo from detail view"
    });

    db.prepare("DELETE FROM photo_files WHERE id = ?").run(fileId);
    removeManagedPhotoIfExists(file.file_path);

    const query = new URLSearchParams();
    query.set("success", "Photo deleted");
    if (req.body.folder_id) query.set("folder_id", String(req.body.folder_id));
    if (req.body.view) query.set("view", String(req.body.view));
    if (req.body.sort) query.set("sort", String(req.body.sort));
    return res.redirect(`/photos-upload?${query.toString()}`);
  } catch (error) {
    const query = new URLSearchParams();
    if (req.body.folder_id) query.set("folder_id", String(req.body.folder_id));
    if (req.body.view) query.set("view", String(req.body.view));
    if (req.body.sort) query.set("sort", String(req.body.sort));
    query.set("error", error.message || "Unable to delete photo");
    return res.redirect(`/photos-upload/files/${encodeURIComponent(fileId || 0)}?${query.toString()}`);
  }
});

router.use((err, _req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    return res.redirect(`/photos-upload?error=${encodeURIComponent(`Upload failed: ${err.message}`)}`);
  }

  if (String(err.message || "").includes("Only image files are allowed")) {
    return res.redirect("/photos-upload?error=Upload+failed:+only+image+files+are+allowed");
  }

  return next(err);
});

module.exports = router;
