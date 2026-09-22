const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { ipKeyGenerator, rateLimit } = require("express-rate-limit");
const dayjs = require("dayjs");
const { initializeDatabase } = require("./db/init");
const { getServerConfig, loadEnvFile } = require("./config/env");

const authRoutes = require("./routes/authRoutes");
const publicRoutes = require("./routes/publicRoutes");
const teacherRoutes = require("./routes/teacherRoutes");
const importRoutes = require("./routes/importRoutes");
const adminRoutes = require("./routes/adminRoutes");
const apiCalendarRoutes = require("./routes/apiCalendarRoutes");
const informationRoutes = require("./routes/informationRoutes");
const photoRoutes = require("./routes/photoRoutes");
const notesRoutes = require("./routes/notesRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const rewardGalleryRoutes = require("./routes/rewardGalleryRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const pwaRoutes = require("./routes/pwaRoutes");
const { initializeNotificationTables, initializeNotificationScheduler } = require("./services/notificationService");
const { initializePitisProgressTables } = require("./services/pitisProgressService");
const { initializeBackupScheduler } = require("./services/backupService");
const { initializeTeacherUsageAuditScheduler } = require("./services/teacherUsageAuditService");
const { seedOfficialSchoolCalendar2026 } = require("./services/schoolCalendarService");
const { getRecentNonAdminLogins } = require("./services/userLoginLogService");
const { adminAuditMiddleware } = require("./services/adminAuditService");
const { SqliteSessionStore } = require("./services/sessionStore");
const { sameOriginOnly } = require("./middleware/sameOrigin");
const { db, updateDailySnapshot } = require("./db/init");

loadEnvFile();
const serverConfig = getServerConfig();

initializeDatabase();
initializeNotificationTables();
initializePitisProgressTables();
initializeNotificationScheduler();
seedOfficialSchoolCalendar2026();
initializeBackupScheduler();
initializeTeacherUsageAuditScheduler();

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  Object.values(interfaces).forEach((items) => {
    (items || []).forEach((item) => {
      if (!item || item.internal || item.family !== "IPv4") return;
      addresses.push(item.address);
    });
  });
  return Array.from(new Set(addresses));
}

