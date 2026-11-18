/**
 * @file StatusBar
 * @description The desktop status bar, 24px: the connection (server · ms,
 *   other saved servers in its tooltip), the one message slot, the focused
 *   pane's size, and a Keyboard shortcuts button. The message slot is where
 *   every desktop confirmation goes, as one sentence ("Sent 'Yes' to Ops
 *   Suite · Olive is waiting 9m · Go"), so nothing ever covers a pane.
 *   Plain info notifications are taken from the store's queue here (the
 *   desktop ToastStack skips them, lib/statusLine); answer confirmations
 *   come through uiStore.say() with their Stop action.
 */

import { useEffect, useMemo, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useUiStore, type StatusMessage } from '../../stores/uiStore';
import { goesToStatusBar, waitingTail } from '../../lib/statusLine';
import { nextWaiting, waitAge } from '../../lib/sessionOrder';
import { sessionTitle } from '../../lib/sessionState';
import { ConnectionReadout } from '../ui/ConnectionReadout';

const NOTICE_MS = 5000;

export function StatusBar() {
  const notifications = useAppStore((s) => s.notifications);
  const dismiss = useAppStore((s) => s.dismissNotification);
  const sessions = useAppStore((s) => s.sessions);
  const servers = useAppStore((s) => s.servers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const status = useUiStore((s) => s.status);
  const say = useUiStore((s) => s.say);
  const clearStatus = useUiStore((s) => s.clearStatus);
  const openShortcuts = useUiStore((s) => s.openShortcuts);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const panes = useLayoutStore((s) => s.panes);
  const home = useLayoutStore((s) => s.home);
  const dims = useUiStore((s) => s.paneDims[focusedPaneId]);

  // Plain confirmations move from the toast queue into the slot.
  useEffect(() => {
    const plain = notifications.filter(goesToStatusBar);
    if (plain.length === 0) return;
    const last = plain[plain.length - 1];
    for (const n of plain) dismiss(n.id);
    say(last.message, { ttl: NOTICE_MS });
  }, [notifications, dismiss, say]);

  // The slot empties itself.
  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => clearStatus(status.id), status.ttl);
    return () => window.clearTimeout(t);
  }, [status, clearStatus]);

  const focused = panes.find((p) => p.id === focusedPaneId);
  const currentId = focused && (!focused.serverId || focused.serverId === activeServerId) ? focused.sessionId : null;
  const next = nextWaiting(sessions, currentId);
  const tail = waitingTail(next ? { title: sessionTitle(next), age: waitAge(next) } : null);
  const others = useMemo(
    () => servers.filter((e) => e.id !== activeServerId).map((e) => e.serverName || e.label),
    [servers, activeServerId],
  );

  return (
    <footer className="pl-stb" aria-label="Status">
      <span className="it" title={others.length ? `Other servers: ${others.join(', ')}` : undefined}>
        <ConnectionReadout server />
      </span>
      <span className="min-w-0 flex-1 flex" role="status" aria-live="polite">
        {status && <Message key={status.id} status={status} tail={tail} onGo={() => useAppStore.getState().openNextWaiting()} />}
      </span>
      {dims && !home && <span className="it font-mono tnum text-micro" title="Focused pane size (columns x rows)">{dims.cols}x{dims.rows}</span>}
      <button type="button" className="it" onClick={openShortcuts} title="Keyboard shortcuts (Ctrl+Shift+/)">
        <Keyboard className="w-3.5 h-3.5" strokeWidth={1.75} />Shortcuts
      </button>
    </footer>
  );
}

function Message({ status, tail, onGo }: { status: StatusMessage; tail: string | null; onGo: () => void }) {
  // The tail is read once, when the sentence appears; it never rewrites itself.
  const [shownTail] = useState(tail);
  return (
    <span className="msg">
      <span className="t">{status.text}</span>
      {status.action && (
        <>
          <span className="sep">·</span>
          <button type="button" title={status.action.title} onClick={() => { status.action!.run(); useUiStore.getState().clearStatus(status.id); }}>
            {status.action.label}
          </button>
        </>
      )}
      {shownTail && (
        <>
          <span className="sep">·</span>
          <span className="w">{shownTail}</span>
          <span className="sep">·</span>
          <button type="button" onClick={onGo} title="Open it (Ctrl+Alt+J)">Go</button>
        </>
      )}
    </span>
  );
}
