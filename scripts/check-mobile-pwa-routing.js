const assert = require("node:assert/strict");
const {
  isBrowserNavigation,
  isMobileRequest,
  mobilePwaEntry
} = require("../src/middleware/mobilePwaEntry");

function request(overrides = {}) {
  return {
    method: "GET",
    path: "/",
    query: {},
    session: {},
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36"
    },
    ...overrides
  };
}

function execute(req) {
  const result = { next: false, redirect: null };
  const res = {
    redirect(status, location) {
      result.redirect = { status, location };
      return result;
    }
  };
  mobilePwaEntry(req, res, () => { result.next = true; });
  return result;
}

assert.equal(isMobileRequest(request()), true);
assert.equal(isMobileRequest(request({ headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } })), false);
assert.equal(isMobileRequest(request({ headers: { accept: "text/html", "sec-ch-ua-mobile": "?1", "user-agent": "Mozilla/5.0" } })), true);
assert.equal(isBrowserNavigation(request()), true);
assert.equal(isBrowserNavigation(request({ method: "POST" })), false);
assert.deepEqual(execute(request()).redirect, { status: 302, location: "/pwa" });

const loginRequest = request({ path: "/login", query: {} });
assert.equal(execute(loginRequest).next, true);
assert.equal(loginRequest.query.next, "/pwa");

const explicitDeepLink = request({ path: "/teacher/calendar" });
assert.equal(execute(explicitDeepLink).next, true);

const fullPortal = request({ query: { view: "full" } });
assert.equal(execute(fullPortal).next, true);
assert.equal(fullPortal.session.mobilePortalView, "full");

const rememberedFullPortal = request({ session: { mobilePortalView: "full" } });
assert.equal(execute(rememberedFullPortal).next, true);

const desktop = request({ headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
assert.equal(execute(desktop).next, true);

console.log("Mobile PWA routing check passed.");
