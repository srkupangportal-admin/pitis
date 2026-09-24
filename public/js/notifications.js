(function () {
  const bell = document.querySelector("[data-notification-bell]");
  const count = document.querySelector("[data-notification-count]");
  const promptDelayMs = 1200;
  const invitationIntervalMs = 7 * 24 * 60 * 60 * 1000;
  const dismissedUntilKey = "portal-push-prompt-dismissed-until";
  const legacyDismissedKey = "portal-push-prompt-dismissed";

  async function json(url, options) {
    const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "content-type": "application/json", ...(options || {}).headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Notification request failed.");
    return data;
  }

  function deviceInfo() {
    const ua = navigator.userAgent || "";
    const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    return { isiOS, isAndroid, standalone, supported };
  }

  function guidance() {
    const device = deviceInfo();
    if (device.isiOS && !device.standalone) return { state: "install-required", message: "To receive notifications on iPhone or iPad, tap Share, choose Add to Home Screen, then open PITIS from its Home Screen icon.", canEnable: false, ...device };
    if (!device.supported) return { state: "unsupported", message: device.isiOS ? "PITIS notifications require iOS or iPadOS 16.4 or newer and installation on the Home Screen." : "Web Push is not supported by this browser. Update the browser or use current Chrome, Edge, Firefox, or Safari.", canEnable: false, ...device };
    if (Notification.permission === "denied") return { state: "blocked", message: "Notifications are blocked. Open this device's notification settings for PITIS and change notifications to Allow.", canEnable: false, ...device };
    if (Notification.permission === "granted") return { state: "checking", message: "Checking this device subscription…", canEnable: true, ...device };
    return { state: "available", message: device.isiOS ? "PITIS is installed correctly. Tap Enable Notifications, then choose Allow." : "Tap Enable Notifications, then allow notifications when your device asks.", canEnable: true, ...device };
  }

  function applicationServerKey(key) {
    const padding = "=".repeat((4 - key.length % 4) % 4);
    return Uint8Array.from(atob((key + padding).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  }

  function subscriptionPayload(subscription) {
    const data = navigator.userAgentData;
    const browser = data?.brands?.[0]?.brand || (/CriOS/i.test(navigator.userAgent) ? "Chrome" : /Safari/i.test(navigator.userAgent) ? "Safari" : "Browser");
    const platform = data?.platform || (deviceInfo().isiOS ? "iOS" : navigator.platform || "device");
    return { subscription: subscription.toJSON(), device_name: `${browser} on ${platform}`, browser, platform };
  }

  async function saveSubscription(subscription) {
    await json("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscriptionPayload(subscription)) });
    localStorage.removeItem(dismissedUntilKey);
    localStorage.removeItem(legacyDismissedKey);
  }

  async function status({ repair = true } = {}) {
    const result = guidance();
    if (!result.supported || result.state === "install-required" || result.state === "blocked" || Notification.permission !== "granted") return result;
    const registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { ...result, state: "permission-only", message: "Permission is allowed, but this device is not subscribed. Tap Enable Notifications to repair it.", canEnable: true };
    if (repair) await saveSubscription(subscription);
    return { ...result, state: "enabled", message: "Notifications are enabled on this device.", canEnable: false };
  }

  async function enable() {
    const result = guidance();
    if (["install-required", "unsupported", "blocked"].includes(result.state)) throw new Error(result.message);
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted. You can enable it later in Notification Settings.");
    const key = (await json("/api/push/public-key")).publicKey;
    if (!key) throw new Error("Push notification keys are not configured on the server.");
    const registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) });
    await saveSubscription(subscription);
    return status({ repair: false });
  }

  async function refresh() {
    try {
      const data = await json("/api/notifications?limit=1");
      if (count) { count.textContent = data.unread || ""; count.hidden = !data.unread; }
      if (bell) bell.setAttribute("aria-label", `Notifications${data.unread ? `, ${data.unread} unread` : ""}`);
    } catch {}
  }

  window.PortalNotifications = { json, refresh, deviceInfo, guidance, status, enable };
  refresh();
  setInterval(refresh, 60000);

  const initial = guidance();
  if (["blocked", "unsupported"].includes(initial.state)) return;
  const dismissedUntil = Number(localStorage.getItem(dismissedUntilKey) || 0);
  if (dismissedUntil > Date.now()) return;
  setTimeout(async () => {
    const current = await status().catch(() => guidance());
    if (["enabled", "blocked", "unsupported"].includes(current.state)) return;
    const prompt = document.createElement("aside");
    prompt.className = "notification-optin";
    prompt.innerHTML = '<strong>Stay updated</strong><span></span><div><button class="btn" data-enable></button><button class="btn secondary" data-dismiss>Remind Me Next Week</button></div>';
    prompt.querySelector("span").textContent = current.message;
    prompt.querySelector("[data-enable]").textContent = current.state === "install-required" ? "Show iPhone steps" : "Enable Notifications";
    document.body.appendChild(prompt);
    prompt.querySelector("[data-enable]").onclick = async () => {
      if (current.state === "install-required") { window.location.href = "/notification-settings#ios-install"; return; }
      try { await enable(); } catch (error) { console.warn("Push notification setup was not completed:", error); }
      prompt.remove();
    };
    prompt.querySelector("[data-dismiss]").onclick = () => { localStorage.setItem(dismissedUntilKey, String(Date.now() + invitationIntervalMs)); localStorage.removeItem(legacyDismissedKey); prompt.remove(); };
  }, promptDelayMs);
})();
