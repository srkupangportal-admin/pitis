const express = require("express");
const dayjs = require("dayjs");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { db } = require("../db/init");
const { requireRole } = require("../middleware/auth");
const { generateDeviceQrDataUrl, parseDeviceQrPayload } = require("../services/qrCodeService");

const router = express.Router();
const deviceUserRoles = ["teacher", "staff", "admin"];
const deviceStatuses = ["available", "maintenance", "unavailable", "inactive"];
const bookingStatuses = ["booked", "in_use", "completed", "cancelled"];
const DEVICE_UPLOAD_DIR = path.join(__dirname, "..", "..", "public", "uploads", "devices");

if (!fs.existsSync(DEVICE_UPLOAD_DIR)) {
  fs.mkdirSync(DEVICE_UPLOAD_DIR, { recursive: true });
}

const devicePhotoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DEVICE_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeId = String(req.params.id || req.body.code || req.body.name || "device").replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${safeId}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const devicePhotoUpload = multer({
  storage: devicePhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image files are allowed"));
  }
});

function encodeMessage(message) {
  return encodeURIComponent(message || "");
}

function normalizeDevicePhotoPath(file) {
  if (!file) return "";
  const rel = path.join("uploads", "devices", file.filename).replace(/\\/g, "/");
  return `/${rel}`;
}

