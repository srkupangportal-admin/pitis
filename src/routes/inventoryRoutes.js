const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");
const { generateInventoryQrDataUrl } = require("../services/qrCodeService");

const router = express.Router();
const inventoryRoles = ["teacher", "staff", "admin"];
const inventoryStatuses = ["available", "in_use", "maintenance", "unavailable", "inactive"];
const inventoryDocumentUploadDir = path.join(__dirname, "..", "..", "public", "uploads", "inventory-documents");
const inventoryCsvColumns = [
  "name",
  "code",
  "category",
  "location",
  "condition",
  "availability",
  "available_for_booking",
  "notes"
];
const inventoryOptionTypes = {
  locations: { table: "inventory_locations", field: "location", label: "Location" },
  categories: { table: "inventory_categories", field: "category", label: "Category" },
  conditions: { table: "inventory_conditions", field: "item_condition", label: "Condition" },
  availability: { table: "inventory_availability_options", field: "status", label: "Availability" }
};

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "");
    const type = String(file.mimetype || "");
    if (/\.csv$/i.test(name) || type.includes("csv") || type === "text/plain") return cb(null, true);
    return cb(new Error("Only CSV files are allowed"));
  }
});

if (!fs.existsSync(inventoryDocumentUploadDir)) {
  fs.mkdirSync(inventoryDocumentUploadDir, { recursive: true });
}

function sanitizeDocumentFilename(name) {
  return String(name || "inventory-document")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "inventory-document";
}

function getInventoryDocumentType(file) {
  const originalName = String(file.originalname || "");
  const mimeType = String(file.mimetype || "");
  if (mimeType === "application/pdf" || /\.pdf$/i.test(originalName)) return "pdf";
  if (mimeType === "image/jpeg" || /\.jpe?g$/i.test(originalName)) return "jpg";
  return "";
}

const inventoryDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, inventoryDocumentUploadDir),
    filename: (req, file, cb) => {
      const itemId = Number(req.params.id || 0) || "item";
      const ext = getInventoryDocumentType(file) === "pdf" ? ".pdf" : ".jpg";
      const baseName = sanitizeDocumentFilename(path.basename(file.originalname || "document", path.extname(file.originalname || "")));
      cb(null, `${itemId}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${baseName}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (getInventoryDocumentType(file)) return cb(null, true);
    return cb(new Error("Only PDF and JPG files are allowed"));
  }
});

function getInventoryDocumentPublicPath(file) {
  return `/uploads/inventory-documents/${file.filename}`;
}

function handleInventoryDocumentUpload(req, res, next) {
  inventoryDocumentUpload.single("inventory_document")(req, res, (error) => {
    if (!error) return next();
    return redirectWithMessage(res, getReturnPath(req, "/inventory"), "error", error.message || "Unable to upload inventory document");
  });
}

function removeManagedInventoryDocument(filePath) {
  const relativePath = String(filePath || "");
  if (!relativePath.startsWith("/uploads/inventory-documents/")) return;
  const absolutePath = path.join(__dirname, "..", "..", "public", relativePath.replace(/^\//, ""));
  if (!absolutePath.startsWith(inventoryDocumentUploadDir)) return;
  try {
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (_err) {
    // A missing file should not block deleting the database record.
  }
}

function getInventoryDocumentMap(inventoryIds) {
  const ids = (inventoryIds || []).map((id) => Number(id || 0)).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const documents = db.prepare(`
    SELECT *
    FROM inventory_documents
    WHERE inventory_id IN (${placeholders})
    ORDER BY uploaded_at DESC, id DESC
  `).all(...ids);
  documents.forEach((document) => {
    const list = map.get(document.inventory_id) || [];
    list.push(document);
    map.set(document.inventory_id, list);
  });
  return map;
}

function getInventoryDetailFields(activeOnly = true) {
  return db.prepare(`
    SELECT id, field_key, label, field_type, is_active, sort_order, created_at, updated_at
    FROM inventory_detail_fields
    ${activeOnly ? "WHERE is_active = 1" : ""}
    ORDER BY is_active DESC, sort_order ASC, LOWER(label) ASC, id ASC
  `).all();
}

function makeDetailFieldKey(label) {
  const base = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "detail";
  let key = base;
  let suffix = 2;
  while (db.prepare("SELECT id FROM inventory_detail_fields WHERE field_key = ?").get(key)) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  return key;
}

function normalizeDetailFieldType(value) {
  const type = String(value || "").trim().toLowerCase();
  return ["text", "date", "number"].includes(type) ? type : "text";
}

function getInventoryDetailMap(inventoryIds) {
  const ids = (inventoryIds || []).map((id) => Number(id || 0)).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT idv.inventory_id, idv.field_id, idf.field_key, idf.label, idf.field_type, idv.value
    FROM inventory_detail_values idv
    JOIN inventory_detail_fields idf ON idf.id = idv.field_id
    WHERE idv.inventory_id IN (${placeholders})
    ORDER BY idf.sort_order ASC, LOWER(idf.label) ASC
  `).all(...ids);
  rows.forEach((row) => {
    const details = map.get(row.inventory_id) || {};
    details[row.field_id] = row.value || "";
    details[row.field_key] = row.value || "";
    map.set(row.inventory_id, details);
  });
  return map;
}

