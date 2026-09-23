const crypto = require("crypto");
const dayjs = require("dayjs");

const STUDENT_TEMPLATE_COLUMNS = [
  { header: "NAME", key: "name", label: "Name", required: true, type: "text", group: "basic" },
  { header: "FULL NAME", key: "full_name", label: "Full Name", required: true, type: "text", group: "basic" },
  { header: "STUDENT ID", key: "student_id", label: "Student ID", required: true, type: "text", group: "basic" },
  { header: "NO S.B.", key: "no_sb", label: "No. S.B.", required: false, type: "text", group: "basic" },
  { header: "NO. BRUHIMS", key: "no_bruhims", label: "No. BruHIMS", required: false, type: "text", group: "basic" },
  { header: "BANGSA", key: "bangsa", label: "Bangsa", required: false, type: "text", group: "school" },
  { header: "UGAMA", key: "ugama", label: "Ugama", required: false, type: "text", group: "school" },
  { header: "KERAKYATAN", key: "kerakyatan", label: "Kerakyatan", required: false, type: "text", group: "school" },
  { header: "GENDER", key: "gender", label: "Gender", required: false, type: "select", options: ["", "Male", "Female"], group: "basic" },
  { header: "DOB (DD/MM/YYYY)", key: "dob", label: "DOB", required: false, type: "date", group: "basic" },
  { header: "CLASS", key: "class_name", label: "Class", required: true, type: "class", group: "basic" },
  { header: "LEVEL", key: "level", label: "Level", required: false, type: "text", group: "basic" },
  { header: "NOTES", key: "notes", label: "Notes", required: false, type: "text", group: "school" },
  { header: "EMERGENCY CONTACT", key: "emergency_contact", label: "Emergency Contact", required: false, type: "text", group: "basic" },
  { header: "EMAIL", key: "email", label: "Email", required: false, type: "email", group: "basic" },
  { header: "ALAMAT", key: "alamat", label: "Alamat", required: false, type: "text", group: "school" },
  { header: "NAMA AYAH", key: "nama_ayah", label: "Nama Ayah", required: false, type: "text", group: "father" },
  { header: "PEKERJAAN AYAH", key: "pekerjaan_ayah", label: "Pekerjaan Ayah", required: false, type: "text", group: "father" },
  { header: "DOB AYAH (DD/MM/YYYY)", key: "dob_ayah", label: "DOB Ayah", required: false, type: "date", group: "father" },
  { header: "TARAF IBU", key: "taraf_ayah", label: "Taraf Ayah", required: false, type: "text", group: "father" },
  { header: "NO TELEFON IBU", key: "no_telefon_ayah", label: "No. Telefon Ayah", required: false, type: "text", group: "father" },
  { header: "BANGSA IBU", key: "bangsa_ayah", label: "Bangsa Ayah", required: false, type: "text", group: "father" },
  { header: "UGAMA IBU", key: "ugama_ayah", label: "Ugama Ayah", required: false, type: "text", group: "father" },
  { header: "KERAKYATAN IBU", key: null, label: "Warna K.P Ayah", required: false, type: "ignored", group: "father" },
  { header: "", key: "nama_ibu", label: "Nama Ibu", required: false, type: "text", group: "mother" },
  { header: "NAMA IBU", key: "pekerjaan_ibu", label: "Pekerjaan Ibu", required: false, type: "text", group: "mother" },
  { header: "PEKERJAAN IBU", key: "dob_ibu", label: "DOB Ibu", required: false, type: "date", group: "mother" },
  { header: "DOB IBU (DD/MM/YYYY)", key: "taraf_ibu", label: "Taraf Ibu", required: false, type: "text", group: "mother" },
  { header: "TARAF IBU", key: "no_telefon_ibu", label: "No. Telefon Ibu", required: false, type: "text", group: "mother" },
  { header: "NO TELEFON IBU", key: "bangsa_ibu", label: "Bangsa Ibu", required: false, type: "text", group: "mother" },
  { header: "BANGSA IBU", key: "ugama_ibu", label: "Ugama Ibu", required: false, type: "text", group: "mother" },
  { header: "UGAMA IBU", key: null, label: "Warna K.P Ibu", required: false, type: "ignored", group: "mother" },
  { header: "KERAKYATAN IBU", key: null, label: "Kerakyatan Ibu", required: false, type: "ignored", group: "mother" },
  { header: "FAMILY ID", key: "family_id", label: "Family ID", required: false, type: "text", group: "basic" },
  { header: "YURAN SEKOLAH", key: "yiuran_sekolah_paid", label: "Yuran Sekolah", required: false, type: "checkbox-status", group: "school" },
  { header: "YURAN PIBG", key: "yuran_pibg_paid", label: "Yuran PIBG", required: false, type: "checkbox-status", group: "school" },
  { header: "INSURAN", key: "insuran_paid", label: "Insuran", required: false, type: "checkbox-status", group: "school" }
];

