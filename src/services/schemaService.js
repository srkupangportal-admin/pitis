const REQUIRED_COLUMNS = ["id", "name", "class"];

function normalizeHeader(header) {
  return String(header || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function quoteIdentifier(identifier) {
  return `"${String(identifier || "").replace(/"/g, '""')}"`;
}

function assertSafeColumnName(columnName) {
  if (!/^[a-z][a-z0-9_]*$/.test(columnName)) {
    throw new Error(`Invalid column name "${columnName}" after normalization`);
  }
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => column.name);
}

function validateHeaders(normalizedHeaders) {
  const duplicates = normalizedHeaders.filter((header, index) => normalizedHeaders.indexOf(header) !== index);
  if (duplicates.length) {
    throw new Error(`Duplicate CSV headers detected after normalization: ${Array.from(new Set(duplicates)).join(", ")}`);
  }

  const missing = REQUIRED_COLUMNS.filter((column) => !normalizedHeaders.includes(column));
  if (missing.length) {
    throw new Error(`CSV is missing required columns: ${missing.join(", ")}`);
  }
}

function ensureStudentColumns(db, csvColumns) {
  const existingColumns = new Set(getTableColumns(db, "students"));
  const addedColumns = [];

  for (const columnName of csvColumns) {
    if (existingColumns.has(columnName)) {
      continue;
    }

    assertSafeColumnName(columnName);
    db.exec(`ALTER TABLE ${quoteIdentifier("students")} ADD COLUMN ${quoteIdentifier(columnName)} TEXT`);
    existingColumns.add(columnName);
    addedColumns.push(columnName);
  }

  return {
    columns: Array.from(existingColumns),
    addedColumns
  };
}

module.exports = {
  REQUIRED_COLUMNS,
  normalizeHeader,
  quoteIdentifier,
  getTableColumns,
  validateHeaders,
  ensureStudentColumns
};