function saveInventoryDetailValues(inventoryId, detailValues) {
  const itemId = Number(inventoryId || 0);
  if (!itemId || !detailValues || !Object.keys(detailValues).length) return;
  const now = dayjs().toISOString();
  const deleteValue = db.prepare("DELETE FROM inventory_detail_values WHERE inventory_id = ? AND field_id = ?");
  const upsertValue = db.prepare(`
    INSERT INTO inventory_detail_values (inventory_id, field_id, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(inventory_id, field_id) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);

  Object.entries(detailValues).forEach(([fieldIdRaw, rawValue]) => {
    const fieldId = Number(fieldIdRaw || 0);
    if (!fieldId) return;
    const value = String(rawValue == null ? "" : rawValue).trim();
    if (!value) {
      deleteValue.run(itemId, fieldId);
      return;
    }
    upsertValue.run(itemId, fieldId, value, now);
  });
}

function getSubmittedDetailValues(body, detailFields) {
  const values = {};
  (detailFields || []).forEach((field) => {
    values[field.id] = String((body || {})[`detail_${field.id}`] || "").trim();
  });
  return values;
}

function encodeMessage(message) {
  return encodeURIComponent(message || "");
}

function getReturnPath(req, fallback) {
  const raw = String(req.body.return_to || req.query.return_to || "").trim();
  return raw.startsWith("/") ? raw : fallback;
}

function redirectWithMessage(res, returnPath, key, message) {
  const separator = String(returnPath || "").includes("?") ? "&" : "?";
  return res.redirect(`${returnPath}${separator}${key}=${encodeMessage(message)}`);
}

function createInventoryToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function createUniqueInventoryToken() {
  const findByToken = db.prepare("SELECT id FROM school_inventory WHERE token = ? LIMIT 1");
  let token = createInventoryToken();
  while (findByToken.get(token)) {
    token = createInventoryToken();
  }
  return token;
}

function parseBooleanFlag(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on", "available", "bookable"].includes(raw) ? 1 : 0;
}

function mapInventoryStatusToDeviceStatus(status) {
  const value = String(status || "").trim();
  if (value === "available") return "available";
  if (value === "maintenance") return "maintenance";
  if (value === "inactive") return "inactive";
  return "unavailable";
}

function ensureInventoryDeviceForBooking(item) {
  if (!item || Number(item.isBookable || item.is_bookable || 0) !== 1) {
    return Number(item && item.linked_device_id ? item.linked_device_id : 0) || null;
  }

  const now = dayjs().toISOString();
  const deviceStatus = mapInventoryStatusToDeviceStatus(item.status);
  let existingLinkedId = Number(item.linked_device_id || 0);
  let existingById = existingLinkedId ? db.prepare("SELECT id FROM devices WHERE id = ?").get(existingLinkedId) : null;
  const duplicateByCode = db.prepare("SELECT id FROM devices WHERE UPPER(code) = ? AND id <> ?").get(String(item.code || "").toUpperCase(), existingLinkedId || 0);

  if (!existingById && duplicateByCode) {
    existingLinkedId = Number(duplicateByCode.id);
    existingById = duplicateByCode;
  } else if (duplicateByCode && Number(duplicateByCode.id) !== existingLinkedId) {
    throw new Error(`Device code ${item.code} already exists in Device Booking`);
  }

  if (existingById) {
    db.prepare(`
      UPDATE devices
      SET name = ?,
          code = ?,
          category = ?,
          location = ?,
          status = ?,
          notes = ?,
          updated_at = ?
      WHERE id = ?
    `).run(item.name, item.code, item.category, item.location, deviceStatus, item.notes || null, now, existingLinkedId);
    return existingLinkedId;
  }

  const inserted = db.prepare(`
    INSERT INTO devices
      (name, code, category, brand, model, serial_number, location, status, notes, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
  `).run(item.name, item.code, item.category, item.location, deviceStatus, item.notes || null, now, now);
  return Number(inserted.lastInsertRowid);
}

function csvEscape(value) {
  const str = String(value == null ? "" : value);
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function sendCsv(res, filename, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
}

function normalizeCsvHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function getCsvValue(row, keys) {
  for (const key of keys) {
    const normalized = normalizeCsvHeader(key);
    if (Object.prototype.hasOwnProperty.call(row, normalized)) {
      return String(row[normalized] == null ? "" : row[normalized]).trim();
    }
  }
  return "";
}

function normalizeOptionName(value) {
  return String(value || "").trim();
}

function getOptionConfig(type) {
  return inventoryOptionTypes[String(type || "").trim()];
}

function getInventoryOptionRows(type, activeOnly = false) {
  const config = getOptionConfig(type);
  if (!config) return [];
  const where = activeOnly ? "WHERE is_active = 1" : "";
  return db.prepare(`
    SELECT id, name, is_active, created_at, updated_at
    FROM ${config.table}
    ${where}
    ORDER BY is_active DESC, LOWER(name) ASC
  `).all();
}

function getActiveAvailabilityOptions() {
  const options = getInventoryOptionRows("availability", true)
    .filter((option) => inventoryStatuses.includes(option.name));
  if (options.length) return options;
  return inventoryStatuses.map((name, index) => ({ id: index + 1, name, is_active: 1 }));
}

function inventoryOptionExists(type, name, activeOnly = true) {
  const config = getOptionConfig(type);
  const value = normalizeOptionName(name);
  if (!config || !value) return false;
  if (type === "availability" && !inventoryStatuses.includes(value)) return false;
  const activeClause = activeOnly ? "AND is_active = 1" : "";
  return Boolean(db.prepare(`SELECT id FROM ${config.table} WHERE name = ? ${activeClause}`).get(value));
}

function addOrReactivateInventoryOption(type, name) {
  const config = getOptionConfig(type);
  const value = normalizeOptionName(name);
  if (!config || !value) return false;
  if (type === "availability" && !inventoryStatuses.includes(value)) return false;
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO ${config.table} (name, is_active, created_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at
  `).run(value, now, now);
  return true;
}

function renameInventoryOption(type, id, name) {
  const config = getOptionConfig(type);
  const optionId = Number(id || 0);
  const value = normalizeOptionName(name);
  if (!config || !optionId || !value) return false;
  if (type === "availability" && !inventoryStatuses.includes(value)) return false;

  const existing = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(optionId);
  if (!existing) return false;
  const duplicate = db.prepare(`SELECT id FROM ${config.table} WHERE name = ? AND id <> ?`).get(value, optionId);
  if (duplicate) return false;

  const now = dayjs().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE ${config.table} SET name = ?, is_active = 1, updated_at = ? WHERE id = ?`).run(value, now, optionId);
    db.prepare(`UPDATE school_inventory SET ${config.field} = ?, updated_at = ? WHERE ${config.field} = ?`).run(value, now, existing.name);
  });
  tx();
  return true;
}

function removeInventoryOption(type, id) {
  const config = getOptionConfig(type);
  const optionId = Number(id || 0);
  if (!config || !optionId) return false;
  const existing = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(optionId);
  if (!existing) return false;
  const usage = db.prepare(`SELECT COUNT(*) AS count FROM school_inventory WHERE ${config.field} = ?`).get(existing.name);
  if (usage && usage.count > 0) {
    db.prepare(`UPDATE ${config.table} SET is_active = 0, updated_at = ? WHERE id = ?`).run(dayjs().toISOString(), optionId);
  } else {
    db.prepare(`DELETE FROM ${config.table} WHERE id = ?`).run(optionId);
  }
  return true;
}

function getInventoryRows(user, filters = {}) {
  const isAdmin = user && user.role === "admin";
  const clauses = [];
  const params = [];
  if (!isAdmin) {
    clauses.push("inv.status = 'available'");
  } else if (filters.status) {
    clauses.push("inv.status = ?");
    params.push(filters.status);
  }
  if (filters.category) {
    clauses.push("inv.category = ?");
    params.push(filters.category);
  }
  if (filters.location) {
    clauses.push("inv.location = ?");
    params.push(filters.location);
  }
  if (filters.condition) {
    clauses.push("inv.item_condition = ?");
    params.push(filters.condition);
  }
  if (filters.search) {
    clauses.push("(LOWER(inv.name) LIKE ? OR LOWER(inv.code) LIKE ? OR LOWER(inv.notes) LIKE ?)");
    const like = `%${filters.search.toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT inv.*, d.name AS linked_device_name, d.code AS linked_device_code
    FROM school_inventory inv
    LEFT JOIN devices d ON d.id = inv.linked_device_id
    ${where}
    ORDER BY
      CASE inv.status WHEN 'available' THEN 0 WHEN 'in_use' THEN 1 WHEN 'maintenance' THEN 2 WHEN 'unavailable' THEN 3 ELSE 4 END,
      LOWER(inv.category) ASC,
      LOWER(inv.name) ASC
  `).all(...params);
}

function getDeviceOptions() {
  return db
    .prepare("SELECT id, name, code, category, location FROM devices WHERE status <> 'inactive' ORDER BY LOWER(category) ASC, LOWER(name) ASC")
    .all();
}

function getLinkedDeviceIdFromCsv(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!code) return null;
  const device = db.prepare("SELECT id FROM devices WHERE UPPER(code) = ?").get(code);
  return device ? device.id : undefined;
}

function getInventoryExportRows(detailFields) {
  const rows = db.prepare(`
    SELECT inv.*, d.code AS linked_device_code
    FROM school_inventory inv
    LEFT JOIN devices d ON d.id = inv.linked_device_id
    ORDER BY LOWER(inv.category) ASC, LOWER(inv.name) ASC
  `).all();
  const detailMap = getInventoryDetailMap(rows.map((row) => row.id));
  return [
    ["name", "code", "category", "location", "condition", "availability", "available_for_booking", "linked_device_code", "notes", "token", ...(detailFields || []).map((field) => field.label)],
    ...rows.map((row) => [
      row.name,
      row.code,
      row.category,
      row.location,
      row.item_condition,
      row.status,
      Number(row.is_bookable) === 1 ? "yes" : "no",
      row.linked_device_code || "",
      row.notes || "",
      row.token || "",
      ...(detailFields || []).map((field) => (detailMap.get(row.id) || {})[field.id] || "")
    ])
  ];
}

function normalizeInventoryCsvRows(buffer, detailFields) {
  const records = parse(buffer.toString("utf8"), {
    bom: true,
    columns: (headers) => headers.map(normalizeCsvHeader),
    skip_empty_lines: true,
    trim: true
  });
  return records.map((row, index) => {
    const name = getCsvValue(row, ["name", "item_name", "inventory_name"]);
    const code = getCsvValue(row, ["code", "inventory_code"]).toUpperCase();
    const category = getCsvValue(row, ["category"]);
    const location = getCsvValue(row, ["location", "venue"]);
    const itemCondition = getCsvValue(row, ["condition", "item_condition"]) || "good";
    const status = getCsvValue(row, ["availability", "status"]) || "available";
    const linkedDeviceCode = getCsvValue(row, ["linked_device_code", "device_code"]);
    const isBookable = parseBooleanFlag(getCsvValue(row, ["available_for_booking", "bookable", "device_booking"]));
    const notes = getCsvValue(row, ["notes", "remarks"]);
    const token = getCsvValue(row, ["token", "qr_token"]);
    const detailValues = {};
    (detailFields || []).forEach((field) => {
      const keys = [`detail_${field.field_key}`, field.field_key, field.label];
      const hasDetailHeader = keys.some((key) => Object.prototype.hasOwnProperty.call(row, normalizeCsvHeader(key)));
      if (hasDetailHeader) {
        detailValues[field.id] = getCsvValue(row, keys);
      }
    });
    return {
      rowNumber: index + 2,
      name,
      code,
      category,
      location,
      itemCondition,
      status,
      linkedDeviceCode,
      isBookable,
      notes,
      token,
      detailValues
    };
  });
}

function importInventoryRows(rows, mode) {
  if (!rows.length) {
    return { added: 0, updated: 0, skipped: 0, errors: ["CSV has no inventory rows"] };
  }

  const errors = [];
  const seenCodes = new Set();
  const normalized = rows.map((row) => {
    if (!row.name || !row.code || !row.category || !row.location || !row.status) {
      errors.push(`Row ${row.rowNumber}: name, code, category, location, and availability are required`);
    }
    if (row.status && !inventoryStatuses.includes(row.status)) {
      errors.push(`Row ${row.rowNumber}: availability must be one of ${inventoryStatuses.join(", ")}`);
    }
    if (seenCodes.has(row.code)) {
      errors.push(`Row ${row.rowNumber}: duplicate inventory code ${row.code}`);
    }
    seenCodes.add(row.code);
    const linkedDeviceId = getLinkedDeviceIdFromCsv(row.linkedDeviceCode);
    if (linkedDeviceId === undefined) {
      errors.push(`Row ${row.rowNumber}: linked device code ${row.linkedDeviceCode} was not found`);
    }
    return { ...row, linkedDeviceId };
  });

  if (errors.length) {
    return { added: 0, updated: 0, skipped: rows.length, errors };
  }

  const tx = db.transaction(() => {
    const now = dayjs().toISOString();
    let added = 0;
    let updated = 0;
    let deletedDocumentPaths = [];

    if (mode === "overwrite") {
      deletedDocumentPaths = db.prepare("SELECT file_path FROM inventory_documents").all().map((row) => row.file_path);
      db.prepare("DELETE FROM inventory_documents").run();
      db.prepare("DELETE FROM school_inventory").run();
    }

    const findByCode = db.prepare("SELECT id, token, linked_device_id FROM school_inventory WHERE code = ?");
    const findByToken = db.prepare("SELECT id FROM school_inventory WHERE token = ? AND id <> ?");
    const insert = db.prepare(`
      INSERT INTO school_inventory
        (name, code, category, location, item_condition, status, token, linked_device_id, is_bookable, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE school_inventory
      SET name = ?,
          category = ?,
          location = ?,
          item_condition = ?,
          status = ?,
          token = ?,
          linked_device_id = ?,
          is_bookable = ?,
          notes = ?,
          updated_at = ?
      WHERE id = ?
    `);

    normalized.forEach((row) => {
      addOrReactivateInventoryOption("categories", row.category);
      addOrReactivateInventoryOption("locations", row.location);
      addOrReactivateInventoryOption("conditions", row.itemCondition);
      addOrReactivateInventoryOption("availability", row.status);

      const existing = findByCode.get(row.code);
      let token = String(row.token || "").trim();
      if (!token || (existing && findByToken.get(token, existing.id)) || (!existing && db.prepare("SELECT id FROM school_inventory WHERE token = ?").get(token))) {
        token = existing && existing.token ? existing.token : createUniqueInventoryToken();
      }

      let linkedDeviceId = row.linkedDeviceId || (existing ? Number(existing.linked_device_id || 0) || null : null);
      if (row.isBookable) {
        linkedDeviceId = ensureInventoryDeviceForBooking({
          ...row,
          item_condition: row.itemCondition,
          linked_device_id: linkedDeviceId,
          is_bookable: 1,
          notes: row.notes || null
        });
      }

      if (existing) {
        update.run(row.name, row.category, row.location, row.itemCondition, row.status, token, linkedDeviceId, row.isBookable, row.notes || null, now, existing.id);
        saveInventoryDetailValues(existing.id, row.detailValues);
        updated += 1;
      } else {
        const result = insert.run(row.name, row.code, row.category, row.location, row.itemCondition, row.status, token || createUniqueInventoryToken(), linkedDeviceId, row.isBookable, row.notes || null, now, now);
        saveInventoryDetailValues(Number(result.lastInsertRowid), row.detailValues);
        added += 1;
      }
    });

    return { added, updated, skipped: 0, errors: [], deletedDocumentPaths };
  });

  return tx();
}

router.get("/inventory", requireRole(inventoryRoles), async (req, res) => {
  const isAdmin = req.session.user && req.session.user.role === "admin";
  const filters = {
    search: String(req.query.search || "").trim(),
    category: String(req.query.category || "").trim(),
    location: String(req.query.location || "").trim(),
    condition: String(req.query.condition || "").trim(),
    status: isAdmin ? String(req.query.availability || req.query.status || "").trim() : ""
  };
  if (filters.status && !inventoryStatuses.includes(filters.status)) {
    filters.status = "";
  }

  const inventoryRows = getInventoryRows(req.session.user, filters);
  const documentMap = getInventoryDocumentMap(inventoryRows.map((item) => item.id));
  const detailFields = getInventoryDetailFields(true);
  const allDetailFields = getInventoryDetailFields(false);
  const detailMap = getInventoryDetailMap(inventoryRows.map((item) => item.id));
  const inventory = await Promise.all(inventoryRows.map(async (item) => ({
    ...item,
    documents: documentMap.get(item.id) || [],
    detail_values: detailMap.get(item.id) || {},
    qr_url: `${res.locals.requestOrigin}/inventory/qr/${encodeURIComponent(item.token)}`,
    qr_code_image: await generateInventoryQrDataUrl({
      ...item,
      qr_url: `${res.locals.requestOrigin}/inventory/qr/${encodeURIComponent(item.token)}`
    })
  })));

  res.render("inventory", {
    inventory,
    deviceOptions: getDeviceOptions(),
    inventoryStatuses,
    inventoryLocationOptions: getInventoryOptionRows("locations", true),
    inventoryCategoryOptions: getInventoryOptionRows("categories", true),
    inventoryConditionOptions: getInventoryOptionRows("conditions", true),
    inventoryAvailabilityOptions: getActiveAvailabilityOptions(),
    allInventoryLocationOptions: getInventoryOptionRows("locations"),
    allInventoryCategoryOptions: getInventoryOptionRows("categories"),
    allInventoryConditionOptions: getInventoryOptionRows("conditions"),
    allInventoryAvailabilityOptions: getInventoryOptionRows("availability").filter((option) => inventoryStatuses.includes(option.name)),
    inventoryDetailFields: detailFields,
    allInventoryDetailFields: allDetailFields,
    filters,
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.get("/inventory/qr/:token", requireRole(inventoryRoles), (req, res) => {
  const token = String(req.params.token || "").trim();
  const item = db.prepare(`
    SELECT inv.*, d.name AS linked_device_name, d.code AS linked_device_code
    FROM school_inventory inv
    LEFT JOIN devices d ON d.id = inv.linked_device_id
    WHERE inv.token = ?
  `).get(token);

  if (!item) {
    return res.status(404).send("Inventory item not found");
  }
  if (req.session.user.role !== "admin" && item.status !== "available") {
    return res.status(403).send("Inventory item is not available");
  }

  res.render("inventory-qr-info", {
    item,
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.get("/admin/inventory/template", requireRole("admin"), (_req, res) => {
  const detailFields = getInventoryDetailFields(true);
  return sendCsv(res, "inventory-import-template.csv", [
    [...inventoryCsvColumns, ...detailFields.map((field) => field.label)],
    ["Science Kit A", "INV-001", "Teaching Aid", "Resource Room", "good", "available", "no", "Optional notes", ...detailFields.map((field) => field.field_type === "date" ? dayjs().format("YYYY-MM-DD") : "")],
    ["Laptop Cart 01", "INV-002", "ICT", "Device Hub", "good", "available", "yes", "Shown in Device Bookings", ...detailFields.map((field) => field.field_type === "number" ? "1" : "")]
  ]);
});

router.get("/admin/inventory/export", requireRole("admin"), (_req, res) => {
  const stamp = dayjs().format("YYYYMMDD-HHmmss");
  return sendCsv(res, `school-inventory-${stamp}.csv`, getInventoryExportRows(getInventoryDetailFields(false)));
});

router.post("/admin/inventory/import", requireRole("admin"), csvUpload.single("inventory_csv"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  try {
    if (!req.file) {
      return redirectWithMessage(res, returnPath, "error", "Inventory CSV file is required");
    }
    const mode = String(req.body.import_mode || "").trim() === "overwrite" ? "overwrite" : "append";
    const rows = normalizeInventoryCsvRows(req.file.buffer, getInventoryDetailFields(false));
    const result = importInventoryRows(rows, mode);
    if (result.errors.length) {
      return redirectWithMessage(res, returnPath, "error", result.errors.slice(0, 6).join(" | "));
    }
    (result.deletedDocumentPaths || []).forEach(removeManagedInventoryDocument);
    const modeLabel = mode === "overwrite" ? "overwritten" : "updated";
    return redirectWithMessage(res, returnPath, "success", `Inventory ${modeLabel}: ${result.added} added, ${result.updated} updated`);
  } catch (error) {
    return redirectWithMessage(res, returnPath, "error", error.message || "Unable to import inventory CSV");
  }
});

router.post("/admin/inventory", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const name = String(req.body.name || "").trim();
  const code = String(req.body.code || "").trim().toUpperCase();
  const category = String(req.body.category || "").trim();
  const location = String(req.body.location || "").trim();
  const itemCondition = String(req.body.item_condition || "").trim() || "good";
  const status = inventoryStatuses.includes(String(req.body.status || "").trim()) ? String(req.body.status || "").trim() : "";
  const isBookable = String(req.body.is_bookable || "") === "1" ? 1 : 0;
  const notes = String(req.body.notes || "").trim();
  const detailFields = getInventoryDetailFields(true);
  const detailValues = getSubmittedDetailValues(req.body, detailFields);

  if (!name || !code || !category || !location || !status) {
    return redirectWithMessage(res, returnPath, "error", "Please complete all required inventory fields");
  }
  if (!inventoryOptionExists("categories", category) || !inventoryOptionExists("locations", location) || !inventoryOptionExists("conditions", itemCondition) || !inventoryOptionExists("availability", status)) {
    return redirectWithMessage(res, returnPath, "error", "Please choose valid inventory options");
  }
  if (db.prepare("SELECT id FROM school_inventory WHERE code = ?").get(code)) {
    return redirectWithMessage(res, returnPath, "error", "Inventory code must be unique");
  }
  const now = dayjs().toISOString();
  try {
    const tx = db.transaction(() => {
      let linkedDeviceId = null;
      if (isBookable) {
        linkedDeviceId = ensureInventoryDeviceForBooking({
          name,
          code,
          category,
          location,
          status,
          is_bookable: isBookable,
          notes: notes || null
        });
      }
      const result = db.prepare(`
        INSERT INTO school_inventory
          (name, code, category, location, item_condition, status, token, linked_device_id, is_bookable, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, code, category, location, itemCondition, status, createUniqueInventoryToken(), linkedDeviceId, isBookable, notes || null, now, now);
      saveInventoryDetailValues(Number(result.lastInsertRowid), detailValues);
    });
    tx();
  } catch (error) {
    return redirectWithMessage(res, returnPath, "error", error.message || "Unable to add inventory item");
  }

  return redirectWithMessage(res, returnPath, "success", "Inventory item added");
});