const STUDENT_DB_COLUMNS = [
  "id",
  "name",
  "full_name",
  "student_id",
  "qr_token",
  "no_sb",
  "no_bruhims",
  "bangsa",
  "ugama",
  "kerakyatan",
  "gender",
  "dob",
  "age",
  "level",
  "notes",
  "emergency_contact",
  "email",
  "alamat",
  "nama_ayah",
  "pekerjaan_ayah",
  "dob_ayah",
  "taraf_ayah",
  "no_telefon_ayah",
  "bangsa_ayah",
  "ugama_ayah",
  "kerakyatan_ayah",
  "nama_ibu",
  "pekerjaan_ibu",
  "dob_ibu",
  "taraf_ibu",
  "no_telefon_ibu",
  "bangsa_ibu",
  "ugama_ibu",
  "kerakyatan_ibu",
  "family_id",
  "yiuran_sekolah_paid",
  "yuran_pibg_paid",
  "insuran_paid",
  "avatar_path",
  "photo_path",
  "photo_uploaded_at",
  "photo_uploaded_by",
  "photo_2_path",
  "photo_2_uploaded_at",
  "photo_2_uploaded_by",
  "photo_3_path",
  "photo_3_uploaded_at",
  "photo_3_uploaded_by",
  "photo_4_path",
  "photo_4_uploaded_at",
  "photo_4_uploaded_by",
  "photo_5_path",
  "photo_5_uploaded_at",
  "photo_5_uploaded_by",
  "photo_6_path",
  "photo_6_uploaded_at",
  "photo_6_uploaded_by",
  "class_id",
  "created_at"
];

function createStudentQrToken() {
  return crypto.randomBytes(18).toString("base64url");
}

const STUDENT_CORE_FIELD_KEYS = STUDENT_TEMPLATE_COLUMNS
  .map((column) => column.key)
  .filter(Boolean)
  .filter((key) => key !== "class_name");

const STUDENT_FORM_GROUPS = [
  {
    key: "basic",
    title: "Basic Details",
    fields: STUDENT_TEMPLATE_COLUMNS.filter((column) => column.group === "basic" && column.key !== "class_name")
  },
  {
    key: "school",
    title: "School Details",
    fields: STUDENT_TEMPLATE_COLUMNS.filter((column) => column.group === "school")
  },
  {
    key: "father",
    title: "Father Details",
    fields: STUDENT_TEMPLATE_COLUMNS.filter((column) => column.group === "father")
  },
  {
    key: "mother",
    title: "Mother Details",
    fields: STUDENT_TEMPLATE_COLUMNS.filter((column) => column.group === "mother")
  }
];

function csvEscape(value) {
  return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
}

function buildStudentTemplateCsv() {
  return STUDENT_TEMPLATE_COLUMNS.map((column) => csvEscape(column.header)).join(",");
}

function normalizeHeaderValue(value) {
  return String(value == null ? "" : value)
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function validateStudentTemplateHeaders(headers) {
  const expected = STUDENT_TEMPLATE_COLUMNS.map((column) => normalizeHeaderValue(column.header));
  const actual = headers.map((header) => normalizeHeaderValue(header));

  if (actual.length !== expected.length) {
    throw new Error(`CSV header count mismatch. Expected ${expected.length} columns, received ${actual.length}`);
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`CSV header mismatch at column ${index + 1}. Expected "${STUDENT_TEMPLATE_COLUMNS[index].header}"`);
    }
  }
}

function normalizeOptionalText(value) {
  const trimmed = String(value == null ? "" : value).trim();
  return trimmed ? trimmed : null;
}

function normalizeClassName(value) {
  const trimmed = String(value == null ? "" : value).trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[_\s]+/g, " ").trim().toUpperCase();
  if (normalized === "PRA") return "PRA";
  const yearMatch = normalized.match(/^(?:YEAR|TAHUN)\s*([1-6])$/);
  if (yearMatch) {
    return `YEAR ${yearMatch[1]}`;
  }
  return normalized;
}

function normalizeGender(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (!raw) return null;
  if (["m", "male", "lelaki"].includes(raw)) return "Male";
  if (["f", "female", "perempuan"].includes(raw)) return "Female";
  return String(value).trim();
}

