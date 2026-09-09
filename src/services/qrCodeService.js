const QRCode = require("qrcode");

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeLabel(value, fallback = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

function clampLabel(value, maxLength) {
  const normalized = normalizeLabel(value);
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

async function generateStudentQrSvgMarkup(student) {
  const payload = buildStudentQrPayload(student);
  const qrSize = 420;
  const qrSvg = await QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: "H",
    margin: 2,
    width: qrSize
  });

  const qrInner = qrSvg
    .replace(/<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>\s*/i, "")
    .replace(/<svg[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");

  const width = qrSize;
  const height = 500;
  const displayName = clampLabel(student.name || student.full_name || "Student", 26);
  const className = clampLabel(student.class_name || "Class", 20);
  const centerX = width / 2;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    '<g shape-rendering="crispEdges">',
    qrInner,
    '</g>',
    `<text x="${centerX}" y="452" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" fill="#111111">${escapeXml(displayName)}</text>`,
    `<text x="${centerX}" y="482" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="500" fill="#111111">(${escapeXml(className)})</text>`,
    "</svg>"
  ].join("");
}

function buildStudentQrPayload(student) {
  return JSON.stringify({
    type: "student",
    student_pk: Number(student.id || 0),
    student_id: String(student.student_id || "").trim(),
    qr_token: String(student.qr_token || "").trim(),
    no_sb: String(student.no_sb || "").trim(),
    full_name: String(student.full_name || "").trim(),
    class_name: String(student.class_name || "").trim()
  });
}

function buildDeviceQrPayload(device) {
  return JSON.stringify({
    type: "device",
    device_id: Number(device.id || 0),
    code: String(device.code || "").trim(),
    name: String(device.name || "").trim()
  });
}

function buildInventoryQrPayload(item) {
  return JSON.stringify({
    type: "inventory",
    inventory_id: Number(item.id || 0),
    token: String(item.token || "").trim(),
    code: String(item.code || "").trim(),
    name: String(item.name || "").trim(),
    category: String(item.category || "").trim(),
    location: String(item.location || "").trim(),
    status: String(item.status || "").trim(),
    condition: String(item.item_condition || "").trim()
  });
}

function parseStudentQrPayload(raw) {
  const parsed = JSON.parse(String(raw || "").trim());
  if (!parsed || parsed.type !== "student") {
    throw new Error("QR code is not a student QR code");
  }
  return {
    student_pk: Number(parsed.student_pk || 0),
    student_id: String(parsed.student_id || "").trim(),
    qr_token: String(parsed.qr_token || "").trim()
  };
}

function parseDeviceQrPayload(raw) {
  const parsed = JSON.parse(String(raw || "").trim());
  if (!parsed || parsed.type !== "device") {
    throw new Error("QR code is not a device QR code");
  }
  return {
    device_id: Number(parsed.device_id || 0),
    code: String(parsed.code || "").trim()
  };
}

async function generateStudentQrDataUrl(student) {
  return QRCode.toDataURL(buildStudentQrPayload(student), {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280
  });
}

async function generateDeviceQrDataUrl(device) {
  return QRCode.toDataURL(buildDeviceQrPayload(device), {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280
  });
}

async function generateInventoryQrDataUrl(item) {
  return QRCode.toDataURL(item.qr_url || buildInventoryQrPayload(item), {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280
  });
}

function buildUserQrPayload(user) {
  return JSON.stringify({
    type: "user",
    user_id: Number(user.id || 0),
    username: String(user.username || "").trim(),
    display_name: String(user.display_name || "").trim(),
    role: String(user.role || "").trim(),
    user_type: String(user.user_type || "").trim(),
    email: String(user.email || "").trim()
  });
}

async function generateUserQrDataUrl(user) {
  return QRCode.toDataURL(buildUserQrPayload(user), {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280
  });
}

module.exports = {
  buildDeviceQrPayload,
  buildInventoryQrPayload,
  buildStudentQrPayload,
  buildUserQrPayload,
  generateDeviceQrDataUrl,
  generateInventoryQrDataUrl,
  generateStudentQrDataUrl,
  generateUserQrDataUrl,
  parseDeviceQrPayload,
  parseStudentQrPayload
};