function createApp(config) {
  const app = express();

  if (config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to a unique value of at least 32 characters.");
  }
  if (process.env.NODE_ENV === "production") {
    const integrationToken = String(process.env.CLASSCOMPASS_INTEGRATION_TOKEN || "").trim();
    if (!config.trustProxy) throw new Error("TRUST_PROXY must be true in production behind the hosting HTTPS proxy.");
    if (!config.secureCookies) throw new Error("SECURE_COOKIES must be true in production.");
    if (!config.publicHostname || /^(localhost|127\.)/i.test(config.publicHostname)) throw new Error("PUBLIC_HOSTNAME must be the public SchoolPortal hostname in production.");
    if (!/^https:\/\//i.test(config.classCompassUrl)) throw new Error("CLASS_COMPASS_URL must be an HTTPS URL in production.");
    if (integrationToken.length < 32 || /^replace-/i.test(integrationToken)) throw new Error("CLASSCOMPASS_INTEGRATION_TOKEN must be a unique production secret of at least 32 characters.");
  }

  if (config.trustProxy) {
    app.set("trust proxy", 1);
  }
  app.disable("x-powered-by");
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: process.env.NODE_ENV === "production" ? undefined : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"]
      }
    }
  }));

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));

  app.use((req, res, next) => {
    res.locals.requestProtocol = req.secure ? "https" : "http";
    res.locals.requestHost = req.get("host") || "";
    res.locals.requestOrigin = `${res.locals.requestProtocol}://${res.locals.requestHost}`;
    res.locals.isSecureRequest = req.secure;
    const hostHeader = String(req.headers.host || "").trim();
    const hostName = hostHeader.replace(/:\d+$/, "") || config.publicIp || config.publicHostname || "localhost";
    const httpsHost = config.httpsPort === 443 ? hostName : `${hostName}:${config.httpsPort}`;
    res.locals.classCompassUrl = config.classCompassUrl || `http://${hostName}:4173`;
    res.locals.securitySetup = {
      caDownloadPath: "/downloads/school-portal-root-ca.crt",
      installHelpPath: "/security/certificate",
      httpsUrl: `https://${httpsHost}${req.originalUrl || "/"}`,
      showInstallPrompt: config.httpsEnabled && !req.secure
    };
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyGenerator: (req) => {
      const username = String((req.body || {}).username || "unknown").trim().toLowerCase();
      return `${ipKeyGenerator(req.ip)}:${username}`;
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: "Too many unsuccessful attempts for this account. Please wait 15 minutes and try again."
  });
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1500,
    keyGenerator: (req) => req.session?.user?.id
      ? `user:${req.session.user.id}`
      : `ip:${ipKeyGenerator(req.ip)}`,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });

  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(express.json({ limit: "1mb" }));
  const publicRoot = path.join(__dirname, "..", "public");
  const publicStatic = express.static(publicRoot);
  app.use((req, res, next) => {
    if (req.path === "/uploads" || req.path.startsWith("/uploads/")) return next();
    return publicStatic(req, res, next);
  });
  app.use("/uploads/photos", express.static(path.join(publicRoot, "uploads", "photos"), { dotfiles: "deny", index: false }));
  app.use("/uploads/rewards", express.static(path.join(publicRoot, "uploads", "rewards"), { dotfiles: "deny", index: false }));
  app.use("/vendor/html5-qrcode", express.static(path.join(__dirname, "..", "node_modules", "html5-qrcode")));

  app.use(
    session({
      store: new SqliteSessionStore(db),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.httpsEnabled && !config.redirectHttpToHttps ? "auto" : config.secureCookies,
        // Keep trusted mobile browsers signed in. Explicit logout still
        // destroys both the browser cookie and its server-side session.
        maxAge: 30 * 24 * 60 * 60 * 1000
      }
    })
  );

  const protectedUpload = (folder) => [
    (req, res, next) => {
      if (!req.session.user) return res.status(401).send("Sign in is required to view this file.");
      if (req.session.user.mustChangePassword) return res.status(403).send("Change your password before viewing this file.");
      res.set("Cache-Control", "private, no-store");
      return next();
    },
    express.static(path.join(publicRoot, "uploads", folder), { dotfiles: "deny", index: false, fallthrough: false })
  ];
  app.use("/uploads/students", ...protectedUpload("students"));
  app.use("/uploads/informations", ...protectedUpload("informations"));
  app.use("/uploads/inventory-documents", ...protectedUpload("inventory-documents"));
  app.use("/uploads/devices", ...protectedUpload("devices"));
  app.use("/uploads", (_req, res) => res.sendStatus(404));

  app.use(sameOriginOnly({
    exempt: (req) => req.path.startsWith("/api/integrations/classcompass/")
  }));

  app.use("/login", loginLimiter);
  app.use("/api/integrations/classcompass/staff-login", loginLimiter);
  app.use("/api", apiLimiter);

  app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.now = dayjs();
    try {
      res.locals.recentPortalUsers = getRecentNonAdminLogins(5);
    } catch (_err) {
      res.locals.recentPortalUsers = [];
    }
    next();
  });

  // Server-to-server ClassCompass endpoints must be registered before any
  // globally mounted authenticated routers, otherwise those routers can turn
  // a valid integration request into a browser login redirect.
  registerClassCompassIntegrationRoutes(app);

  app.use(authRoutes);
  app.use(publicRoutes);
  app.use("/pwa", pwaRoutes);
  app.use("/teacher", teacherRoutes);
  app.use("/admin", adminAuditMiddleware);
  app.use("/admin", importRoutes);
  app.use("/admin", adminRoutes);
  app.use("/api/calendar", apiCalendarRoutes);
  app.use(informationRoutes);
  app.use(photoRoutes);
  app.use(rewardGalleryRoutes);
  app.use(notificationRoutes);
  app.use("/notes", notesRoutes);
  app.use(deviceRoutes);
  app.use(inventoryRoutes);

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send("Internal server error");
  });

  return app;
}

function logAccessUrls(config, protocol) {
  const port = protocol === "https" ? config.httpsPort : config.httpPort;
  const urls = [];
  urls.push(`${protocol}://localhost${port === (protocol === "https" ? 443 : 80) ? "" : `:${port}`}`);
  getLanAddresses().forEach((ip) => {
    urls.push(`${protocol}://${ip}${port === (protocol === "https" ? 443 : 80) ? "" : `:${port}`}`);
  });
  if (config.publicHostname) {
    urls.push(`${protocol}://${config.publicHostname}${port === (protocol === "https" ? 443 : 80) ? "" : `:${port}`}`);
  }
  if (config.publicIp) {
    urls.push(`${protocol}://${config.publicIp}${port === (protocol === "https" ? 443 : 80) ? "" : `:${port}`}`);
  }

  console.log(`${protocol.toUpperCase()} server ready:`);
  Array.from(new Set(urls)).forEach((url) => console.log(`  ${url}`));
}

