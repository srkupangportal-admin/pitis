const MOBILE_USER_AGENT = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Silk|Kindle/i;

function header(req, name) {
  if (req && typeof req.get === "function") return String(req.get(name) || "");
  const headers = (req && req.headers) || {};
  return String(headers[String(name).toLowerCase()] || "");
}

function isMobileRequest(req) {
  const clientHint = header(req, "sec-ch-ua-mobile").trim();
  if (clientHint === "?1" || clientHint === "1") return true;
  return MOBILE_USER_AGENT.test(header(req, "user-agent"));
}

function isBrowserNavigation(req) {
  if (!req || !["GET", "HEAD"].includes(String(req.method || "").toUpperCase())) return false;
  const fetchMode = header(req, "sec-fetch-mode").toLowerCase();
  const accept = header(req, "accept").toLowerCase();
  return fetchMode === "navigate" || accept.includes("text/html");
}

function mobilePwaEntry(req, res, next) {
  if (!isBrowserNavigation(req) || !isMobileRequest(req)) return next();

  const view = String((req.query || {}).view || "").trim().toLowerCase();
  if (req.path === "/" && view === "full") {
    req.session.mobilePortalView = "full";
    return next();
  }

  if (req.path === "/" && view === "pwa") {
    delete req.session.mobilePortalView;
    return res.redirect(302, "/pwa");
  }

  if (req.path === "/" && req.session.mobilePortalView !== "full") {
    return res.redirect(302, "/pwa");
  }

  if (req.path === "/login" && !req.query.next && req.session.mobilePortalView !== "full") {
    req.query.next = "/pwa";
  }

  return next();
}

module.exports = {
  isBrowserNavigation,
  isMobileRequest,
  mobilePwaEntry
};