function normalizeDateValue(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const compactYear = raw.match(/^(\d{4})$/);
  if (compactYear) {
    return `${compactYear[1]}-01-01`;
  }
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, dd, mm, yyyy] = slashMatch;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const dashMatch = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const [, dd, mm, yyyy] = dashMatch;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const namedMonthMatch = raw.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (namedMonthMatch) {
    const [, dd, monthName, yearValue] = namedMonthMatch;
    const monthLookup = {
      JAN: "01",
      FEB: "02",
      MAR: "03",
      APR: "04",
      MAY: "05",
      MEI: "05",
      JUN: "06",
      JUL: "07",
      AUG: "08",
      SEP: "09",
      OCT: "10",
      OKT: "10",
      NOV: "11",
      DEC: "12",
      DIS: "12"
    };
    const month = monthLookup[monthName.slice(0, 3).toUpperCase()];
    if (month) {
      let year = yearValue;
      if (year.length === 2) {
        const currentTwoDigitYear = Number(dayjs().format("YY"));
        year = Number(year) <= currentTwoDigitYear ? `20${year}` : `19${year}`;
      } else if (year.length === 3) {
        year = `19${year.slice(-2)}`;
      }
      return `${year}-${month}-${dd.padStart(2, "0")}`;
    }
  }
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : raw;
}

function mapStudentCsvValues(values) {
  const row = {};
  STUDENT_TEMPLATE_COLUMNS.forEach((column, index) => {
    if (!column.key) return;
    row[column.key] = String(values[index] == null ? "" : values[index]).trim();
  });
  return row;
}

function normalizeStudentRecord(record) {
  const next = {};
  STUDENT_CORE_FIELD_KEYS.forEach((key) => {
    next[key] = normalizeOptionalText(record[key]);
  });

  next.name = next.name || next.full_name || null;
  next.full_name = next.full_name || next.name || null;
  next.gender = normalizeGender(record.gender);
  next.dob = normalizeDateValue(record.dob);
  next.dob_ayah = normalizeDateValue(record.dob_ayah);
  next.dob_ibu = normalizeDateValue(record.dob_ibu);
  next.emergency_contact = next.emergency_contact || "-";

  return next;
}

function getStudentFieldMeta(key) {
  return STUDENT_TEMPLATE_COLUMNS.find((column) => column.key === key) || null;
}

function getStudentTableSql(tableName = "students") {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      student_id TEXT NOT NULL,
      qr_token TEXT UNIQUE,
      no_sb TEXT,
      no_bruhims TEXT,
      bangsa TEXT,
      ugama TEXT,
      kerakyatan TEXT,
      gender TEXT,
      dob TEXT,
      age TEXT,
      level TEXT,
      notes TEXT,
      emergency_contact TEXT,
      email TEXT,
      alamat TEXT,
      nama_ayah TEXT,
      pekerjaan_ayah TEXT,
      dob_ayah TEXT,
      taraf_ayah TEXT,
      no_telefon_ayah TEXT,
      bangsa_ayah TEXT,
      ugama_ayah TEXT,
      kerakyatan_ayah TEXT,
      nama_ibu TEXT,
      pekerjaan_ibu TEXT,
      dob_ibu TEXT,
      taraf_ibu TEXT,
      no_telefon_ibu TEXT,
      bangsa_ibu TEXT,
      ugama_ibu TEXT,
      kerakyatan_ibu TEXT,
      family_id TEXT,
      yiuran_sekolah_paid INTEGER NOT NULL DEFAULT 0,
      yuran_pibg_paid INTEGER NOT NULL DEFAULT 0,
      insuran_paid INTEGER NOT NULL DEFAULT 0,
      avatar_path TEXT,
      photo_path TEXT,
      photo_uploaded_at TEXT,
      photo_uploaded_by INTEGER,
      photo_2_path TEXT,
      photo_2_uploaded_at TEXT,
      photo_2_uploaded_by INTEGER,
      photo_3_path TEXT,
      photo_3_uploaded_at TEXT,
      photo_3_uploaded_by INTEGER,
      photo_4_path TEXT,
      photo_4_uploaded_at TEXT,
      photo_4_uploaded_by INTEGER,
      photo_5_path TEXT,
      photo_5_uploaded_at TEXT,
      photo_5_uploaded_by INTEGER,
      photo_6_path TEXT,
      photo_6_uploaded_at TEXT,
      photo_6_uploaded_by INTEGER,
      class_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (class_id) REFERENCES classes(id)
    )
  `;
}

module.exports = {
  STUDENT_TEMPLATE_COLUMNS,
  STUDENT_DB_COLUMNS,
  STUDENT_CORE_FIELD_KEYS,
  STUDENT_FORM_GROUPS,
  buildStudentTemplateCsv,
  createStudentQrToken,
  csvEscape,
  getStudentFieldMeta,
  getStudentTableSql,
  mapStudentCsvValues,
  normalizeClassName,
  normalizeDateValue,
  normalizeGender,
  normalizeOptionalText,
  normalizeStudentRecord,
  validateStudentTemplateHeaders
};
