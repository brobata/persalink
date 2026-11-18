/**
 * @file Session state vocabulary
 * @description One word, one glyph and one group per session state, used by
 *   every surface (rows, headers, pills, panes). States: waiting, error,
 *   working, done (idle with unseen output), idle, exited, disconnected.
 *   Groups, always in this order: Needs you, Working, Quiet, Ended. Counts
 *   and sentences ("2 agents need you") are computed from the list, never
 *   typed. Ordering itself lives in lib/sessionOrder.ts.
 */

import type { SessionInfo } from '@persalink/shared/protocol';
import { attentionKey, waitAge } from './sessionOrder.ts';

export type StateKey = 'waiting' | 'error' | 'working' | 'done' | 'idle' | 'exited' | 'disconnected';

export const STATE_LABEL: Record<StateKey, string> = {
  waiting: 'Waiting',
  error: 'Error',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
  exited: 'Ended',
  disconnected: 'Offline',
};

/** The state of a session. `exited` and `offline` are client-side facts
 *  (a tombstone, or a server we cannot reach) the protocol does not carry. */
export function stateKey(s: SessionInfo, opts: { exited?: boolean; offline?: boolean } = {}): StateKey {
  if (opts.exited) return 'exited';
  if (opts.offline) return 'disconnected';
  const k = attentionKey(s);
  return k === 'quiet' ? 'idle' : k;
}

export type GroupId = 'needs' | 'working' | 'quiet' | 'ended';

export const GROUPS: ReadonlyArray<{ id: GroupId; label: string; keys: readonly StateKey[] }> = [
  { id: 'needs', label: 'Needs you', keys: ['waiting', 'error'] },
  { id: 'working', label: 'Working', keys: ['working'] },
  { id: 'quiet', label: 'Quiet', keys: ['done', 'idle'] },
  { id: 'ended', label: 'Ended', keys: ['disconnected', 'exited'] },
];

export function groupOf(k: StateKey): GroupId {
  for (const g of GROUPS) if (g.keys.includes(k)) return g.id;
  return 'quiet';
}

/** The name a person reads for a session. */
export function sessionTitle(s: SessionInfo): string {
  return s.name || s.profileName || s.id;
}

/** "Waiting 4m", "Working", "Done 28m", "Idle 2h 5m", "Error", "Ended". */
export function stateWord(s: SessionInfo, k: StateKey = stateKey(s), now = Date.now()): string {
  switch (k) {
    case 'waiting': return `Waiting ${waitAge(s, now)}`;
    case 'done': return `Done ${waitAge(s, now)}`;
    case 'idle': return `Idle ${waitAge(s, now)}`;
    case 'disconnected': return 'Offline · retrying';
    default: return STATE_LABEL[k];
  }
}

/** The age shown at the right edge of a row: none while working. */
export function rowAge(s: SessionInfo, k: StateKey = stateKey(s), now = Date.now()): string {
  if (k === 'working' || k === 'disconnected' || k === 'exited') return '';
  return waitAge(s, now);
}

export interface SessionGroup<T extends SessionInfo> {
  id: GroupId;
  label: string;
  items: T[];
}

/** Sessions in attention order, split into the four named groups (empty
 *  groups included, so callers decide whether to draw them). Within Quiet,
 *  done (new output) comes before idle. */
export function groupSessions<T extends SessionInfo>(ordered: readonly T[]): SessionGroup<T>[] {
  return GROUPS.map((g) => {
    const items = ordered.filter((s) => groupOf(stateKey(s)) === g.id);
    if (g.id === 'quiet') {
      items.sort((a, b) => (stateKey(a) === 'done' ? 0 : 1) - (stateKey(b) === 'done' ? 0 : 1));
    }
    return { id: g.id, label: g.label, items };
  });
}

export interface StateCounts { waiting: number; working: number; quiet: number; ended: number; live: number }

export function countStates(list: readonly SessionInfo[]): StateCounts {
  const c: StateCounts = { waiting: 0, working: 0, quiet: 0, ended: 0, live: list.length };
  for (const s of list) {
    const g = groupOf(stateKey(s));
    if (g === 'needs') c.waiting++;
    else if (g === 'working') c.working++;
    else if (g === 'quiet') c.quiet++;
    else c.ended++;
  }
  return c;
}

/** "Nothing needs you", "1 agent needs you", "3 agents need you". */
export function needsSentence(n: number): string {
  if (n === 0) return 'Nothing needs you';
  return n === 1 ? '1 agent needs you' : `${n} agents need you`;
}

/**
 * The preview line as a person should read it: box-drawing frames and the
 * prompt caret gone, and a bare numbered option ("3. No, and tell Claude
 * ...", the last line a permission prompt draws) replaced by what it means
 * for a waiting agent: it is asking you to choose.
 */
export function previewLine(s: SessionInfo, k: StateKey = stateKey(s)): string {
  const raw = (s.preview ?? '').replace(/[│┃|╭╮╰╯─━]+/g, ' ').replace(/^[\s❯›>]+/, '').replace(/\s+/g, ' ').trim();
  if ((k === 'waiting' || k === 'error') && /^\d{1,2}[.)]\s/.test(raw)) return 'Asking you to choose an option';
  return raw;
}
