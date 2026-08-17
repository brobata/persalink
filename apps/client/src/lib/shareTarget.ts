/**
 * @file Share-target intake
 * @description Android share sheet → PWA. The manifest's share_target opens
 *   the app at /?text=…&url=…; App.tsx stashes the payload here. Shared text
 *   is NEVER auto-typed into a session — attaching surfaces a tappable toast,
 *   so the tap is both the user's consent and the user gesture.
 */

export const SHARE_PENDING_OP = 'share-pending';

let pendingShare: string | null = null;

export function stashShare(text: string): void {
  pendingShare = text || null;
}

export function hasPendingShare(): boolean {
  return pendingShare !== null;
}

/** One-shot: returns the shared text and clears it. */
export function consumePendingShare(): string | null {
  const t = pendingShare;
  pendingShare = null;
  return t;
}
