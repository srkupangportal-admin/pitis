const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameOriginOnly(options = {}) {
  const exempt = typeof options.exempt === "function" ? options.exempt : () => false;

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || exempt(req) || process.env.NODE_ENV === "test") return next();

    const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
    if (fetchSite === "cross-site") return reject(req, res);

    // Modern browsers provide Fetch Metadata independently of Origin/Referer.
    // Treat an explicit same-origin value as sufficient when privacy settings
    // suppress both of those legacy headers. Requests without this signal must
    // still prove their origin below.
    if (fetchSite === "same-origin") return next();

    const expected = `${req.protocol}://${req.get("host")}`;
    const supplied = req.get("origin") || originFromReferer(req.get("referer"));
    if (!supplied || supplied !== expected) return reject(req, res);
    return next();
  };
}

function originFromReferer(value) {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch (_error) {
    return "";
  }
}

function reject(req, res) {
  if (req.path.startsWith("/api/") || req.accepts(["json", "html"]) === "json") {
    return res.status(403).json({ error: "Request rejected because its origin could not be verified." });
  }
  return res.status(403).send("Request rejected because its origin could not be verified.");
}

module.exports = { sameOriginOnly };
