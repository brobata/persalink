/**
 * @file Link drop rule
 * @description When the app's link to the server counts as dropped, and
 *   what each stage of a drop says. A drop is reconnected in place: a 2px
 *   progress line and "reconnecting" in the title at once, and only after
 *   ESCALATE_MS an inline banner with Retry now. Pure, so the UI and the
 *   tests share one rule.
 */

/** How long a drop stays quiet (line + title) before the banner shows. */
export const ESCALATE_MS = 8_000;

/** Views that exist only before sign-in; a drop there has its own screen. */
const PRE_AUTH = new Set(['locked', 'connect', 'auth']);

/** The link is down while a signed-in view waits for the socket to come
 *  back: retrying, connecting, or open but not yet authenticated. */
export function isLinkDown(view: string, state: string): boolean {
  if (PRE_AUTH.has(view)) return false;
  return state === 'reconnecting' || state === 'connecting' || state === 'connected';
}

/** "4s", "1m 12s": how long the link has been down. */
export function downFor(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** The one sentence after a long drop ends. Short drops end silently. */
export function backSentence(server: string | null, downMs: number): string {
  return `Back on ${server || 'the server'} after ${downFor(downMs)}. Sessions kept running.`;
}
