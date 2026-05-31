/**
 * @file push.ts
 * @description Browser Web Push subscription helpers. Requests notification
 *   permission, subscribes via the service worker's PushManager using the
 *   server's VAPID public key, and returns the subscription JSON for the server
 *   to store. Delivery + display happen in sw.js.
 */

/** Web Push needs a secure context, a service worker, the Push API, and the
 *  Notification API. (iOS only exposes these once the PWA is installed.) */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

// VAPID keys are URL-safe base64; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Request permission and subscribe. Returns a normalized subscription to send
 * to the server, or null if unsupported / permission denied / malformed.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionPayload | null> {
  if (!isPushSupported() || !vapidPublicKey) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const reg = await navigator.serviceWorker.ready;
  // Reuse an existing subscription if present, else create one.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    });
  }
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

/** Unsubscribe locally. Returns the endpoint that was removed (to tell the
 *  server), or null if there was nothing to unsubscribe. */
export async function unsubscribeFromPush(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
