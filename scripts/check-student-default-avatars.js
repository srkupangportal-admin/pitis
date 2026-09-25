const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pitis-student-avatars-"));
process.env.DB_PATH = path.join(testDirectory, "data.db");

const { db, initializeDatabase } = require("../src/db/init");

try {
  initializeDatabase();
  const classId = Number(db.prepare("INSERT INTO classes (name) VALUES (?)").run("AVATAR TEST").lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO students (name, full_name, student_id, gender, class_id, created_at, avatar_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const maleId = Number(insert.run("Boy", "Test Boy", "AV-M", "Male", classId, new Date().toISOString(), null).lastInsertRowid);
  const femaleId = Number(insert.run("Girl", "Test Girl", "AV-F", "Female", classId, new Date().toISOString(), null).lastInsertRowid);
  const customId = Number(insert.run("Custom", "Custom Avatar", "AV-C", "Female", classId, new Date().toISOString(), "/uploads/avatars/custom.png").lastInsertRowid);
  const unknownId = Number(insert.run("Unknown", "Unknown Gender", "AV-U", "", classId, new Date().toISOString(), null).lastInsertRowid);

  const getAvatar = db.prepare("SELECT avatar_path FROM students WHERE id = ?");
  assert.equal(getAvatar.get(maleId).avatar_path, `/images/student-avatars/male-${((maleId - 1) % 4) + 1}.png`);
  assert.equal(getAvatar.get(femaleId).avatar_path, `/images/student-avatars/female-${((femaleId - 1) % 4) + 1}.png`);
  assert.equal(getAvatar.get(customId).avatar_path, "/uploads/avatars/custom.png");
  assert.equal(getAvatar.get(unknownId).avatar_path, null);

  db.prepare("UPDATE students SET gender = ? WHERE id = ?").run("Male", femaleId);
  assert.equal(getAvatar.get(femaleId).avatar_path, `/images/student-avatars/male-${((femaleId - 1) % 4) + 1}.png`);

  db.prepare("UPDATE students SET gender = ? WHERE id = ?").run("Female", customId);
  assert.equal(getAvatar.get(customId).avatar_path, "/uploads/avatars/custom.png");

  console.log("Student default avatar assignment check passed.");
} finally {
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
