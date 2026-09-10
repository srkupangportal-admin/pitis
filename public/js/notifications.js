(function () {
  const bell = document.querySelector("[data-notification-bell]");
  const count = document.querySelector("[data-notification-count]");
  const promptDelayMs = 1200;
  const invitationIntervalMs = 7 * 24 * 60 * 60 * 1000;
  const dismissedUntilKey = "portal-push-prompt-dismissed-until";
  const legacyDismissedKey = "portal-push-prompt-dismissed";

  async function json(url, options) {
    const response = await fetch(url, {
      ...options,
      headers: { "content-type": "application/json", ...(options || {}).headers }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Notification request failed.");
    return data;
  }

  async function refresh() {
    try {
      const data = await json("/api/notifications?limit=1");
      if (count) {
        count.textContent = data.unread || "";
        count.hidden = !data.unread;
      }
      if (bell) bell.setAttribute("aria-label", `Notifications${data.unread ? `, ${data.unread} unread` : ""}`);
    } catch {}
  }

  window.PortalNotifications = {
    json,
    refresh,
    async enable() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Web Push is not supported by this browser.");
      }
      if (Notification.permission === "denied") {
        throw new Error("Notifications are blocked. Open this site's browser settings and change Notifications to Allow.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const key = (await json("/api/push/public-key")).publicKey;
      if (!key) throw new Error("Push notification keys are not configured on the server.");
      const registration = await navigator.serviceWorker.register("/service-worker.js");
      const padding = "=".repeat((4 - key.length % 4) % 4);
      const bytes = Uint8Array.from(atob((key + padding).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await json("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          device_name: `${navigator.userAgentData?.brands?.[0]?.brand || "Browser"} on ${navigator.userAgentData?.platform || navigator.platform || "device"}`,
          browser: navigator.userAgentData?.brands?.[0]?.brand || "",
          platform: navigator.userAgentData?.platform || navigator.platform || ""
        })
      });
      localStorage.removeItem(dismissedUntilKey);
      localStorage.removeItem(legacyDismissedKey);
      return true;
    }
  };

  refresh();
  setInterval(refresh, 60000);

  if (!("Notification" in window) || Notification.permission !== "default") return;
  const dismissedUntil = Number(localStorage.getItem(dismissedUntilKey) || 0);
  if (dismissedUntil > Date.now()) return;

  setTimeout(() => {
    const prompt = document.createElement("aside");
    prompt.className = "notification-optin";
    prompt.innerHTML = '<strong>Stay updated</strong><span>Receive calendar and reminder notifications on this device.</span><div><button class="btn" data-enable>Enable Notifications</button><button class="btn secondary" data-dismiss>Remind Me Next Week</button></div>';
    document.body.appendChild(prompt);
    prompt.querySelector("[data-enable]").onclick = async () => {
      try {
        await window.PortalNotifications.enable();
        prompt.remove();
      } catch (error) {
        prompt.querySelector("span").textContent = error.message;
      }
    };
    prompt.querySelector("[data-dismiss]").onclick = () => {
      localStorage.setItem(dismissedUntilKey, String(Date.now() + invitationIntervalMs));
      localStorage.removeItem(legacyDismissedKey);
      prompt.remove();
    };
  }, promptDelayMs);
})();