function buildHttpsOptions(config) {
  if (!config.sslKeyPath || !config.sslCertPath) {
    throw new Error("HTTPS is enabled but SSL_KEY_PATH or SSL_CERT_PATH is missing in .env");
  }
  if (!fs.existsSync(config.sslKeyPath)) {
    throw new Error(`SSL key file not found: ${config.sslKeyPath}`);
  }
  if (!fs.existsSync(config.sslCertPath)) {
    throw new Error(`SSL certificate file not found: ${config.sslCertPath}`);
  }

  const options = {
    key: fs.readFileSync(config.sslKeyPath),
    cert: fs.readFileSync(config.sslCertPath)
  };

  if (config.sslCaPath) {
    if (!fs.existsSync(config.sslCaPath)) {
      throw new Error(`SSL CA file not found: ${config.sslCaPath}`);
    }
    options.ca = fs.readFileSync(config.sslCaPath);
  }

  return options;
}

const app = createApp(serverConfig);

function integrationTokenMatches(requestToken, configuredToken) {
  const supplied = Buffer.from(String(requestToken || ""));
  const configured = Buffer.from(String(configuredToken || ""));
  return supplied.length === configured.length && supplied.length > 0 && crypto.timingSafeEqual(supplied, configured);
}

function registerClassCompassIntegrationRoutes(app) {
app.post("/api/integrations/classcompass/pitis-awards", (req, res) => {
  const configuredToken = String(process.env.CLASSCOMPASS_INTEGRATION_TOKEN || "").trim();
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!configuredToken) return res.status(503).json({ error: "ClassCompass integration is not configured." });
  if (!integrationTokenMatches(token, configuredToken)) return res.status(401).json({ error: "ClassCompass integration token is invalid." });
  const points = Number(req.body.points);
  const studentId = String(req.body.student_id || "").trim();
  const teacherUsername = String(req.body.teacher_username || "").trim().toLowerCase();
  if (![1, 2, 3].includes(points) || !studentId || !teacherUsername || req.body.reason !== "Assignment handed in") return res.status(400).json({ error: "Invalid ClassCompass P.I.T.I.S. award." });
  const student = db.prepare("SELECT id,name,full_name,class_id FROM students WHERE student_id = ?").get(studentId);
  const teacher = db.prepare("SELECT id FROM users WHERE username = ? AND is_active = 1 AND role IN ('teacher','staff','admin')").get(teacherUsername);
  if (!student) return res.status(404).json({ error: "Student ID was not found in SchoolPortal." });
  if (!teacher) return res.status(403).json({ error: "The ClassCompass teacher is not an active SchoolPortal staff account." });
  const awardedAt = dayjs().toISOString();
  db.transaction(() => {
    db.prepare("INSERT INTO point_logs (student_id,class_id,points,reason,awarded_by,awarded_at) VALUES (?,?,?,?,?,?)").run(student.id, student.class_id, points, "Assignment handed in", teacher.id, awardedAt);
    updateDailySnapshot(student.id);
  })();
  res.status(201).json({ ok: true, student: { id: student.id, name: student.name || student.full_name }, points });
});

app.post("/api/integrations/classcompass/staff-login", (req, res) => {
  const configuredToken = String(process.env.CLASSCOMPASS_INTEGRATION_TOKEN || "").trim();
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!configuredToken) return res.status(503).json({ error: "ClassCompass integration is not configured." });
  if (!integrationTokenMatches(token, configuredToken)) return res.status(401).json({ error: "ClassCompass integration token is invalid." });

  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT id,username,display_name,role,user_type,password_hash,is_active,must_change_password FROM users WHERE username = ?").get(username);
  const isTeacher = user && ["teacher", "staff"].includes(user.role);
  const isAdmin = user && user.role === "admin";
  if (!user || Number(user.is_active || 0) !== 1 || (!isTeacher && !isAdmin) || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid SchoolPortal staff credentials." });
  }
  if (user.role !== "admin" && Number(user.must_change_password || 0) === 1) {
    return res.status(403).json({ error: "Change this password in SchoolPortal before using Classroom Compass." });
  }
  return res.json({
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role
  });
});
}

if (serverConfig.httpsEnabled) {
  const httpsOptions = buildHttpsOptions(serverConfig);
  https.createServer(httpsOptions, app).listen(serverConfig.httpsPort, serverConfig.host, () => {
    logAccessUrls(serverConfig, "https");
  });

  if (serverConfig.httpEnabled) {
    http.createServer(app).listen(serverConfig.httpPort, serverConfig.host, () => {
      logAccessUrls(serverConfig, "http");
    });
  }
} else {
  http.createServer(app).listen(serverConfig.httpPort, serverConfig.host, () => {
    logAccessUrls(serverConfig, "http");
  });
}