router.post("/admin/inventory/:id/documents", requireRole("admin"), handleInventoryDocumentUpload, (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const itemId = Number(req.params.id || 0);
  const existing = db.prepare("SELECT id FROM school_inventory WHERE id = ?").get(itemId);
  if (!existing) {
    if (req.file) removeManagedInventoryDocument(getInventoryDocumentPublicPath(req.file));
    return redirectWithMessage(res, returnPath, "error", "Inventory item not found");
  }
  if (!req.file) {
    return redirectWithMessage(res, returnPath, "error", "Please choose a PDF or JPG document");
  }

  const documentType = getInventoryDocumentType(req.file);
  if (!documentType) {
    removeManagedInventoryDocument(getInventoryDocumentPublicPath(req.file));
    return redirectWithMessage(res, returnPath, "error", "Only PDF and JPG files are allowed");
  }

  db.prepare(`
    INSERT INTO inventory_documents
      (inventory_id, original_name, file_name, file_path, mime_type, document_type, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    itemId,
    req.file.originalname,
    req.file.filename,
    getInventoryDocumentPublicPath(req.file),
    req.file.mimetype || (documentType === "pdf" ? "application/pdf" : "image/jpeg"),
    documentType,
    req.session.user ? req.session.user.id : null,
    dayjs().toISOString()
  );

  return redirectWithMessage(res, returnPath, "success", "Inventory document uploaded");
});

router.post("/admin/inventory/documents/:documentId/delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const documentId = Number(req.params.documentId || 0);
  const document = db.prepare("SELECT * FROM inventory_documents WHERE id = ?").get(documentId);
  if (!document) {
    return redirectWithMessage(res, returnPath, "error", "Inventory document not found");
  }

  db.prepare("DELETE FROM inventory_documents WHERE id = ?").run(documentId);
  removeManagedInventoryDocument(document.file_path);
  return redirectWithMessage(res, returnPath, "success", "Inventory document deleted");
});

router.post("/admin/inventory/:id/edit", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const itemId = Number(req.params.id || 0);
  const existing = db.prepare("SELECT * FROM school_inventory WHERE id = ?").get(itemId);
  if (!existing) {
    return redirectWithMessage(res, returnPath, "error", "Inventory item not found");
  }

  const name = String(req.body.name || "").trim();
  const code = String(req.body.code || "").trim().toUpperCase();
  const category = String(req.body.category || "").trim();
  const location = String(req.body.location || "").trim();
  const itemCondition = String(req.body.item_condition || "").trim() || "good";
  const status = inventoryStatuses.includes(String(req.body.status || "").trim()) ? String(req.body.status || "").trim() : "";
  const isBookable = String(req.body.is_bookable || "") === "1" ? 1 : 0;
  const notes = String(req.body.notes || "").trim();
  const detailFields = getInventoryDetailFields(true);
  const detailValues = getSubmittedDetailValues(req.body, detailFields);

  if (!name || !code || !category || !location || !status) {
    return redirectWithMessage(res, returnPath, "error", "Please complete all required inventory fields");
  }
  if (!inventoryOptionExists("categories", category, false) || !inventoryOptionExists("locations", location, false) || !inventoryOptionExists("conditions", itemCondition, false) || !inventoryOptionExists("availability", status, false)) {
    return redirectWithMessage(res, returnPath, "error", "Please choose valid inventory options");
  }
  const duplicate = db.prepare("SELECT id FROM school_inventory WHERE code = ? AND id <> ?").get(code, itemId);
  if (duplicate) {
    return redirectWithMessage(res, returnPath, "error", "Inventory code must be unique");
  }
  try {
    const tx = db.transaction(() => {
      let linkedDeviceId = Number(existing.linked_device_id || 0) || null;
      if (isBookable) {
        linkedDeviceId = ensureInventoryDeviceForBooking({
          name,
          code,
          category,
          location,
          status,
          linked_device_id: linkedDeviceId,
          is_bookable: isBookable,
          notes: notes || null
        });
      }

      db.prepare(`
        UPDATE school_inventory
        SET name = ?,
            code = ?,
            category = ?,
            location = ?,
            item_condition = ?,
            status = ?,
            linked_device_id = ?,
            is_bookable = ?,
            notes = ?,
            updated_at = ?
        WHERE id = ?
      `).run(name, code, category, location, itemCondition, status, linkedDeviceId, isBookable, notes || null, dayjs().toISOString(), itemId);
      saveInventoryDetailValues(itemId, detailValues);
    });
    tx();
  } catch (error) {
    return redirectWithMessage(res, returnPath, "error", error.message || "Unable to update inventory item");
  }

  return redirectWithMessage(res, returnPath, "success", "Inventory item updated");
});

router.post("/admin/inventory/:id/delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const itemId = Number(req.params.id || 0);
  const existing = db.prepare("SELECT * FROM school_inventory WHERE id = ?").get(itemId);
  if (!existing) {
    return redirectWithMessage(res, returnPath, "error", "Inventory item not found");
  }
  const documentPaths = db.prepare("SELECT file_path FROM inventory_documents WHERE inventory_id = ?").all(itemId).map((row) => row.file_path);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM inventory_documents WHERE inventory_id = ?").run(itemId);
    db.prepare("DELETE FROM school_inventory WHERE id = ?").run(itemId);
  });
  tx();
  documentPaths.forEach(removeManagedInventoryDocument);
  return redirectWithMessage(res, returnPath, "success", "Inventory item deleted");
});

router.post("/admin/inventory-detail-fields", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const label = String(req.body.label || "").trim();
  const fieldType = normalizeDetailFieldType(req.body.field_type);
  if (!label) {
    return redirectWithMessage(res, returnPath, "error", "Detail label is required");
  }
  const duplicate = db.prepare("SELECT id FROM inventory_detail_fields WHERE LOWER(TRIM(label)) = LOWER(TRIM(?))").get(label);
  if (duplicate) {
    db.prepare("UPDATE inventory_detail_fields SET is_active = 1, field_type = ?, updated_at = ? WHERE id = ?").run(fieldType, dayjs().toISOString(), duplicate.id);
    return redirectWithMessage(res, returnPath, "success", "Inventory detail field reactivated");
  }
  const maxSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM inventory_detail_fields").get().max_sort || 0;
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO inventory_detail_fields (field_key, label, field_type, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(makeDetailFieldKey(label), label, fieldType, Number(maxSort) + 10, now, now);
  return redirectWithMessage(res, returnPath, "success", "Inventory detail field added");
});

router.post("/admin/inventory-detail-fields/:id/edit", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const fieldId = Number(req.params.id || 0);
  const label = String(req.body.label || "").trim();
  const fieldType = normalizeDetailFieldType(req.body.field_type);
  const isActive = String(req.body.is_active || "") === "1" ? 1 : 0;
  const sortOrder = Number.parseInt(String(req.body.sort_order || "0"), 10) || 0;
  if (!fieldId || !label) {
    return redirectWithMessage(res, returnPath, "error", "Detail field and label are required");
  }
  const existing = db.prepare("SELECT * FROM inventory_detail_fields WHERE id = ?").get(fieldId);
  if (!existing) {
    return redirectWithMessage(res, returnPath, "error", "Inventory detail field not found");
  }
  const duplicate = db.prepare("SELECT id FROM inventory_detail_fields WHERE LOWER(TRIM(label)) = LOWER(TRIM(?)) AND id <> ?").get(label, fieldId);
  if (duplicate) {
    return redirectWithMessage(res, returnPath, "error", "Inventory detail label already exists");
  }
  db.prepare(`
    UPDATE inventory_detail_fields
    SET label = ?, field_type = ?, is_active = ?, sort_order = ?, updated_at = ?
    WHERE id = ?
  `).run(label, fieldType, isActive, sortOrder, dayjs().toISOString(), fieldId);
  return redirectWithMessage(res, returnPath, "success", "Inventory detail field updated");
});

router.post("/admin/inventory-detail-fields/:id/delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const fieldId = Number(req.params.id || 0);
  const existing = db.prepare("SELECT id FROM inventory_detail_fields WHERE id = ?").get(fieldId);
  if (!existing) {
    return redirectWithMessage(res, returnPath, "error", "Inventory detail field not found");
  }
  const usage = db.prepare("SELECT COUNT(*) AS total FROM inventory_detail_values WHERE field_id = ? AND TRIM(COALESCE(value, '')) <> ''").get(fieldId);
  if (Number(usage.total || 0) > 0) {
    db.prepare("UPDATE inventory_detail_fields SET is_active = 0, updated_at = ? WHERE id = ?").run(dayjs().toISOString(), fieldId);
    return redirectWithMessage(res, returnPath, "success", "Inventory detail field has values, so it was hidden");
  }
  db.prepare("DELETE FROM inventory_detail_fields WHERE id = ?").run(fieldId);
  return redirectWithMessage(res, returnPath, "success", "Inventory detail field deleted");
});

router.post("/admin/inventory-options/:type", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const config = getOptionConfig(req.params.type);
  if (!config) {
    return redirectWithMessage(res, returnPath, "error", "Inventory option type not found");
  }
  if (!addOrReactivateInventoryOption(req.params.type, req.body.name)) {
    return redirectWithMessage(res, returnPath, "error", `Please enter a valid ${config.label.toLowerCase()}`);
  }
  return redirectWithMessage(res, returnPath, "success", `${config.label} option saved`);
});

router.post("/admin/inventory-options/:type/:id/edit", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const config = getOptionConfig(req.params.type);
  if (!config) {
    return redirectWithMessage(res, returnPath, "error", "Inventory option type not found");
  }
  if (!renameInventoryOption(req.params.type, req.params.id, req.body.name)) {
    return redirectWithMessage(res, returnPath, "error", `${config.label} option could not be updated`);
  }
  return redirectWithMessage(res, returnPath, "success", `${config.label} option updated`);
});

router.post("/admin/inventory-options/:type/:id/delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/inventory");
  const config = getOptionConfig(req.params.type);
  if (!config) {
    return redirectWithMessage(res, returnPath, "error", "Inventory option type not found");
  }
  if (!removeInventoryOption(req.params.type, req.params.id)) {
    return redirectWithMessage(res, returnPath, "error", `${config.label} option could not be removed`);
  }
  return redirectWithMessage(res, returnPath, "success", `${config.label} option removed`);
});

module.exports = router;
