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
