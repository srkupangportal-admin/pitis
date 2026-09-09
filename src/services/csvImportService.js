const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const { parse } = require("csv-parse/sync");
const { quoteIdentifier } = require("./schemaService");
const {
  STUDENT_DB_COLUMNS,
  createStudentQrToken,
  mapStudentCsvValues,
  normalizeClassName,
  normalizeStudentRecord,
  validateStudentTemplateHeaders
} = require("./studentSchema");

const BACKUP_DIRECTORY = path.join(__dirname, "..", "..", "backup");
const STUDENT_RELATED_TABLES = [
  "attendance_records",
  "attendance_sessions",
  "daily_points",
  "point_logs",
  "student_siblings",
  "students"
];

function parseCsvBuffer(buffer) {
  const content = String(buffer || "").trim();
  if (!content) {
    throw new Error("CSV file is empty");
  }

  const rows = parse(content, {
    skip_empty_lines: true,
    trim: false
  });

  if (!rows.length) {
    throw new Error("CSV file is empty");
  }

  validateStudentTemplateHeaders(rows[0].map((value) => String(value == null ? "" : value)));

  const records = rows.slice(1).map((values, rowIndex) => {
    const mapped = mapStudentCsvValues(values);
    const record = normalizeStudentRecord(mapped);

    if (!record.student_id || !record.name || !record.full_name || !mapped.class_name) {
      throw new Error(`Row ${rowIndex + 2} must include NAME, FULL NAME, STUDENT ID, and CLASS`);
    }

    return {
      ...record,
      class_name: normalizeClassName(mapped.class_name)
    };
  });

  if (!records.length) {
    throw new Error("CSV does not contain any student rows");
  }

  return records;
}

