(function () {
  // Sessions now stay active for the lifetime of the browser session.
  // The Express session cookie already expires when the browser is closed,
  // so there is no client-side inactivity logout timer here.
})();
