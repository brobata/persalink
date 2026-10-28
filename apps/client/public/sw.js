// Service worker: PWA install criteria + an app-shell cache so cold starts
// paint instantly instead of staring at the splash while the network wakes up.
//
// Why cache now (the previous SW cached nothing): on Android the WebAPK holds
// the splash screen until the page paints, and painting requires fetching
// index.html + the hashed JS/CSS/font bundles. When the app cold-starts before
// the Tailscale tunnel is up, that fetch stalls and the splash lingers for tens
// of seconds. Serving the shell from cache removes the network from the critical
// path of first paint.
//
// The two hazards the old comment warned about are handled, not ignored:
//   1. Stale JS — build assets are content-hashed (index-<hash>.js), so a new
//      deploy emits new filenames; cache-first on them can never serve a bundle
//      that mismatches its index.html. The unhashed shell (index.html) is
//      network-FIRST, so a reachable server always delivers the current version.
//   2. Hung respondWith on SW eviction — every path here resolves from cache or
//      a bounded (3s) network race; none awaits an unbounded fetch. Non-GET,
//      cross-origin, and the WebSocket upgrade are never intercepted at all.

const SHELL_CACHE = 'persalink-shell-v1';
const SHELL_URL = self.location.origin + '/';
// Vite emits immutable, content-hashed build output under /assets/.
const ASSET_RE = /\/assets\/.+\.(?:js|css|woff2?|ttf|otf)$/;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Immutable hashed asset: serve from cache, fetch+store on first miss. Once
// cached there is no network on this path, so it cannot hang.
async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

// App shell: prefer the network (so deploys land) but fall back to the cached
// shell the instant the network is slow/absent — the whole point of the fix.
async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await withTimeout(fetch(request), 3000);
    if (res && res.ok) cache.put(SHELL_URL, res.clone());
    return res;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw new Error('offline and no cached shell');
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch POST/WS/etc.
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // same-origin only

  if (ASSET_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // The approval page is a real file, not the app shell: never let it be
  // cached as '/' (a cold start offline would then show it instead of the app).
  if (url.pathname.endsWith('.html') && url.pathname !== '/index.html') return;
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }
  // Everything else passes through untouched.
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Best-effort precache of the shell so the FIRST cold start after this SW
    // activates is already fast; hashed assets warm on first load.
    try {
      const cache = await caches.open(SHELL_CACHE);
      await cache.add(SHELL_URL);
    } catch { /* offline at install — runtime cache will fill in */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older SW versions so a bumped SHELL_CACHE takes over.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// --- Web Push: agent notifications (finished / waiting / error) ---------------
// Payload is JSON: { title, body, tag, sessionId }. We deliberately keep this
// the ONLY thing the SW does beyond install/activate — still no fetch handler.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  if (data.kind === 'approval') {
    event.waitUntil(showApproval(data));
    return;
  }
  const title = data.title || 'PersaLink';
  event.waitUntil((async () => {
    // Suppress while the user is LOOKING at the app — a push about the screen
    // they're watching is pure noise. (Chrome waives the must-show-notification
    // rule when the origin has a visible, focused window client.)
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { sessionId: data.sessionId || null },
    });
  })());
});

// --- Sign-in approvals (Duo-style) -------------------------------------------
// Someone passed the password on term.brobata.com. Always shown (even with the
// app open) and sticky until answered. The one-time secret came inside the
// encrypted push and goes straight back to /api/approval — it is what proves
// the answer came from this phone.
function approvalQuery(d) {
  const q = new URLSearchParams({ id: d.id, s: d.secret, n: d.number, ip: d.ip || '', at: d.at || '' });
  return q.toString();
}

function showApproval(d) {
  const where = d.ip ? ' from ' + d.ip : '';
  return self.registration.showNotification('Sign-in request — ' + d.number, {
    body: 'Someone is signing in to PersaLink' + where + '. Approve only if the screen shows ' + d.number + '.',
    tag: 'approval-' + d.id,
    requireInteraction: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    actions: [
      { action: 'approve', title: 'Approve' },
      { action: 'deny', title: 'Deny' },
    ],
    data: { approval: { id: d.id, secret: d.secret, number: d.number, ip: d.ip || '', at: d.at || '' } },
  });
}

async function answerApproval(a, decision) {
  try {
    const res = await fetch('/api/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: a.id, secret: a.secret, decision }),
    });
    const ok = res.ok;
    await self.registration.showNotification(ok ? (decision === 'approve' ? 'Sign-in approved' : 'Sign-in denied') : 'Request expired', {
      body: ok ? '' : 'That sign-in request is no longer waiting.',
      tag: 'approval-result',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    });
  } catch {
    await self.registration.showNotification('Could not reach PersaLink', {
      body: 'Is Tailscale on? Open the app and try again.', tag: 'approval-result', icon: '/icon-192.png',
    });
  }
}

// Tapping a notification focuses an existing window (and asks it to open the
// session) or opens a fresh one deep-linked to the session.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const approval = event.notification.data && event.notification.data.approval;
  if (approval) {
    if (event.action === 'approve' || event.action === 'deny') {
      event.waitUntil(answerApproval(approval, event.action));
    } else {
      // Body tap: a full page with the details and big buttons.
      event.waitUntil(self.clients.openWindow('/approve.html#' + approvalQuery(approval)));
    }
    return;
  }
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
