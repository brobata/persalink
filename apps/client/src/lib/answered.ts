/**
 * @file Answered from Home
 * @description What the client knows that the server cannot see yet. The
 *   server re-reads a session's state only when tmux reports new activity
 *   for it, and tmux does not count output in a session nobody is attached
 *   to; so after Home types an answer (lib/useInlineAnswer, no attach), the
 *   server can keep listing that agent as waiting long after it moved on.
 *   This book remembers each inline answer and shows the session as working
 *   (then idle after a minute), with "Answered: Yes" as its line, until the
 *   server's own snapshot of it changes; from then on the server is right
 *   again. Every list reads the patched sessions, so Home, the sidebar, the
 *   wait pill and the palette agree. Pure; the store applies it.
 */

import type { SessionInfo } from '@persalink/shared/protocol';

/** After this long an answered agent reads as idle rather than working. */
export const ANSWERED_WORKING_MS = 60_000;

interface Entry {
  /** The server's snapshot when the answer went in. */
  activityAt: number | undefined;
  preview: string | undefined;
  label: string;
  at: number;
}

export interface AnsweredBook {
  /** Remember an answer typed into `s` (as the server listed it). */
  mark: (s: SessionInfo, label: string, now?: number) => void;
  /** The list with answered sessions patched; forgets entries the server has caught up on. */
  apply: <T extends SessionInfo>(list: readonly T[], now?: number) => T[];
}

export function createAnsweredBook(): AnsweredBook {
  const book = new Map<string, Entry>();
  // Rows this book already patched (a store list re-applied after a mark).
  const patched = new WeakSet<object>();
  return {
    mark(s, label, now = Date.now()) {
      book.set(s.id, { activityAt: s.activityAt, preview: s.preview, label, at: now });
    },
    apply<T extends SessionInfo>(list: readonly T[], now = Date.now()): T[] {
      if (book.size === 0) return [...list];
      const seen = new Set<string>();
      const out = list.map((s) => {
        seen.add(s.id);
        const e = book.get(s.id);
        if (!e || patched.has(s)) return s;
        // The server has news (or no longer says waiting): it is right again.
        if (s.attention !== 'waiting' || s.activityAt !== e.activityAt || s.preview !== e.preview) {
          book.delete(s.id);
          return s;
        }
        const working = now - e.at < ANSWERED_WORKING_MS;
        const row = {
          ...s,
          attention: working ? 'working' : 'idle',
          preview: `Answered: ${e.label}`,
          unseen: false,
          // The patched row's age counts from the answer, not the old prompt.
          activityAt: Math.floor(e.at / 1000),
          idleSeconds: Math.max(0, Math.round((now - e.at) / 1000)),
        } as T;
        patched.add(row);
        return row;
      });
      for (const id of [...book.keys()]) if (!seen.has(id)) book.delete(id);
      return out;
    },
  };
}

/** The one book the store uses. */
export const answeredBook = createAnsweredBook();
