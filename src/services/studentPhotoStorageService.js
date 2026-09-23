const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { dbPath } = require("../db/database");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const LEGACY_STUDENT_PHOTO_DIR = path.join(PROJECT_ROOT, "public", "uploads", "students");
const PRIVATE_STUDENT_PHOTO_DIR = process.env.STUDENT_PHOTO_DIR
  ? path.resolve(process.env.STUDENT_PHOTO_DIR)
  : path.join(path.dirname(dbPath), "private", "student-photos");
const PRIVATE_REFERENCE_PREFIX = "private:student-photos/";

function ensurePrivateStudentPhotoDirectory() {
  fs.mkdirSync(PRIVATE_STUDENT_PHOTO_DIR, { recursive: true });
}

function createStudentPhotoFilename(originalName = "") {
  const ext = path.extname(String(originalName)).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".jpg";
  return `${crypto.randomUUID()}${safeExt}`;
}

function toPrivatePhotoReference(filename) {
  return `${PRIVATE_REFERENCE_PREFIX}${path.basename(String(filename || ""))}`;
}

function resolveStudentPhotoPath(reference) {
  const value = String(reference || "").trim();
  if (value.startsWith(PRIVATE_REFERENCE_PREFIX)) {
    const filename = path.basename(value.slice(PRIVATE_REFERENCE_PREFIX.length));
    return filename ? path.join(PRIVATE_STUDENT_PHOTO_DIR, filename) : null;
  }
  if (value.startsWith("/uploads/students/")) {
    return path.join(LEGACY_STUDENT_PHOTO_DIR, path.basename(value));
  }
  return null;
}

function studentPhotoUrl(studentId, slot, reference) {
  return String(reference || "").trim() ? `/teacher/students/${Number(studentId)}/photos/${Number(slot)}` : "";
}

function removeStudentPhoto(reference) {
  const target = resolveStudentPhotoPath(reference);
  if (!target || !fs.existsSync(target)) return;
  try { fs.unlinkSync(target); } catch (_) {}
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(source);
  }
}

function migrateLegacyStudentPhotos(db) {
  ensurePrivateStudentPhotoDirectory();
  if (!fs.existsSync(LEGACY_STUDENT_PHOTO_DIR)) return { references: 0, orphaned: 0 };
  const columns = ["photo_path", "photo_2_path", "photo_3_path", "photo_4_path", "photo_5_path", "photo_6_path"];
  const rows = db.prepare(`SELECT id, ${columns.join(", ")} FROM students`).all();
  const movedByReference = new Map();
  const copiedFiles = [];
  const updates = [];
  rows.forEach((student) => columns.forEach((column) => {
    const reference = String(student[column] || "").trim();
    if (!reference.startsWith("/uploads/students/")) return;
    let privateReference = movedByReference.get(reference);
    if (!privateReference) {
      const source = resolveStudentPhotoPath(reference);
      if (!source || !fs.existsSync(source)) return;
      const filename = createStudentPhotoFilename(source);
      const destination = path.join(PRIVATE_STUDENT_PHOTO_DIR, filename);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      copiedFiles.push({ source, destination });
      privateReference = toPrivatePhotoReference(filename);
      movedByReference.set(reference, privateReference);
    }
    updates.push({ id: Number(student.id), column, privateReference });
  }));
  const statements = new Map(columns.map((column) => [column, db.prepare(`UPDATE students SET ${column} = ? WHERE id = ?`)]));
  try {
    db.transaction(() => updates.forEach((item) => statements.get(item.column).run(item.privateReference, item.id)))();
  } catch (error) {
    copiedFiles.forEach((file) => { try { fs.unlinkSync(file.destination); } catch (_) {} });
    throw error;
  }
  copiedFiles.forEach((file) => { try { fs.unlinkSync(file.source); } catch (_) {} });
  let orphaned = 0;
  fs.readdirSync(LEGACY_STUDENT_PHOTO_DIR, { withFileTypes: true }).forEach((entry) => {
    if (!entry.isFile()) return;
    moveFile(path.join(LEGACY_STUDENT_PHOTO_DIR, entry.name), path.join(PRIVATE_STUDENT_PHOTO_DIR, `orphan-${createStudentPhotoFilename(entry.name)}`));
    orphaned += 1;
  });
  return { references: updates.length, orphaned };
}

module.exports = {
  PRIVATE_STUDENT_PHOTO_DIR,
  createStudentPhotoFilename,
  ensurePrivateStudentPhotoDirectory,
  migrateLegacyStudentPhotos,
  removeStudentPhoto,
  resolveStudentPhotoPath,
  studentPhotoUrl,
  toPrivatePhotoReference
};
