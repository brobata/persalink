/**
 * @file heldAnswers
 * @description Touch answers held for a short grace period before they are
 *   typed ("Sending 'Yes' in 3s · Undo"). Held here, keyed by session id,
 *   not in the card: a card that unmounts (you opened another session, went
 *   to Settings, or the agent left Needs you) must not silently drop an
 *   answer the user was told would be sent. A card that mounts again shows
 *   the same countdown and can still undo it.
 */

import { useSyncExternalStore } from 'react';
import type { PromptOption } from './claudePrompt';

export interface HeldAnswer {
  option: PromptOption;
  /** When it fires (ms since epoch). */
  until: number;
}

const held = new Map<string, { answer: HeldAnswer; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** Hold `option` for session `id`; `fire` runs after `ms` unless undone.
 *  Returns false when that session already has an answer held. */
export function holdAnswer(id: string, option: PromptOption, ms: number, fire: () => void): boolean {
  if (held.has(id)) return false;
  const timer = setTimeout(() => {
    held.delete(id);
    notify();
    fire();
  }, ms);
  held.set(id, { answer: { option, until: Date.now() + ms }, timer });
  notify();
  return true;
}

/** Undo the held answer for session `id`. */
export function cancelHeld(id: string): void {
  const h = held.get(id);
  if (!h) return;
  clearTimeout(h.timer);
  held.delete(id);
  notify();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The answer held for session `id`, live. */
export function useHeldAnswer(id: string): HeldAnswer | null {
  return useSyncExternalStore(subscribe, () => held.get(id)?.answer ?? null, () => null);
}
