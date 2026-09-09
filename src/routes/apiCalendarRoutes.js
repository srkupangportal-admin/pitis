const express = require("express");
const multer = require("multer");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const CATEGORY_LABEL_MAP = {
  hari_kelepasan_awam: {
    labelName: "Public Holiday",
    description: "National/public holiday"
  },
  cuti_penggal: {
    labelName: "Cuti Penggal",
    description: "School term break"
  }
};

router.use(requireRole("admin"));

function toBool(value) {
  if (typeof value === "boolean") return value;
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function parsePayload(req) {
  if (Array.isArray(req.body)) return req.body;

  if (Array.isArray(req.body.events)) return req.body.events;

  if (typeof req.body.events_json === "string" && req.body.events_json.trim()) {
    const parsed = JSON.parse(req.body.events_json);
    if (!Array.isArray(parsed)) throw new Error("events_json must be a JSON array");
    return parsed;
  }

  if (typeof req.body.json_text === "string" && req.body.json_text.trim()) {
    const parsed = JSON.parse(req.body.json_text);
    if (!Array.isArray(parsed)) throw new Error("json_text must be a JSON array");
    return parsed;
  }

  if (req.file && req.file.buffer) {
    const parsed = JSON.parse(req.file.buffer.toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("uploaded file must contain a JSON array");
    return parsed;
  }

  throw new Error("No event array provided");
}

function normalizeLabelName(name) {
  return String(name || "").trim();
}

function normalizeCategoryName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeImportedRow(raw) {
  const categoryKey = normalizeCategoryName(raw.category);
  const categoryConfig = CATEGORY_LABEL_MAP[categoryKey];
  const title = String(raw.title || "").trim();
  const startDate = String(raw.start || raw.start_date || "").trim();
  const endDateRaw = String(raw.end || raw.end_date || "").trim();
  const endDate = endDateRaw || startDate;
  const description = String(raw.description || raw.details || "").trim();
  const allDay = raw.allDay === undefined && raw.all_day === undefined ? true : toBool(raw.allDay ?? raw.all_day);
  const labelNames = new Set(
    (Array.isArray(raw.labels) ? raw.labels : [])
      .map(normalizeLabelName)
      .filter(Boolean)
  );

  if (categoryConfig) {
    labelNames.add(categoryConfig.labelName);
  }

  return {
    title,
    startDate,
    endDate,
    description: description || (categoryConfig ? categoryConfig.description : ""),
    allDay,
    category: categoryKey,
    labelNames: Array.from(labelNames)
  };
}

function colorFromLabelName(name) {
  const s = String(name || "Label");
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = s.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

router.post("/import", upload.single("events_file"), (req, res) => {
  let events;
  try {
    events = parsePayload(req);
  } catch (err) {
    console.error("[calendar import] payload parse failed:", err);
    return res.status(400).json({
      inserted: 0,
      skipped: 0,
      errors: [String(err.message || err)]
    });
  }

  const now = dayjs().toISOString();
  const createdBy = req.session.user.id;

  const findDup = db.prepare(
    `SELECT ce.id
     FROM calendar_events ce
     WHERE ce.is_deleted = 0
       AND ce.title = ?
       AND ce.event_date = ?
       AND COALESCE(ce.end_date, ce.event_date) = ?
       AND EXISTS (
         SELECT 1
         FROM calendar_event_labels cel
         JOIN calendar_labels cl ON cl.id = cel.label_id
         WHERE cel.event_id = ce.id AND cl.name = ?
       )
     LIMIT 1`
  );
  const insertEvent = db.prepare(
    `INSERT INTO calendar_events
     (title, details, event_date, end_date, event_source, created_by, created_at, is_deleted)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, 0)`
  );
  const findLabel = db.prepare("SELECT id FROM calendar_labels WHERE name = ?");
  const insertLabel = db.prepare(
    `INSERT INTO calendar_labels (name, color, description, created_by, is_system, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  const insertEventLabel = db.prepare(
    `INSERT OR IGNORE INTO calendar_event_labels (event_id, label_id)
     VALUES (?, ?)`
  );

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  console.info(`[calendar import] admin ${createdBy} submitted ${events.length} row(s)`);

  const tx = db.transaction((rows) => {
    rows.forEach((raw, index) => {
      const rowNo = index + 1;
      const event = normalizeImportedRow(raw);
      const {
        title,
        startDate,
        endDate,
        description,
        allDay,
        category,
        labelNames
      } = event;

      if (!title || !startDate || !endDate || !category) {
        skipped += 1;
        errors.push(`Row ${rowNo}: missing required title/start/end/category`);
        console.warn(`[calendar import] row ${rowNo} skipped: missing required field(s)`);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !dayjs(startDate).isValid()) {
        skipped += 1;
        errors.push(`Row ${rowNo}: invalid start_date (${startDate})`);
        console.warn(`[calendar import] row ${rowNo} skipped: invalid start date ${startDate}`);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !dayjs(endDate).isValid()) {
        skipped += 1;
        errors.push(`Row ${rowNo}: invalid end_date (${endDate})`);
        console.warn(`[calendar import] row ${rowNo} skipped: invalid end date ${endDate}`);
        return;
      }
      if (dayjs(endDate).isBefore(dayjs(startDate), "day")) {
        skipped += 1;
        errors.push(`Row ${rowNo}: end_date before start_date`);
        console.warn(`[calendar import] row ${rowNo} skipped: end before start`);
        return;
      }
      if (!CATEGORY_LABEL_MAP[category]) {
        skipped += 1;
        errors.push(`Row ${rowNo}: unsupported category (${category})`);
        console.warn(`[calendar import] row ${rowNo} skipped: unsupported category ${category}`);
        return;
      }

      const primaryLabelName = CATEGORY_LABEL_MAP[category].labelName;
      const dup = findDup.get(title, startDate, endDate, primaryLabelName);
      if (dup) {
        skipped += 1;
        console.info(`[calendar import] row ${rowNo} skipped: duplicate "${title}" on ${startDate}`);
        return;
      }

      const info = insertEvent.run(title, description, startDate, endDate, createdBy, now);
      const eventId = Number(info.lastInsertRowid);

      labelNames.forEach((labelName) => {
        let label = findLabel.get(labelName);
        if (!label) {
          insertLabel.run(labelName, colorFromLabelName(labelName), null, createdBy, now);
          label = findLabel.get(labelName);
        }
        if (label) {
          insertEventLabel.run(eventId, label.id);
        }
      });

      inserted += 1;
      console.info(
        `[calendar import] row ${rowNo} inserted: "${title}" (${startDate} -> ${endDate}, allDay=${allDay}, category=${category})`
      );
    });
  });

  try {
    tx(events);
  } catch (err) {
    console.error("[calendar import] transaction failed:", err);
    return res.status(500).json({
      inserted,
      skipped,
      errors: [...errors, `Import failed: ${String(err.message || err)}`]
    });
  }

  console.info(`[calendar import] completed: inserted=${inserted}, skipped=${skipped}, errors=${errors.length}`);

  return res.json({
    inserted,
    skipped,
    total: events.length,
    errors
  });
});

module.exports = router;
