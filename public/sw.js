// Service worker: push bildirişlərini göstərir
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || "eTender izləyici", {
      body: data.body || "Yeni tender var",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    (async () => {
      if (url.startsWith("/")) {
        const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
        if (w) return w.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
