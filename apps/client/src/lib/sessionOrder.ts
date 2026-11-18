/**
 * @file Session attention order
 * @description One ordering rule for every session list (sidebar, home,
 *   switcher, pane picker) and the two "where do I go" rules built on it:
 *   opensFirst() for a cold open and nextWaiting() for the next-waiting
 *   action. Order: waiting, error, working, done-unseen, quiet, exited.
 *   Inside "needs you" the session that has waited longest comes first, so
 *   every list and every next-waiting control agree; the rest are newest
 *   first. useAttentionOrder() holds the order still while a finger or mouse
 *   is down, so a row never moves under a tap.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo } from '@persalink/shared/protocol';

export type AttentionKey = 'waiting' | 'error' | 'working' | 'done' | 'quiet' | 'exited';

const RANK: Record<AttentionKey, number> = {
  waiting: 0, error: 1, working: 2, done: 3, quiet: 4, exited: 5,
};

/** Live sessions never carry 'exited' (the server drops them from the list);
 *  callers that keep a client-side tombstone pass `exited` to rank it last. */
export function attentionKey(s: SessionInfo, exited = false): AttentionKey {
  if (exited) return 'exited';
  switch (s.attention) {
    case 'waiting': return 'waiting';
    case 'error': return 'error';
    case 'working': return 'working';
    default: return s.unseen ? 'done' : 'quiet';
  }
}

/** True for the states that want the user: waiting for input, or an error. */
export function needsYou(s: SessionInfo): boolean {
  const k = attentionKey(s);
  return k === 'waiting' || k === 'error';
}

// activityAt is the last tmux activity in epoch seconds. For a session that is
// waiting, that is about when it started waiting, so ascending = longest wait.
const activity = (s: SessionInfo) => s.activityAt ?? s.createdAt / 1000;

function compare(a: SessionInfo, b: SessionInfo): number {
  const ka = attentionKey(a);
  const kb = attentionKey(b);
  if (ka !== kb) return RANK[ka] - RANK[kb];
  if (ka === 'waiting' || ka === 'error') return activity(a) - activity(b) || a.id.localeCompare(b.id);
  return activity(b) - activity(a) || a.id.localeCompare(b.id);
}

/** A new array in attention order; the input is left alone. */
export function orderSessions<T extends SessionInfo>(sessions: readonly T[]): T[] {
  return [...sessions].sort(compare);
}

/** Sessions that need you, longest wait first. */
export function waitingSessions<T extends SessionInfo>(sessions: readonly T[]): T[] {
  return orderSessions(sessions).filter(needsYou);
}

/** The session the next-waiting action should open: the longest-waiting one
 *  that is not the one you are already looking at. */
export function nextWaiting<T extends SessionInfo>(sessions: readonly T[], currentId: string | null): T | null {
  return waitingSessions(sessions).find((s) => s.id !== currentId) ?? null;
}

/** How recently a session counts as "what you were just doing". */
export const RECENT_FOCUS_MS = 10 * 60 * 1000;

/**
 * The one "which session opens first" rule for a cold open (app launch,
 * sign-in, unlock). With no last session (you left for Home, or never opened
 * one) nothing opens: Home stays up, so a keyboard never lands on a prompt
 * you did not choose. Otherwise the last session wins when it is waiting or
 * you were on it under ten minutes ago; then the agent that has waited
 * longest; then the last session if it is still alive; otherwise Home.
 */
export function opensFirst(
  sessions: readonly SessionInfo[],
  lastId: string | null,
  lastAt: number | null,
  now = Date.now(),
): SessionInfo | null {
  if (!lastId) return null;
  const last = sessions.find((s) => s.id === lastId) ?? null;
  if (last && (needsYou(last) || (lastAt !== null && now - lastAt < RECENT_FOCUS_MS))) return last;
  return waitingSessions(sessions)[0] ?? last ?? null;
}

/** How long the order stays held after the last pointer release. Covers a
 *  two-tap action (arm "Kill?", then confirm) with room to spare. */
const HOLD_AFTER_RELEASE_MS = 3500;

/**
 * Attention order for a rendered list, held still while a pointer is down
 * anywhere on the page and for a moment after. Sessions that appear while
 * held go on top; sessions that vanish drop out; nothing else moves until
 * the hold ends, then the list settles into the live order.
 */
export function useAttentionOrder<T extends SessionInfo>(sessions: readonly T[]): T[] {
  const live = useMemo(() => orderSessions(sessions), [sessions]);
  const latest = useRef(live);
  latest.current = live;
  const [held, setHeld] = useState<string[] | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const down = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      setHeld((h) => h ?? latest.current.map((s) => s.id));
    };
    const up = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; setHeld(null); }, HOLD_AFTER_RELEASE_MS);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
  }, []);

  return useMemo(() => {
    if (!held) return live;
    const pos = new Map(held.map((id, i) => [id, i] as const));
    const fresh = live.filter((s) => !pos.has(s.id));
    const kept = sessions.filter((s) => pos.has(s.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
    return [...fresh, ...kept];
  }, [held, live, sessions]);
}

/** Short wait age from a session's last activity: "now", "4m", "1h 5m", "2d". */
export function waitAge(s: SessionInfo, now = Date.now()): string {
  const sec = Math.max(0, Math.round(now / 1000 - activity(s)));
  if (sec < 45) return 'now';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
