/* CAIPE notification delivery. This worker intentionally has
 * no fetch listener, so it does not intercept or cache application traffic. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function notificationPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/settings/notifications";
  return new URL(value, self.location.origin).origin === self.location.origin ? value : "/settings/notifications";
}

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }
  event.waitUntil((async () => {
    await self.registration.showNotification(String(payload.title || "New CAIPE notification").slice(0, 200), {
    body: String(payload.body || "Open your inbox to view this update.").slice(0, 500),
    tag: String(payload.tag || "caipe-notification").slice(0, 200),
    data: { href: notificationPath(payload.data?.href) },
    });
    if (/^[a-f0-9]{64}$/.test(payload.data?.deliveryId ?? "")) {
      // The receipt is diagnostic only; an expired session must not prevent display.
      try {
        await fetch("/api/notifications/push-receipts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deliveryId: payload.data.deliveryId }), credentials: "same-origin",
        });
      } catch { /* Browser display already succeeded; retrying could duplicate an alert. */ }
    }
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  if (!event.newSubscription) return;
  event.waitUntil(fetch("/api/notifications/push-subscriptions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event.newSubscription.toJSON()), credentials: "same-origin",
  }));
});

self.addEventListener("notificationclick",(event) => {
  event.notification.close();

  const href = event.notification.data?.href;
  const conversationId = event.notification.data?.conversationId;
  const targetPath = typeof href === "string" && href.startsWith("/") && !href.startsWith("//")
    ? href
    : conversationId
      ? `/chat/${encodeURIComponent(conversationId)}`
      : "/chat";

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const targetUrl = new URL(notificationPath(targetPath),self.location.origin).href;

    for (const client of windows) {
      if ("navigate" in client) await client.navigate(targetUrl);
      if ("focus" in client) return client.focus();
    }

    return self.clients.openWindow(targetUrl);
  })());
});
