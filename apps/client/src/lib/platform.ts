/**
 * @file Platform detection
 * @description Distinguishes the Capacitor native shell (Play Store app) from
 *   the browser/PWA. In the shell the page origin is the bundled localhost
 *   webview — NOT a PersaLink server — so every origin-derived default
 *   (implicit server, ws/http scheme) must switch off there.
 */

interface CapacitorGlobal { isNativePlatform?: () => boolean }

/** True inside the Capacitor native app. */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/** The page host when it can act as an implicit PersaLink server (browser/PWA
 *  served by the server itself). Empty in the native shell and on non-http
 *  pages — callers treat empty as "no origin server exists". */
export function pageHost(): string {
  if (typeof window === 'undefined' || isNativeShell()) return '';
  const { protocol, host } = window.location;
  return protocol === 'http:' || protocol === 'https:' ? host : '';
}

/** URL schemes for a server entry. `tls` is set when the user typed an
 *  explicit scheme (https/wss → true, http/ws → false). Undefined falls back
 *  to the page protocol in the browser; in the native shell it defaults to
 *  plain ws/http — self-hosted LAN/tailnet servers are usually plain, and
 *  typing https:// in the host forces TLS. */
export function schemesFor(tls: boolean | undefined): { ws: string; http: string } {
  if (tls === true) return { ws: 'wss://', http: 'https://' };
  if (tls === false) return { ws: 'ws://', http: 'http://' };
  const pageTls = !isNativeShell()
    && typeof window !== 'undefined'
    && window.location.protocol === 'https:';
  return pageTls ? { ws: 'wss://', http: 'https://' } : { ws: 'ws://', http: 'http://' };
}

/** The path this client is served under: '/' for the live app, '/beta/' for
 *  the preview build (vite `base`). Static files that ship with the client
 *  (version.json, sw.js) resolve against it; the API, WebSocket and
 *  /api/files stay at the origin root. Always ends in '/'. */
export const APP_BASE: string = (() => {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
})();

/** The saved-state key for a store. The preview build at /beta/ shares the
 *  live app's origin, so it keeps its own copy (`name:beta`): opening the
 *  preview must never rewrite the live app's layout, login or style. */
export function persistName(name: string): string {
  return APP_BASE === '/' ? name : `${name}:beta`;
}

/** Width at which the client switches to the desktop sidebar + grid layout. */
export const DESKTOP_MQ = '(min-width: 768px)';

/** True when the desktop layout is showing (same breakpoint as App.tsx). */
export function isDesktopViewport(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(DESKTOP_MQ).matches;
}
