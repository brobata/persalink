/**
 * @file Desktop status line rules
 * @description Where a message goes on desktop, and what the status bar
 *   adds to it. A plain confirmation ("Answered: Yes", "Copied") is one
 *   sentence in the status bar, never a card over a pane; errors and the
 *   tap-to-act prompts (finish a copy, open a link, insert shared text) stay
 *   as toasts, because they need a click or must not be missed. When
 *   someone else is waiting, the sentence ends with who and how long:
 *   "Sent 'Yes' to Ops Suite · Olive is waiting 9m". Pure, no DOM.
 */

/** Ops whose toast is a button the user must reach (see Toast.tsx). */
const TAP_OPS = new Set(['copy-pending', 'link-open', 'share-pending']);

export interface NoticeLike { kind: 'error' | 'info'; op?: string }

/** True when a notification belongs in the desktop status bar. */
export function goesToStatusBar(n: NoticeLike): boolean {
  return n.kind === 'info' && !(n.op && TAP_OPS.has(n.op));
}

/** "Olive is waiting 9m": the tail the status bar adds, or null. */
export function waitingTail(next: { title: string; age: string } | null): string | null {
  if (!next) return null;
  return next.age === 'now' ? `${next.title} is waiting` : `${next.title} is waiting ${next.age}`;
}

/** The confirmation for an answer chip: "Sent 'Yes' to Ops Suite". */
export function sentSentence(label: string, to: string | null): string {
  return to ? `Sent '${label}' to ${to}` : `Sent '${label}'`;
}
