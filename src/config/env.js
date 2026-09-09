const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
let loaded = false;

function loadEnvFile(envPath = path.join(projectRoot, ".env")) {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 0) return;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) return;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

function toBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function getServerConfig() {
  loadEnvFile();

  const httpsEnabled = toBool(process.env.HTTPS_ENABLED, true);
  return {
    host: process.env.HOST || "0.0.0.0",
    httpEnabled: toBool(process.env.HTTP_ENABLED, true),
    httpPort: toNumber(process.env.HTTP_PORT, 3000),
    httpsPort: toNumber(process.env.HTTPS_PORT, 3443),
    httpsEnabled,
    redirectHttpToHttps: toBool(process.env.REDIRECT_HTTP_TO_HTTPS, httpsEnabled),
    sslKeyPath: resolvePath(process.env.SSL_KEY_PATH),
    sslCertPath: resolvePath(process.env.SSL_CERT_PATH),
    sslCaPath: resolvePath(process.env.SSL_CA_PATH),
    publicHostname: String(process.env.PUBLIC_HOSTNAME || "").trim(),
    publicIp: String(process.env.PUBLIC_IP || "").trim(),
    sessionSecret: String(process.env.SESSION_SECRET || "").trim(),
    trustProxy: toBool(process.env.TRUST_PROXY, false),
    secureCookies: toBool(process.env.SECURE_COOKIES, httpsEnabled),
    classCompassUrl: String(process.env.CLASS_COMPASS_URL || '').trim()
  };
}

module.exports = {
  getServerConfig,
  loadEnvFile,
  resolvePath,
  toBool,
  toNumber
};