function removeManagedDevicePhotoIfExists(photoPath) {
  const rel = String(photoPath || "").trim();
  if (!rel || !rel.startsWith("/uploads/devices/")) return;
  const abs = path.join(__dirname, "..", "..", "public", rel.replace(/^\//, ""));
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (_) {}
  }
}

function getReturnPath(req, fallback) {
  const raw = String(req.body.return_to || req.query.return_to || "").trim();
  return raw.startsWith("/") ? raw : fallback;
}

function redirectWithMessage(res, returnPath, key, message) {
  const separator = String(returnPath || "").includes("?") ? "&" : "?";
  return res.redirect(`${returnPath}${separator}${key}=${encodeMessage(message)}`);
}

function normalizeDate(value, fallback = dayjs().format("YYYY-MM-DD")) {
  const parsed = dayjs(String(value || "").trim());
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : fallback;
}

function normalizeMonth(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(raw) ? raw : dayjs().format("YYYY-MM");
}

function normalizeTime(value) {
  const raw = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(raw) ? raw : "";
}

function normalizeDateTimeLocal(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.format("YYYY-MM-DDTHH:mm") : "";
}

function buildDateTimeValue(dateValue, timeValue, combinedValue) {
  const combined = String(combinedValue || "").trim();
  if (combined) return combined;
  const date = normalizeDate(dateValue, "");
  const time = normalizeTime(timeValue);
  if (!date || !time) return "";
  return `${date}T${time}`;
}

function toSqlDateTime(value) {
  const parsed = dayjs(String(value || "").trim());
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm:ss") : "";
}

function toDateTime(dateValue, timeValue) {
  const date = normalizeDate(dateValue, "");
  const time = normalizeTime(timeValue);
  if (!date || !time) return null;
  const parsed = dayjs(`${date}T${time}`);
  return parsed.isValid() ? parsed : null;
}

function getBookingWithRelations(bookingId) {
  return db
    .prepare(
      `SELECT b.*, d.name AS device_name, d.code AS device_code, d.status AS device_base_status,
              u.display_name AS user_display_name
       FROM device_bookings b
       JOIN devices d ON d.id = b.device_id
       JOIN users u ON u.id = b.user_id
       WHERE b.id = ?`
    )
    .get(bookingId);
}

function getActiveDeviceBorrow(deviceId) {
  return db
    .prepare(
      `SELECT b.*, d.name AS device_name, d.code AS device_code, u.display_name AS user_display_name
       FROM device_bookings b
       JOIN devices d ON d.id = b.device_id
       JOIN users u ON u.id = b.user_id
       WHERE b.device_id = ?
         AND b.status = 'in_use'
       ORDER BY b.actual_start_time DESC, b.id DESC
       LIMIT 1`
    )
    .get(deviceId);
}

function userCanManageBooking(user, booking) {
  if (!user || !booking) return false;
  return user.role === "admin" || Number(booking.user_id) === Number(user.id);
}

function getDerivedDeviceStatus(device) {
  if (device.status !== "available") return device.status;
  if (Number(device.has_in_use) > 0) return "in_use";
  if (Number(device.has_booked) > 0) return "booked";
  return "available";
}

function getDeviceListForUser() {
  const today = dayjs().format("YYYY-MM-DD");
  const nowTime = dayjs().format("HH:mm");
  return db
    .prepare(
      `SELECT d.*,
              inv.id AS inventory_id,
              inv.name AS inventory_name,
              inv.code AS inventory_code,
              inv.category AS inventory_category,
              inv.location AS inventory_location,
              inv.status AS inventory_status,
              inv.notes AS inventory_notes,
              EXISTS(
                SELECT 1
                FROM device_bookings b
                WHERE b.device_id = d.id
                  AND b.status = 'in_use'
              ) AS has_in_use,
              EXISTS(
                SELECT 1
                FROM device_bookings b
                WHERE b.device_id = d.id
                  AND b.status = 'booked'
                  AND (b.booking_date > ? OR (b.booking_date = ? AND b.planned_end_time >= ?))
              ) AS has_booked
       FROM devices d
       JOIN school_inventory inv ON inv.linked_device_id = d.id
       WHERE inv.status = 'available'
         AND COALESCE(inv.is_bookable, 0) = 1
         AND d.status <> 'inactive'
       ORDER BY LOWER(inv.category) ASC, LOWER(inv.name) ASC`
    )
    .all(today, today, nowTime)
    .map((row) => ({
      ...row,
      name: row.inventory_name || row.name,
      code: row.inventory_code || row.code,
      category: row.inventory_category || row.category,
      location: row.inventory_location || row.location,
      status: deviceStatuses.includes(row.inventory_status) ? row.inventory_status : row.status,
      notes: row.inventory_notes || row.notes,
      derived_status: getDerivedDeviceStatus({
        ...row,
        status: deviceStatuses.includes(row.inventory_status) ? row.inventory_status : row.status
      })
    }));
}

function getDeviceListForAdmin() {
  const today = dayjs().format("YYYY-MM-DD");
  const nowTime = dayjs().format("HH:mm");
  return db
    .prepare(
      `SELECT d.*,
              inv.id AS inventory_id,
              inv.name AS inventory_name,
              inv.code AS inventory_code,
              inv.category AS inventory_category,
              inv.location AS inventory_location,
              inv.status AS inventory_status,
              inv.is_bookable AS inventory_is_bookable,
              inv.notes AS inventory_notes,
              EXISTS(
                SELECT 1
                FROM device_bookings b
                WHERE b.device_id = d.id
                  AND b.status = 'in_use'
              ) AS has_in_use,
              EXISTS(
                SELECT 1
                FROM device_bookings b
                WHERE b.device_id = d.id
                  AND b.status = 'booked'
                  AND (b.booking_date > ? OR (b.booking_date = ? AND b.planned_end_time >= ?))
              ) AS has_booked
       FROM devices d
       JOIN school_inventory inv ON inv.linked_device_id = d.id
       ORDER BY LOWER(inv.category) ASC, LOWER(inv.name) ASC`
    )
    .all(today, today, nowTime)
    .map((row) => ({
      ...row,
      name: row.inventory_name || row.name,
      code: row.inventory_code || row.code,
      category: row.inventory_category || row.category,
      location: row.inventory_location || row.location,
      status: deviceStatuses.includes(row.inventory_status) ? row.inventory_status : row.status,
      notes: row.inventory_notes || row.notes,
      derived_status: getDerivedDeviceStatus({
        ...row,
        status: deviceStatuses.includes(row.inventory_status) ? row.inventory_status : row.status
      })
    }));
}

function getBookableDevices() {
  return db
    .prepare(
      `SELECT d.id,
              COALESCE(inv.name, d.name) AS name,
              COALESCE(inv.code, d.code) AS code,
              inv.category,
              inv.location,
              inv.id AS inventory_id
       FROM school_inventory inv
       JOIN devices d ON d.id = inv.linked_device_id
       WHERE inv.status = 'available'
         AND COALESCE(inv.is_bookable, 0) = 1
         AND d.status = 'available'
       ORDER BY LOWER(inv.category) ASC, LOWER(inv.name) ASC`
    )
    .all();
}

function getClassOptions() {
  return db.prepare("SELECT id, name FROM classes ORDER BY name ASC").all();
}

function getInventoryOptionRows(table, activeOnly = true) {
  return db
    .prepare(
      `SELECT id, name, is_active, created_at, updated_at
       FROM ${table}
       ${activeOnly ? "WHERE is_active = 1" : ""}
       ORDER BY is_active DESC, LOWER(name) ASC`
    )
    .all();
}

function getInventoryCategoryOptions(activeOnly = true) {
  return getInventoryOptionRows("inventory_categories", activeOnly);
}

function getInventoryLocationOptions(activeOnly = true) {
  return getInventoryOptionRows("inventory_locations", activeOnly);
}

function getInventoryAvailabilityOptions(activeOnly = true) {
  const options = getInventoryOptionRows("inventory_availability_options", activeOnly)
    .filter((option) => deviceStatuses.includes(option.name));
  if (activeOnly && !options.length) {
    return deviceStatuses.map((name, index) => ({ id: index + 1, name, is_active: 1 }));
  }
  return options;
}

function inventoryOptionExists(table, name, activeOnly = true) {
  const value = String(name || "").trim();
  if (!value) return false;
  const activeClause = activeOnly ? "AND is_active = 1" : "";
  return Boolean(db.prepare(`SELECT id FROM ${table} WHERE name = ? ${activeClause}`).get(value));
}

function getLocationOptions() {
  return getInventoryLocationOptions(true);
}

function getVenueOptions() {
  return getInventoryLocationOptions(true);
}

function getAllVenueOptions() {
  return getInventoryLocationOptions(false);
}

function getAllLocationOptions() {
  return getInventoryLocationOptions(false);
}

function getMyBookings(userId) {
  return db
    .prepare(
      `SELECT b.*, d.name AS device_name, d.code AS device_code, d.category AS device_category, d.location AS device_location
       FROM device_bookings b
       JOIN devices d ON d.id = b.device_id
       WHERE b.user_id = ?
       ORDER BY b.booking_date DESC, b.planned_start_time DESC, b.created_at DESC`
    )
    .all(userId);
}

function getUpcomingBookings(limit = 12) {
  return db
    .prepare(
      `SELECT b.*, d.name AS device_name, d.code AS device_code, u.display_name AS user_display_name
       FROM device_bookings b
       JOIN devices d ON d.id = b.device_id
       JOIN users u ON u.id = b.user_id
       WHERE b.status IN ('booked', 'in_use')
       ORDER BY b.booking_date ASC, b.planned_start_time ASC, b.created_at ASC
       LIMIT ?`
    )
    .all(limit);
}

function hasOverlappingBooking(deviceId, bookingDate, plannedStartTime, plannedEndTime, excludeBookingId = null) {
  const params = [deviceId, bookingDate, plannedEndTime, plannedStartTime];
  let sql = `
    SELECT id
    FROM device_bookings
    WHERE device_id = ?
      AND booking_date = ?
      AND status IN ('booked', 'in_use')
      AND planned_start_time < ?
      AND planned_end_time > ?
  `;

  if (excludeBookingId) {
    sql += " AND id <> ?";
    params.push(excludeBookingId);
  }

  return !!db.prepare(sql).get(...params);
}

function getLogsViewData(filters) {
  const where = [];
  const params = [];

  if (filters.date) {
    where.push("b.booking_date = ?");
    params.push(filters.date);
  }
  if (filters.deviceId) {
    where.push("b.device_id = ?");
    params.push(filters.deviceId);
  }
  if (filters.userId) {
    where.push("b.user_id = ?");
    params.push(filters.userId);
  }
  if (filters.className) {
    where.push("LOWER(b.class_name) LIKE ?");
    params.push(`%${String(filters.className).trim().toLowerCase()}%`);
  }
  if (filters.subject) {
    where.push("LOWER(b.subject) LIKE ?");
    params.push(`%${String(filters.subject).trim().toLowerCase()}%`);
  }
  if (filters.status) {
    where.push("b.status = ?");
    params.push(filters.status);
  }

  const sql = `
    SELECT b.*, d.name AS device_name, d.code AS device_code, d.category AS device_category,
           u.display_name AS user_display_name, u.username
    FROM device_bookings b
    JOIN devices d ON d.id = b.device_id
    JOIN users u ON u.id = b.user_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY b.booking_date DESC, b.planned_start_time DESC, b.created_at DESC
  `;

  return {
    rows: db.prepare(sql).all(...params),
    devices: db.prepare("SELECT id, name, code FROM devices ORDER BY LOWER(name) ASC").all(),
    users: db.prepare("SELECT id, display_name, username FROM users ORDER BY LOWER(display_name) ASC").all()
  };
}

function escapeExcelValue(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getLogFilters(query) {
  return {
    date: query.date ? normalizeDate(query.date, "") : "",
    deviceId: Number(query.device_id || 0),
    userId: Number(query.user_id || 0),
    className: String(query.class_name || "").trim(),
    subject: String(query.subject || "").trim(),
    status: bookingStatuses.includes(String(query.status || "").trim()) ? String(query.status || "").trim() : ""
  };
}

function getReportsViewData(monthValue) {
  const month = normalizeMonth(monthValue);
  const monthStart = `${month}-01`;
  const monthEnd = dayjs(monthStart).endOf("month").format("YYYY-MM-DD");

  const summary = db
    .prepare(
      `SELECT
          COUNT(*) AS total_bookings,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_usages
       FROM device_bookings
       WHERE booking_date BETWEEN ? AND ?`
    )
    .get(monthStart, monthEnd);

  const mostUsedDevice = db
    .prepare(
      `SELECT d.name, d.code, COUNT(*) AS total
       FROM device_bookings b
       JOIN devices d ON d.id = b.device_id
       WHERE b.booking_date BETWEEN ? AND ?
         AND b.status = 'completed'
       GROUP BY d.id
       ORDER BY total DESC, LOWER(d.name) ASC
       LIMIT 1`
    )
    .get(monthStart, monthEnd);

  const mostActiveUser = db
    .prepare(
      `SELECT u.display_name, u.username, COUNT(*) AS total
       FROM device_bookings b
       JOIN users u ON u.id = b.user_id
       WHERE b.booking_date BETWEEN ? AND ?
         AND b.status = 'completed'
       GROUP BY u.id
       ORDER BY total DESC, LOWER(u.display_name) ASC
       LIMIT 1`
    )
    .get(monthStart, monthEnd);

  const usageByCategory = db
    .prepare(
      `SELECT d.category, COUNT(*) AS total_bookings,
              SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) AS completed_usages
       FROM device_bookings b
       JOIN devices d ON d.id = b.device_id
       WHERE b.booking_date BETWEEN ? AND ?
       GROUP BY d.category
       ORDER BY completed_usages DESC, total_bookings DESC, LOWER(d.category) ASC`
    )
    .all(monthStart, monthEnd);

  const usageByClass = db
    .prepare(
      `SELECT b.class_name, COUNT(*) AS total_bookings,
              SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) AS completed_usages
       FROM device_bookings b
       WHERE b.booking_date BETWEEN ? AND ?
       GROUP BY b.class_name
       ORDER BY completed_usages DESC, total_bookings DESC, LOWER(b.class_name) ASC`
    )
    .all(monthStart, monthEnd);

  const usageBySubject = db
    .prepare(
      `SELECT b.subject, COUNT(*) AS total_bookings,
              SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) AS completed_usages
       FROM device_bookings b
       WHERE b.booking_date BETWEEN ? AND ?
       GROUP BY b.subject
       ORDER BY completed_usages DESC, total_bookings DESC, LOWER(b.subject) ASC`
    )
    .all(monthStart, monthEnd);

  return {
    month,
    monthStart,
    monthEnd,
    summary: {
      totalBookings: Number(summary.total_bookings || 0),
      completedUsages: Number(summary.completed_usages || 0),
      mostUsedDevice: mostUsedDevice ? `${mostUsedDevice.name} (${mostUsedDevice.total})` : "No completed usage yet",
      mostActiveUser: mostActiveUser ? `${mostActiveUser.display_name} (${mostActiveUser.total})` : "No completed usage yet"
    },
    usageByCategory,
    usageByClass,
    usageBySubject
  };
}

router.get("/devices", requireRole(deviceUserRoles), (req, res) => {
  const bookingDate = normalizeDate(req.query.booking_date);
  res.render("devices", {
    devices: getDeviceListForUser(),
    bookableDevices: getBookableDevices(),
    classOptions: getClassOptions(),
    locationOptions: getLocationOptions(),
    venueOptions: getVenueOptions(),
    myRecentBookings: getMyBookings(req.session.user.id).slice(0, 8),
    upcomingBookings: getUpcomingBookings(10),
    bookingForm: {
      device_id: String(req.query.device_id || ""),
      booking_date: bookingDate,
      planned_start_time: String(req.query.planned_start_time || ""),
      planned_end_time: String(req.query.planned_end_time || ""),
      class_name: "",
      subject: "",
      lesson_topic: "",
      venue: "",
      purpose: "",
      remarks: ""
    },
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.get("/devices/bookings", requireRole(deviceUserRoles), (req, res) => {
  return res.redirect(`/devices?booking_date=${encodeMessage(req.query.booking_date || "")}`);
});

router.post("/devices/bookings", requireRole(deviceUserRoles), (req, res) => {
  const deviceId = Number(req.body.device_id || 0);
  const bookingDate = normalizeDate(req.body.booking_date, "");
  const plannedStartTime = normalizeTime(req.body.planned_start_time);
  const plannedEndTime = normalizeTime(req.body.planned_end_time);
  const className = String(req.body.class_name || "").trim();
  const subject = String(req.body.subject || "").trim();
  const lessonTopic = String(req.body.lesson_topic || "").trim();
  const venue = String(req.body.venue || "").trim();
  const purpose = String(req.body.purpose || "").trim();
  const remarks = String(req.body.remarks || "").trim();
  const bookingStart = toDateTime(bookingDate, plannedStartTime);
  const bookingEnd = toDateTime(bookingDate, plannedEndTime);

  if (!deviceId || !bookingDate || !plannedStartTime || !plannedEndTime || !className || !subject || !lessonTopic || !venue || !purpose) {
    return res.redirect(`/devices?error=${encodeMessage("Please complete all required booking fields")}`);
  }

  if (!inventoryOptionExists("inventory_locations", venue)) {
    return res.redirect(`/devices?error=${encodeMessage("Please choose a valid inventory location for the venue")}`);
  }

  if (!bookingStart || !bookingEnd || !bookingEnd.isAfter(bookingStart)) {
    return res.redirect(`/devices?error=${encodeMessage("Planned end time must be after planned start time")}`);
  }

  const device = db.prepare(`
    SELECT d.*,
           inv.id AS inventory_id,
           inv.name AS inventory_name,
           inv.code AS inventory_code,
           inv.category AS inventory_category,
           inv.location AS inventory_location,
           inv.status AS inventory_status
    FROM devices d
    JOIN school_inventory inv ON inv.linked_device_id = d.id
    WHERE d.id = ?
      AND inv.status = 'available'
      AND COALESCE(inv.is_bookable, 0) = 1
    LIMIT 1
  `).get(deviceId);
  if (!device) {
    return res.redirect(`/devices?error=${encodeMessage("Selected inventory-linked device was not found or is not available")}`);
  }

  if (device.status !== "available") {
    return res.redirect(`/devices?error=${encodeMessage("This device is not available for booking right now")}`);
  }

  if (hasOverlappingBooking(deviceId, bookingDate, plannedStartTime, plannedEndTime)) {
    return res.redirect(`/devices?error=${encodeMessage("This device already has an overlapping booking for that lesson time")}`);
  }

  const now = dayjs().toISOString();
  db.prepare(
    `INSERT INTO device_bookings
     (device_id, user_id, booking_date, planned_start_time, planned_end_time, actual_start_time, actual_end_time,
      took_from_hub_at, returned_to_hub_at, class_name, subject, lesson_topic, venue, purpose, remarks, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`
  ).run(deviceId, req.session.user.id, bookingDate, plannedStartTime, plannedEndTime, className, subject, lessonTopic, venue, purpose, remarks || null, now, now);

  return res.redirect(`/devices/my-bookings?success=${encodeMessage("Device booking created successfully")}`);
});

router.get("/devices/my-bookings", requireRole(deviceUserRoles), (req, res) => {
  res.render("device-my-bookings", {
    bookings: getMyBookings(req.session.user.id),
    currentUser: req.session.user,
    error: req.query.error || "",
    success: req.query.success || "",
    formatDateTimeLocal: normalizeDateTimeLocal
  });
});

router.post("/devices/bookings/:id/start", requireRole(deviceUserRoles), (req, res) => {
  const returnPath = getReturnPath(req, "/devices/my-bookings");
  const bookingId = Number(req.params.id || 0);
  const booking = getBookingWithRelations(bookingId);
  if (!booking) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Booking not found")}`);
  }
  if (!userCanManageBooking(req.session.user, booking)) {
    return res.status(403).send("Forbidden");
  }
  if (booking.status !== "booked" && booking.status !== "in_use") {
    return res.redirect(`${returnPath}?error=${encodeMessage("Only booked devices can be started")}`);
  }

  const actualStartValue = buildDateTimeValue(req.body.actual_start_date, req.body.actual_start_time, req.body.actual_start_at);
  const tookFromHubValue = buildDateTimeValue(req.body.took_from_hub_date, req.body.took_from_hub_time, req.body.took_from_hub_at);
  const actualStart = actualStartValue ? toSqlDateTime(actualStartValue) : dayjs().format("YYYY-MM-DD HH:mm:ss");
  const tookFromHubAt = tookFromHubValue ? toSqlDateTime(tookFromHubValue) : actualStart;

  if (!actualStart || !tookFromHubAt) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Please provide a valid usage start time")}`);
  }
  if (dayjs(actualStart).isBefore(dayjs(tookFromHubAt))) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Actual usage cannot start before the device was taken from the hub")}`);
  }

  db.prepare(
    `UPDATE device_bookings
     SET actual_start_time = COALESCE(actual_start_time, ?),
         took_from_hub_at = COALESCE(took_from_hub_at, ?),
         status = 'in_use',
         updated_at = ?
     WHERE id = ?`
  ).run(actualStart, tookFromHubAt, dayjs().toISOString(), bookingId);

  return res.redirect(`${returnPath}?success=${encodeMessage("Usage started and hub pickup time recorded")}`);
});

router.post("/devices/bookings/:id/end", requireRole(deviceUserRoles), (req, res) => {
  const returnPath = getReturnPath(req, "/devices/my-bookings");
  const bookingId = Number(req.params.id || 0);
  const booking = getBookingWithRelations(bookingId);
  if (!booking) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Booking not found")}`);
  }
  if (!userCanManageBooking(req.session.user, booking)) {
    return res.status(403).send("Forbidden");
  }
  if (booking.status !== "in_use") {
    return res.redirect(`${returnPath}?error=${encodeMessage("Only bookings currently in use can be completed")}`);
  }
  if (!booking.actual_start_time) {
    return res.redirect(`${returnPath}?error=${encodeMessage("This booking does not have a recorded start time yet")}`);
  }

  const actualEndValue = buildDateTimeValue(req.body.actual_end_date, req.body.actual_end_time, req.body.actual_end_at);
  const returnedValue = buildDateTimeValue(req.body.returned_to_hub_date, req.body.returned_to_hub_time, req.body.returned_to_hub_at);
  const actualEnd = actualEndValue ? toSqlDateTime(actualEndValue) : dayjs().format("YYYY-MM-DD HH:mm:ss");
  const returnedToHubAt = returnedValue ? toSqlDateTime(returnedValue) : actualEnd;

  if (!actualEnd || !returnedToHubAt) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Please provide a valid usage end time")}`);
  }
  if (dayjs(actualEnd).isBefore(dayjs(booking.actual_start_time))) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Actual usage end time cannot be before the recorded start time")}`);
  }
  if (dayjs(returnedToHubAt).isBefore(dayjs(actualEnd))) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Hub return time cannot be earlier than the usage end time")}`);
  }

  db.prepare(
    `UPDATE device_bookings
     SET actual_end_time = ?,
         returned_to_hub_at = ?,
         status = 'completed',
         updated_at = ?
     WHERE id = ?`
  ).run(actualEnd, returnedToHubAt, dayjs().toISOString(), bookingId);

  return res.redirect(`${returnPath}?success=${encodeMessage("Usage completed and hub return time recorded")}`);
});

