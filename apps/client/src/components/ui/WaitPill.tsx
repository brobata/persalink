/**
 * @file WaitPill
 * @description "Someone else is waiting for you", one tap away. On a phone:
 *   an amber pill with the next agent's name and how long it has waited
 *   ("Olive 9m", plus "+1" when more wait). On desktop: the count ("2
 *   waiting"). Its ring is the only one on screen that breathes. Renders
 *   nothing when no one else waits. The jump goes to the longest wait that
 *   is not the session on screen (lib/sessionOrder nextWaiting).
 */

import type { SessionInfo } from '@persalink/shared/protocol';
import { nextWaiting, waitAge, waitingSessions } from '../../lib/sessionOrder';
import { sessionTitle } from '../../lib/sessionState';
import { StateGlyph } from './StateGlyph';

export function WaitPill({ sessions, currentId, variant, onJump, className = '' }: {
  sessions: readonly SessionInfo[];
  currentId: string | null;
  variant: 'phone' | 'desktop';
  onJump: (session: SessionInfo) => void;
  className?: string;
}) {
  const waiting = waitingSessions(sessions);
  const next = nextWaiting(sessions, currentId) ?? (variant === 'desktop' ? waiting[0] ?? null : null);
  if (!next) return null;

  if (variant === 'desktop') {
    return (
      <button
        type="button"
        onClick={() => onJump(next)}
        className={`pl-wpill ${className}`}
        title={`Next waiting: ${sessionTitle(next)} · ${waitAge(next)} (Ctrl+Alt+J)`}
        aria-label={`${waiting.length} waiting. Jump to ${sessionTitle(next)}.`}
      >
        <StateGlyph state="waiting" size={10} breathe />
        <span className="tnum">{waiting.length}</span>
        <span>waiting</span>
      </button>
    );
  }

  const others = waiting.filter((s) => s.id !== currentId);
  return (
    <button
      type="button"
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onJump(next); }}
      className={`pl-wpill max-w-[46%] ${className}`}
      title={next.preview || undefined}
      aria-label={`${sessionTitle(next)} is waiting ${waitAge(next)}. Jump to it.`}
    >
      <StateGlyph state="waiting" size={10} breathe />
      <span className="truncate min-w-0 max-w-24">{sessionTitle(next)}</span>
      <span className="shrink-0 tnum text-st-waiting">{waitAge(next)}</span>
      {others.length > 1 && <span className="shrink-0 text-micro text-fg-3">+{others.length - 1}</span>}
    </button>
  );
}
