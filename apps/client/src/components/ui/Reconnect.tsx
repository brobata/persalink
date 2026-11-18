/**
 * @file Reconnect in place
 * @description The one reconnect surface. A dropped link never covers the
 *   screen: a 2px accent line runs along the top and the title readout says
 *   "reconnecting" (ConnectionReadout). Only after ESCALATE_MS does an inline
 *   banner appear (Retry now, or Sign in again on the public door) and the
 *   terminal dim, never blur. A long drop ends with one "Back on ..." toast;
 *   a short one ends silently. The drop is tracked once, at module level, so
 *   every mounted line or banner agrees and the toast fires once.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { isPublicDoor } from '../../lib/door';
import { ESCALATE_MS, isLinkDown, downFor, backSentence } from '../../lib/linkDrop';
import { StateGlyph } from './StateGlyph';

type Phase = 'idle' | 'down' | 'done';
interface Drop { phase: Phase; escalated: boolean; since: number }

/** How long the finished line takes to fill and fade before it resets. */
const DONE_MS = 480;

let drop: Drop = { phase: 'idle', escalated: false, since: 0 };
const listeners = new Set<() => void>();
let watching = false;
let escTimer: ReturnType<typeof setTimeout> | null = null;
let doneTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: Drop) {
  drop = next;
  // The dim lives on <html> so desktop panes and the phone terminal share it.
  if (next.escalated) document.documentElement.setAttribute('data-linkdown', '');
  else document.documentElement.removeAttribute('data-linkdown');
  listeners.forEach((l) => l());
}

function evaluate() {
  const { view, connectionState, serverName, pushNotification } = useAppStore.getState();
  const down = isLinkDown(view, connectionState);
  if (down && drop.phase !== 'down') {
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    emit({ phase: 'down', escalated: false, since: Date.now() });
    escTimer = setTimeout(() => {
      escTimer = null;
      if (drop.phase === 'down') emit({ ...drop, escalated: true });
    }, ESCALATE_MS);
  } else if (!down && drop.phase === 'down') {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    const { escalated, since } = drop;
    emit({ phase: 'done', escalated: false, since });
    doneTimer = setTimeout(() => {
      doneTimer = null;
      if (drop.phase === 'done') emit({ phase: 'idle', escalated: false, since: 0 });
    }, DONE_MS);
    // Only a drop long enough to have shown the banner earns a sentence.
    if (escalated && connectionState === 'authenticated') {
      pushNotification('info', backSentence(serverName, Date.now() - since));
    }
  }
}

function subscribe(cb: () => void) {
  if (!watching) {
    watching = true;
    useAppStore.subscribe((s, prev) => {
      if (s.view !== prev.view || s.connectionState !== prev.connectionState) evaluate();
    });
    evaluate();
  }
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useLinkDrop(): Drop {
  return useSyncExternalStore(subscribe, () => drop, () => drop);
}

/** The 2px progress line along the top edge. Mount once, at the app root. */
export function ReconnectLine() {
  const { phase, escalated } = useLinkDrop();
  return (
    <div
      className="pl-reline"
      data-phase={phase}
      data-escalated={escalated ? '' : undefined}
      role={phase === 'down' ? 'progressbar' : undefined}
      aria-label={phase === 'down' ? 'Reconnecting' : undefined}
      aria-hidden={phase !== 'down'}
    />
  );
}

/** The inline banner shown only once a drop outlasts ESCALATE_MS. `docked`
 *  sits inside a positioned parent (the phone terminal); otherwise it floats
 *  at the bottom of the viewport. */
export function ReconnectBanner({ docked = false }: { docked?: boolean }) {
  const { phase, escalated, since } = useLinkDrop();
  const serverName = useAppStore((s) => s.serverName);
  const reconnectNow = useAppStore((s) => s.reconnectNow);
  const show = phase === 'down' && escalated;
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!show) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [show]);

  useEffect(() => {
    if (!retrying) return;
    const t = setTimeout(() => setRetrying(false), 1500);
    return () => clearTimeout(t);
  }, [retrying]);

  if (!show) return null;

  const sub = isPublicDoor
    ? 'Your Cloudflare sign-in may have expired (12 hours), or this network blocks it.'
    : retrying
      ? 'Connecting…'
      : `Down ${downFor(now - since)} · retrying on its own. Is Tailscale on?`;

  return (
    <div
      role="status"
      className={`pl-rebanner ${docked ? 'docked' : ''}`}
      // Taps here must not fall through to the terminal (it raises the keyboard).
      onClick={(e) => e.stopPropagation()}
    >
      <StateGlyph state="disconnected" size={16} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] leading-[18px] font-medium text-fg-1 truncate">
          Reconnecting to {serverName || 'the server'}
        </div>
        <div className="text-[12px] leading-4 text-fg-3 tnum">{sub}</div>
      </div>
      {isPublicDoor ? (
        // A full navigation re-runs Cloudflare Access; a socket retry can't.
        <button type="button" className="pl-chip shrink-0" onClick={() => window.location.reload()}>
          Sign in again
        </button>
      ) : (
        <button
          type="button"
          className="pl-chip shrink-0"
          disabled={retrying}
          onClick={() => { setRetrying(true); reconnectNow(); }}
        >
          <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
          Retry now
        </button>
      )}
    </div>
  );
}