async function createDatabaseBackup(db) {
  await fs.promises.mkdir(BACKUP_DIRECTORY, { recursive: true });
  const backupBaseName = `backup-${dayjs().format("YYYY-MM-DD")}.db`;
  let backupPath = path.join(BACKUP_DIRECTORY, backupBaseName);

  if (fs.existsSync(backupPath)) {
    backupPath = path.join(BACKUP_DIRECTORY, `backup-${dayjs().format("YYYY-MM-DD-HHmmss")}.db`);
  }

  await db.backup(backupPath);
  return backupPath;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function clearStudentData(db) {
  for (const tableName of STUDENT_RELATED_TABLES) {
    if (tableExists(db, tableName)) {
      db.exec(`DELETE FROM ${quoteIdentifier(tableName)}`);
    }
  }
}

function rebuildSiblingLinks(db) {
  if (!tableExists(db, "student_siblings")) return;

  db.exec(`DELETE FROM ${quoteIdentifier("student_siblings")}`);

  const students = db
    .prepare("SELECT id, family_id FROM students WHERE family_id IS NOT NULL AND TRIM(family_id) <> '' ORDER BY family_id ASC, id ASC")
    .all();
  const grouped = new Map();

  students.forEach((student) => {
    const familyId = String(student.family_id || "").trim();
    if (!grouped.has(familyId)) {
      grouped.set(familyId, []);
    }
    grouped.get(familyId).push(Number(student.id));
  });

  const insertLink = db.prepare(
    `INSERT INTO student_siblings (student_pk, sibling_student_pk, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_pk, sibling_student_pk) DO NOTHING`
  );
  const createdAt = dayjs().toISOString();

  grouped.forEach((studentIds) => {
    studentIds.forEach((studentId) => {
      studentIds.forEach((siblingId) => {
        if (studentId !== siblingId) {
          insertLink.run(studentId, siblingId, createdAt);
        }
      });
    });
  });
}

function getOrCreateClassId(db, classCache, className) {
  const normalizedClassName = normalizeClassName(className);
  if (!normalizedClassName) {
    throw new Error("CLASS is required for every student row");
  }

  if (classCache.has(normalizedClassName)) {
    return classCache.get(normalizedClassName);
  }

  db.prepare("INSERT OR IGNORE INTO classes (name) VALUES (?)").run(normalizedClassName);
  const created = db.prepare("SELECT id FROM classes WHERE name = ?").get(normalizedClassName);
  if (!created) {
    throw new Error(`Unable to resolve class "${normalizedClassName}"`);
  }

  const classId = Number(created.id);
  classCache.set(normalizedClassName, classId);
  return classId;
}

function buildStudentRow(record, classId, replaceAll) {
  const now = dayjs().toISOString();
  const studentRow = {
    name: record.name,
    full_name: record.full_name,
    student_id: record.student_id,
    qr_token: createStudentQrToken(),
    no_sb: record.no_sb,
    no_bruhims: record.no_bruhims,
    bangsa: record.bangsa,
    ugama: record.ugama,
    kerakyatan: record.kerakyatan,
    gender: record.gender,
    dob: record.dob,
    age: null,
    level: record.level,
    notes: record.notes,
    emergency_contact: record.emergency_contact || "-",
    email: record.email,
    alamat: record.alamat,
    nama_ayah: record.nama_ayah,
    pekerjaan_ayah: record.pekerjaan_ayah,
    dob_ayah: record.dob_ayah,
    taraf_ayah: record.taraf_ayah,
    no_telefon_ayah: record.no_telefon_ayah,
    bangsa_ayah: record.bangsa_ayah,
    ugama_ayah: record.ugama_ayah,
    kerakyatan_ayah: record.kerakyatan_ayah,
    nama_ibu: record.nama_ibu,
    pekerjaan_ibu: record.pekerjaan_ibu,
    dob_ibu: record.dob_ibu,
    taraf_ibu: record.taraf_ibu,
    no_telefon_ibu: record.no_telefon_ibu,
    bangsa_ibu: record.bangsa_ibu,
    ugama_ibu: record.ugama_ibu,
    kerakyatan_ibu: record.kerakyatan_ibu,
    family_id: record.family_id,
    class_id: classId,
    created_at: now
  };

  if (replaceAll && /^\d+$/.test(String(record.student_id || "").trim())) {
    studentRow.id = Number(record.student_id);
  }

  return studentRow;
}

function buildInsertStatement(db, tableColumns) {
  const placeholders = tableColumns.map((column) => `@${column}`).join(", ");
  return db.prepare(
    `INSERT INTO students (${tableColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`
  );
}

function buildUpdateStatement(db, tableColumns) {
  const updateColumns = tableColumns.filter((column) => !["id", "created_at", "qr_token"].includes(column));
  return db.prepare(
    `UPDATE students SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = @${column}`).join(", ")} WHERE student_id = @student_id`
  );
}

async function importStudentsFromCsv({ db, fileBuffer, replaceAll = false }) {
  const rows = parseCsvBuffer(fileBuffer);
  const classRows = db.prepare("SELECT id, name FROM classes").all();
  const classCache = new Map(classRows.map((row) => [String(row.name), Number(row.id)]));
  const insertColumns = replaceAll ? STUDENT_DB_COLUMNS : STUDENT_DB_COLUMNS.filter((column) => column !== "id");
  const insertStudent = buildInsertStatement(db, insertColumns);
  const updateStudent = buildUpdateStatement(db, STUDENT_DB_COLUMNS);
  const findExistingStudent = db.prepare("SELECT id FROM students WHERE student_id = ?");

  let backupPath = null;
  if (replaceAll) {
    backupPath = await createDatabaseBackup(db);
  }

  db.exec("BEGIN TRANSACTION");
  let foreignKeysDisabled = false;

  try {
    if (replaceAll) {
      db.pragma("foreign_keys = OFF");
      foreignKeysDisabled = true;
      clearStudentData(db);
    }

    let importedCount = 0;
    let updatedCount = 0;

    for (const record of rows) {
      const classId = getOrCreateClassId(db, classCache, record.class_name);
      const studentRow = buildStudentRow(record, classId, replaceAll);
      const insertPayload = {};

      insertColumns.forEach((column) => {
        insertPayload[column] = Object.prototype.hasOwnProperty.call(studentRow, column) ? studentRow[column] : null;
      });

      if (replaceAll) {
        insertStudent.run(insertPayload);
        importedCount += 1;
        continue;
      }

      if (findExistingStudent.get(studentRow.student_id)) {
        const updatePayload = {};
        STUDENT_DB_COLUMNS.forEach((column) => {
          updatePayload[column] = Object.prototype.hasOwnProperty.call(studentRow, column) ? studentRow[column] : null;
        });
        updateStudent.run(updatePayload);
        updatedCount += 1;
      } else {
        insertStudent.run(insertPayload);
        importedCount += 1;
      }
    }

    rebuildSiblingLinks(db);
    db.exec("COMMIT");

    return {
      importedCount,
      updatedCount,
      backupPath,
      replaceAll
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (_rollbackError) {}
    throw error;
  } finally {
    if (foreignKeysDisabled) {
      db.pragma("foreign_keys = ON");
    }
  }
}

module.exports = {
  createDatabaseBackup,
  importStudentsFromCsv,
  parseCsvBuffer
};
