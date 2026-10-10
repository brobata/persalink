/**
 * @file Opening links on this device
 * @description One place that decides whether a URL may be opened and opens
 *   it. Two sources feed it: clicks on links inside the terminal (opened
 *   directly — the click is the user gesture), and `link.open` requests from
 *   programs in a session (Claude Code's Ctrl-click runs $BROWSER on the
 *   server, which the link bridge forwards here). Browsers block window.open
 *   outside a user gesture, so bridge requests become a tap-to-open toast.
 */

import { useAppStore } from '../stores/appStore';

export const LINK_OPEN_OP = 'link-open';

// A Ctrl-click inside Claude Code's fullscreen UI reaches BOTH xterm.js
// (opened directly) and Claude (which asks the bridge to open it too). The
// direct open wins; the bridge echo within this window is dropped.
const ECHO_WINDOW_MS = 5_000;
const recentlyOpened = new Map<string, number>();

export function isOpenableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Open from inside a user gesture. Returns false for refused URLs. */
export function openExternal(url: string): boolean {
  if (!isOpenableUrl(url)) return false;
  recentlyOpened.set(url, Date.now());
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/** A session program asked to open `url` — offer it as a tap-to-open toast. */
export function promptOpen(url: string): void {
  if (!isOpenableUrl(url)) return;
  const now = Date.now();
  for (const [u, t] of recentlyOpened) if (now - t > ECHO_WINDOW_MS) recentlyOpened.delete(u);
  if (recentlyOpened.has(url)) return;
  const state = useAppStore.getState();
  // Several sockets (desktop panes + the app connection) can deliver the same
  // request; one toast per URL is enough.
  if (state.notifications.some((n) => n.op === LINK_OPEN_OP && n.message === url)) return;
  state.pushNotification('info', url, LINK_OPEN_OP);
}
