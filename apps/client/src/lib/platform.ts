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