router.post("/devices/bookings/:id/cancel", requireRole(deviceUserRoles), (req, res) => {
  const returnPath = getReturnPath(req, "/devices/my-bookings");
  const bookingId = Number(req.params.id || 0);
  const booking = getBookingWithRelations(bookingId);
  if (!booking) {
    return res.redirect(`${returnPath}?error=${encodeMessage("Booking not found")}`);
  }
  if (!userCanManageBooking(req.session.user, booking)) {
    return res.status(403).send("Forbidden");
  }
  if (booking.status !== "booked") {
    return res.redirect(`${returnPath}?error=${encodeMessage("Only future booked records can be cancelled")}`);
  }

  const plannedStart = toDateTime(booking.booking_date, booking.planned_start_time);
  if (req.session.user.role !== "admin" && plannedStart && !plannedStart.isAfter(dayjs())) {
    return res.redirect(`${returnPath}?error=${encodeMessage("You can only cancel your own future bookings")}`);
  }

  db.prepare(
    `UPDATE device_bookings
     SET status = 'cancelled',
         updated_at = ?
     WHERE id = ?`
  ).run(dayjs().toISOString(), bookingId);

  return res.redirect(`${returnPath}?success=${encodeMessage("Booking cancelled")}`);
});

router.get("/devices/logs", requireRole("admin"), (req, res) => {
  const filters = getLogFilters(req.query);
  const data = getLogsViewData(filters);
  res.render("device-logs", {
    rows: data.rows,
    devices: data.devices,
    users: data.users,
    filters,
    error: req.query.error || "",
    success: req.query.success || "",
    bookingStatuses
  });
});

