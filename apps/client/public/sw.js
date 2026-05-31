// Minimal service worker — exists only to satisfy PWA install criteria.
//
// We deliberately do NOT register a fetch handler:
//   1. We have nothing to cache. The app depends on a live WebSocket; stale
//      JS would leave clients on outdated bundles.
//   2. A pass-through `event.respondWith(fetch(...))` handler is actively
//      harmful — when Android evicts the SW process (it does this aggressively
//      to reclaim memory), in-flight respondWith promises can hang forever,
//      freezing the page until refresh.
//
// Modern Chromium (89+) accepts an SW with no fetch handler as installable
// as long as install/activate are present and the page is served over HTTPS
// with a valid manifest. Verified against the Chrome installability spec.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// --- Web Push: agent notifications (finished / waiting / error) ---------------
// Payload is JSON: { title, body, tag, sessionId }. We deliberately keep this
// the ONLY thing the SW does beyond install/activate — still no fetch handler.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'PersaLink';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { sessionId: data.sessionId || null },
    })
  );
});

// Tapping a notification focuses an existing window (and asks it to open the
// session) or opens a fresh one deep-linked to the session.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      await c.focus();
      if (sessionId) c.postMessage({ type: 'persalink:open-session', sessionId });
      return;
    }
    await self.clients.openWindow(sessionId ? '/?session=' + encodeURIComponent(sessionId) : '/');
  })());
});
