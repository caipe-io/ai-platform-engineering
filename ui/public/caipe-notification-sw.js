/* CAIPE completion notification click handling. This worker intentionally has
 * no fetch listener, so it does not intercept or cache application traffic. */
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
    const targetUrl = new URL(targetPath,self.location.origin).href;

    for (const client of windows) {
      if ("navigate" in client) await client.navigate(targetUrl);
      if ("focus" in client) return client.focus();
    }

    return self.clients.openWindow(targetUrl);
  })());
});