router.get("/devices/logs/export", requireRole("admin"), (req, res) => {
  const filters = getLogFilters(req.query);
  const data = getLogsViewData(filters);
  const rowsHtml = data.rows.map((row) => {
    const cells = [
      row.id,
      row.booking_date,
      row.planned_start_time,
      row.planned_end_time,
      row.actual_start_time || "",
      row.actual_end_time || "",
      row.took_from_hub_at || "",
      row.returned_to_hub_at || "",
      row.status,
      row.device_name,
      row.device_code,
      row.device_category,
      row.user_display_name,
      row.username,
      row.class_name,
      row.subject,
      row.lesson_topic,
      row.venue,
      row.purpose,
      row.remarks || "",
      row.created_at,
      row.updated_at
    ].map((value) => `<td>${escapeExcelValue(value)}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  const filterSummary = [
    filters.date ? `Date: ${filters.date}` : "",
    filters.deviceId ? `Device ID: ${filters.deviceId}` : "",
    filters.userId ? `User ID: ${filters.userId}` : "",
    filters.className ? `Class: ${filters.className}` : "",
    filters.subject ? `Subject: ${filters.subject}` : "",
    filters.status ? `Status: ${filters.status}` : ""
  ].filter(Boolean).join(" | ");

  const workbook = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 6px; vertical-align: top; }
    th { background: #d9e8fb; font-weight: 700; }
    .meta { margin-bottom: 12px; font-family: Arial, sans-serif; }
  </style>
</head>
<body>
  <div class="meta">
    <h2>Device Log Export</h2>
    <div>Exported At: ${escapeExcelValue(dayjs().format("YYYY-MM-DD HH:mm:ss"))}</div>
    <div>Filters: ${escapeExcelValue(filterSummary || "None")}</div>
    <div>Total Rows: ${escapeExcelValue(data.rows.length)}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Booking ID</th>
        <th>Booking Date</th>
        <th>Planned Start Time</th>
        <th>Planned End Time</th>
        <th>Actual Start Time</th>
        <th>Actual End Time</th>
        <th>Taken From Hub At</th>
        <th>Returned To Hub At</th>
        <th>Status</th>
        <th>Device Name</th>
        <th>Device Code</th>
        <th>Device Category</th>
        <th>User</th>
        <th>Username</th>
        <th>Class Name</th>
        <th>Subject</th>
        <th>Lesson Topic</th>
        <th>Venue</th>
        <th>Purpose</th>
        <th>Remarks</th>
        <th>Created At</th>
        <th>Updated At</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;

  const filename = `device-logs-${dayjs().format("YYYYMMDD-HHmmss")}.xls`;
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=UTF-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(workbook);
});

router.get("/devices/reports", requireRole("admin"), (req, res) => {
  const report = getReportsViewData(req.query.month);
  res.render("device-reports", {
    report,
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.get("/devices/qr", requireRole(deviceUserRoles), (req, res) => {
  res.render("device-qr-scan", {
    user: req.session.user,
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.post("/devices/qr/process", requireRole(deviceUserRoles), (req, res) => {
  try {
    const qrText = String(req.body.qr_text || "").trim();
    if (!qrText) {
      return res.status(400).json({ success: false, error: "QR text is required" });
    }

    const parsed = parseDeviceQrPayload(qrText);
    const device = db
      .prepare(`
        SELECT d.*,
               inv.id AS inventory_id,
               inv.name AS inventory_name,
               inv.code AS inventory_code,
               inv.status AS inventory_status,
               inv.is_bookable AS inventory_is_bookable,
               inv.location AS inventory_location
        FROM devices d
        LEFT JOIN school_inventory inv ON inv.linked_device_id = d.id
        WHERE d.id = ? AND d.code = ?
      `)
      .get(parsed.device_id, parsed.code);

    if (!device) {
      return res.status(404).json({ success: false, error: "Device QR code was not found" });
    }

    const activeBorrow = getActiveDeviceBorrow(device.id);
    const now = dayjs();
    const nowSql = now.format("YYYY-MM-DD HH:mm:ss");
    const nowIso = now.toISOString();

    if (activeBorrow) {
      if (Number(activeBorrow.user_id) !== Number(req.session.user.id)) {
        return res.status(409).json({
          success: false,
          error: `${device.name} must be returned by ${activeBorrow.user_display_name} before another user can borrow it`,
          deviceName: device.name,
          action: "blocked"
        });
      }

      db.prepare(
        `UPDATE device_bookings
         SET actual_end_time = ?,
             returned_to_hub_at = ?,
             status = 'completed',
             updated_at = ?
         WHERE id = ?`
      ).run(nowSql, nowSql, nowIso, activeBorrow.id);

      return res.json({
        success: true,
        action: "returned",
        deviceName: device.name,
        deviceCode: device.code,
        scanTime: now.format("HH:mm:ss"),
        message: `${device.name} returned`
      });
    }

    if (!device.inventory_id) {
      return res.status(409).json({ success: false, error: "This device is not linked to an available inventory item" });
    }
    if (Number(device.inventory_is_bookable || 0) !== 1) {
      return res.status(409).json({ success: false, error: "This inventory item is not available for Device Booking" });
    }
    if (device.status !== "available") {
      return res.status(409).json({ success: false, error: `Device is ${String(device.status).replace(/_/g, " ")}` });
    }
    if (device.inventory_status !== "available") {
      return res.status(409).json({ success: false, error: `Inventory item is ${String(device.inventory_status || "unavailable").replace(/_/g, " ")}` });
    }

    db.prepare(
      `INSERT INTO device_bookings
       (device_id, user_id, booking_date, planned_start_time, planned_end_time, actual_start_time, actual_end_time,
        took_from_hub_at, returned_to_hub_at, class_name, subject, lesson_topic, venue, purpose, remarks, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, 'in_use', ?, ?)`
    ).run(
      device.id,
      req.session.user.id,
      now.format("YYYY-MM-DD"),
      now.format("HH:mm"),
      "23:59",
      nowSql,
      nowSql,
      "Device QR",
      "Device Borrow",
      "QR scan borrow",
      device.inventory_location || device.location || "Device Hub",
      "Auto logged by Device QR scan",
      "Borrowed via Device QR scan",
      nowIso,
      nowIso
    );

    return res.json({
      success: true,
      action: "borrowed",
      deviceName: device.name,
      deviceCode: device.code,
      scanTime: now.format("HH:mm:ss"),
      message: `${device.name} borrowed`
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || "Unable to process device QR" });
  }
});

router.get("/admin/devices", requireRole("admin"), async (req, res) => {
  const devices = await Promise.all(getDeviceListForAdmin().map(async (device) => ({
    ...device,
    qr_code_image: await generateDeviceQrDataUrl(device)
  })));

  res.render("admin-devices", {
    devices,
    categoryOptions: getInventoryCategoryOptions(true),
    locationOptions: getLocationOptions(),
    availabilityOptions: getInventoryAvailabilityOptions(true),
    allLocationOptions: getAllLocationOptions(),
    venueOptions: getVenueOptions(),
    allVenueOptions: getAllVenueOptions(),
    upcomingBookings: getUpcomingBookings(12),
    deviceStatuses,
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.post("/admin/devices", requireRole("admin"), devicePhotoUpload.single("device_photo"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  if (req.file) removeManagedDevicePhotoIfExists(normalizeDevicePhotoPath(req.file));
  return redirectWithMessage(res, returnPath, "error", "Add booking devices from the School Inventory page");
  const name = String(req.body.name || "").trim();
  const code = String(req.body.code || "").trim().toUpperCase();
  const category = String(req.body.category || "").trim();
  const brand = String(req.body.brand || "").trim();
  const model = String(req.body.model || "").trim();
  const serialNumber = String(req.body.serial_number || "").trim();
  const location = String(req.body.location || "").trim();
  const status = deviceStatuses.includes(String(req.body.status || "").trim()) ? String(req.body.status || "").trim() : "";
  const notes = String(req.body.notes || "").trim();
  const photoPath = req.file ? normalizeDevicePhotoPath(req.file) : null;
  const photoUploadedAt = req.file ? dayjs().toISOString() : null;

  if (!name || !code || !category || !location || !status) {
    if (photoPath) removeManagedDevicePhotoIfExists(photoPath);
    return redirectWithMessage(res, returnPath, "error", "Please complete all required device fields");
  }
  if (!inventoryOptionExists("inventory_categories", category) || !inventoryOptionExists("inventory_locations", location) || !inventoryOptionExists("inventory_availability_options", status)) {
    if (photoPath) removeManagedDevicePhotoIfExists(photoPath);
    return redirectWithMessage(res, returnPath, "error", "Please choose valid inventory-linked device options");
  }
  if (db.prepare("SELECT id FROM devices WHERE code = ?").get(code)) {
    if (photoPath) removeManagedDevicePhotoIfExists(photoPath);
    return redirectWithMessage(res, returnPath, "error", "Device code must be unique");
  }

  const now = dayjs().toISOString();
  db.prepare(
    `INSERT INTO devices
     (name, code, category, brand, model, serial_number, photo_path, photo_uploaded_at, location, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, code, category, brand || null, model || null, serialNumber || null, photoPath, photoUploadedAt, location, status, notes || null, now, now);

  return redirectWithMessage(res, returnPath, "success", "Device added");
});

router.post("/admin/devices/:id/edit", requireRole("admin"), devicePhotoUpload.single("device_photo"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  if (req.file) removeManagedDevicePhotoIfExists(normalizeDevicePhotoPath(req.file));
  return redirectWithMessage(res, returnPath, "error", "Manage booking device details from the linked School Inventory item");
  const deviceId = Number(req.params.id || 0);
  const existing = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!existing) {
    if (req.file) removeManagedDevicePhotoIfExists(normalizeDevicePhotoPath(req.file));
    return redirectWithMessage(res, returnPath, "error", "Device not found");
  }

  const name = String(req.body.name || "").trim();
  const code = String(req.body.code || "").trim().toUpperCase();
  const category = String(req.body.category || "").trim();
  const brand = String(req.body.brand || "").trim();
  const model = String(req.body.model || "").trim();
  const serialNumber = String(req.body.serial_number || "").trim();
  const location = String(req.body.location || "").trim();
  const status = deviceStatuses.includes(String(req.body.status || "").trim()) ? String(req.body.status || "").trim() : "";
  const notes = String(req.body.notes || "").trim();
  const nextPhotoPath = req.file ? normalizeDevicePhotoPath(req.file) : existing.photo_path || null;
  const nextPhotoUploadedAt = req.file ? dayjs().toISOString() : existing.photo_uploaded_at || null;

  if (!name || !code || !category || !location || !status) {
    if (req.file) removeManagedDevicePhotoIfExists(nextPhotoPath);
    return redirectWithMessage(res, returnPath, "error", "Please complete all required device fields before saving");
  }
  if (!inventoryOptionExists("inventory_categories", category, false) || !inventoryOptionExists("inventory_locations", location, false) || !inventoryOptionExists("inventory_availability_options", status, false)) {
    if (req.file) removeManagedDevicePhotoIfExists(nextPhotoPath);
    return redirectWithMessage(res, returnPath, "error", "Please choose valid inventory-linked device options");
  }

  const duplicate = db.prepare("SELECT id FROM devices WHERE code = ? AND id <> ?").get(code, deviceId);
  if (duplicate) {
    if (req.file) removeManagedDevicePhotoIfExists(nextPhotoPath);
    return redirectWithMessage(res, returnPath, "error", "Device code must be unique");
  }

  db.prepare(
    `UPDATE devices
     SET name = ?, code = ?, category = ?, brand = ?, model = ?, serial_number = ?, photo_path = ?, photo_uploaded_at = ?, location = ?, status = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  ).run(name, code, category, brand || null, model || null, serialNumber || null, nextPhotoPath, nextPhotoUploadedAt, location, status, notes || null, dayjs().toISOString(), deviceId);

  if (req.file && existing.photo_path && existing.photo_path !== nextPhotoPath) {
    removeManagedDevicePhotoIfExists(existing.photo_path);
  }

  return redirectWithMessage(res, returnPath, "success", "Device updated");
});

function normalizeSelectedDeviceIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((id) => Number(id || 0)).filter((id) => id > 0))];
}

function permanentlyDeleteDevices(deviceIds) {
  if (!deviceIds.length) return { deleted: 0, photos: [] };
  const placeholders = deviceIds.map(() => "?").join(", ");
  const devices = db.prepare(`SELECT id, photo_path FROM devices WHERE id IN (${placeholders})`).all(...deviceIds);
  if (!devices.length) return { deleted: 0, photos: [] };

  const foundIds = devices.map((device) => Number(device.id));
  const foundPlaceholders = foundIds.map(() => "?").join(", ");
  const tx = db.transaction(() => {
    db.prepare(`UPDATE school_inventory SET linked_device_id = NULL, updated_at = ? WHERE linked_device_id IN (${foundPlaceholders})`).run(dayjs().toISOString(), ...foundIds);
    db.prepare(`DELETE FROM device_bookings WHERE device_id IN (${foundPlaceholders})`).run(...foundIds);
    db.prepare(`DELETE FROM devices WHERE id IN (${foundPlaceholders})`).run(...foundIds);
  });
  tx();
  return {
    deleted: foundIds.length,
    photos: devices.map((device) => device.photo_path).filter(Boolean)
  };
}

router.post("/admin/devices/bulk-delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  const deviceIds = normalizeSelectedDeviceIds(req.body.selected_device_ids);
  if (!deviceIds.length) {
    return redirectWithMessage(res, returnPath, "error", "Select at least one device to delete");
  }

  const result = permanentlyDeleteDevices(deviceIds);
  result.photos.forEach(removeManagedDevicePhotoIfExists);
  if (!result.deleted) {
    return redirectWithMessage(res, returnPath, "error", "Selected devices were not found");
  }
  return redirectWithMessage(res, returnPath, "success", `${result.deleted} device(s) permanently deleted from the database`);
});

router.post("/admin/devices/:id/delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  const deviceId = Number(req.params.id || 0);
  const deleteMode = String(req.body.delete_mode || "").trim();
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!device) {
    return redirectWithMessage(res, returnPath, "error", "Device not found");
  }

  if (deleteMode === "permanent") {
    const result = permanentlyDeleteDevices([deviceId]);
    result.photos.forEach(removeManagedDevicePhotoIfExists);
    return redirectWithMessage(res, returnPath, "success", "Device and its booking history were permanently deleted");
  }

  const activeOrFuture = db
    .prepare(
      `SELECT id
       FROM device_bookings
       WHERE device_id = ?
         AND status IN ('booked', 'in_use')
         AND (booking_date > ? OR (booking_date = ? AND planned_end_time >= ?))
       LIMIT 1`
    )
    .get(deviceId, dayjs().format("YYYY-MM-DD"), dayjs().format("YYYY-MM-DD"), dayjs().format("HH:mm"));

  if (activeOrFuture) {
    return redirectWithMessage(res, returnPath, "error", "Cannot delete a device that still has active or future bookings");
  }

  const hasLogs = db.prepare("SELECT COUNT(*) AS total FROM device_bookings WHERE device_id = ?").get(deviceId).total > 0;
  if (hasLogs) {
    const archivedNotes = [String(device.notes || "").trim(), "Archived after historical device usage logs were kept."]
      .filter(Boolean)
      .join(" ");
    db.prepare(
      `UPDATE devices
       SET status = 'inactive',
           notes = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(archivedNotes, dayjs().toISOString(), deviceId);
    return redirectWithMessage(res, returnPath, "success", "Device has historical logs, so it was archived as inactive instead of deleted");
  }

  db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
  return redirectWithMessage(res, returnPath, "success", "Device deleted");
});

router.post("/admin/device-locations", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  const name = String(req.body.name || "").trim();
  if (!name) {
    return redirectWithMessage(res, returnPath, "error", "Location name is required");
  }

  const existing = db.prepare("SELECT id FROM inventory_locations WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(name);
  if (existing) {
    db.prepare("UPDATE inventory_locations SET is_active = 1, updated_at = ? WHERE id = ?").run(dayjs().toISOString(), existing.id);
    return redirectWithMessage(res, returnPath, "success", "Location saved");
  }

  const now = dayjs().toISOString();
  db.prepare(
    `INSERT INTO inventory_locations (name, is_active, created_at, updated_at)
     VALUES (?, 1, ?, ?)`
  ).run(name, now, now);

  return redirectWithMessage(res, returnPath, "success", "Location saved");
});

router.post("/admin/device-locations/:id/delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  const locationId = Number(req.params.id || 0);
  const location = db.prepare("SELECT * FROM inventory_locations WHERE id = ?").get(locationId);
  if (!location) {
    return redirectWithMessage(res, returnPath, "error", "Location not found");
  }

  const usedByDevices = db.prepare("SELECT id FROM devices WHERE location = ? LIMIT 1").get(location.name);
  const usedByBookings = db.prepare("SELECT id FROM device_bookings WHERE venue = ? LIMIT 1").get(location.name);

  if (usedByDevices || usedByBookings) {
    db.prepare("UPDATE inventory_locations SET is_active = 0, updated_at = ? WHERE id = ?").run(dayjs().toISOString(), locationId);
    return redirectWithMessage(res, returnPath, "success", "Location has existing usage, so it was hidden instead of deleted");
  }

  db.prepare("DELETE FROM inventory_locations WHERE id = ?").run(locationId);
  return redirectWithMessage(res, returnPath, "success", "Location deleted");
});

router.post("/admin/device-venues", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  const name = String(req.body.name || "").trim();
  const venueId = Number(req.body.venue_id || 0);
  if (!name) {
    return redirectWithMessage(res, returnPath, "error", "Venue name is required");
  }

  if (venueId) {
    const existingVenue = db.prepare("SELECT * FROM inventory_locations WHERE id = ?").get(venueId);
    if (!existingVenue) {
      return redirectWithMessage(res, returnPath, "error", "Venue not found");
    }
    const duplicate = db.prepare("SELECT id FROM inventory_locations WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id <> ?").get(name, venueId);
    if (duplicate) {
      return redirectWithMessage(res, returnPath, "error", "Venue name already exists");
    }
    db.prepare("UPDATE inventory_locations SET name = ?, is_active = 1, updated_at = ? WHERE id = ?").run(name, dayjs().toISOString(), venueId);
    return redirectWithMessage(res, returnPath, "success", "Venue updated");
  }

  const existing = db.prepare("SELECT id FROM inventory_locations WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(name);
  if (existing) {
    db.prepare("UPDATE inventory_locations SET is_active = 1, updated_at = ? WHERE id = ?").run(dayjs().toISOString(), existing.id);
    return redirectWithMessage(res, returnPath, "success", "Venue saved");
  }

  const now = dayjs().toISOString();
  db.prepare(
    `INSERT INTO inventory_locations (name, is_active, created_at, updated_at)
     VALUES (?, 1, ?, ?)`
  ).run(name, now, now);

  return redirectWithMessage(res, returnPath, "success", "Venue saved");
});

router.post("/admin/device-venues/:id/delete", requireRole("admin"), (req, res) => {
  const returnPath = getReturnPath(req, "/admin/devices");
  const venueId = Number(req.params.id || 0);
  const venue = db.prepare("SELECT * FROM inventory_locations WHERE id = ?").get(venueId);
  if (!venue) {
    return redirectWithMessage(res, returnPath, "error", "Venue not found");
  }

  const usedByBookings = db.prepare("SELECT id FROM device_bookings WHERE venue = ? LIMIT 1").get(venue.name);
  if (usedByBookings) {
    db.prepare("UPDATE inventory_locations SET is_active = 0, updated_at = ? WHERE id = ?").run(dayjs().toISOString(), venueId);
    return redirectWithMessage(res, returnPath, "success", "Venue has existing booking history, so it was hidden instead of deleted");
  }

  db.prepare("DELETE FROM inventory_locations WHERE id = ?").run(venueId);
  return redirectWithMessage(res, returnPath, "success", "Venue deleted");
});

module.exports = router;
