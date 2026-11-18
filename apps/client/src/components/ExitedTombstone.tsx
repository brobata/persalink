/**
 * @file Exited tombstone
 * @description Shown over the bottom of the terminal when the session you are
 *   viewing ends. The last frame stays readable above it; keys go nowhere.
 *   Restart starts a fresh session from the same profile, Dismiss goes Home.
 *   Replaces the old silent jump to another live session.
 */

import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { EndedSession } from '../stores/appStore';

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ExitedTombstone({ ended, onRestart, onDismiss }: {
  ended: EndedSession;
  onRestart: () => void;
  onDismiss: () => void;
}) {
  // Restart waits on the server's session.attached; say so, and allow a retry
  // if nothing comes back (dropped socket, session cap reached).
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => setStarting(false), 6000);
    return () => clearTimeout(t);
  }, [starting]);

  return (
    <div
      role="status"
      className="absolute inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 px-4 pt-3
                 pb-[max(12px,env(safe-area-inset-bottom))] motion-safe:animate-[pl-rise_200ms_ease-out]"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="shrink-0 w-4 flex justify-center">
          <span className="block w-2.5 h-[2px] rounded-full bg-[#56565f]" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-200 tabular-nums">Ended at {clock(ended.endedAt)}</div>
          <div className="text-xs text-zinc-500 truncate">{ended.name}</div>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 h-11 px-3 rounded-lg text-sm text-zinc-300 hover:bg-zinc-800 active:bg-zinc-800 transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={() => { setStarting(true); onRestart(); }}
          disabled={starting}
          className="shrink-0 h-11 px-3.5 rounded-lg text-sm font-medium flex items-center gap-1.5
                     bg-emerald-400 text-emerald-950 hover:bg-emerald-300 active:bg-emerald-300
                     disabled:opacity-70 transition-colors"
        >
          <RotateCcw className="w-4 h-4" strokeWidth={1.75} />
          {starting ? 'Starting…' : 'Restart'}
        </button>
      </div>
    </div>
  );
}
