/**
 * @file Desktop keyboard shortcuts
 * @description Window-level shortcuts for the desktop grid, Windows Terminal
 *   style, plus the panel that lists them (and offers install-as-app). Caught
 *   in the capture phase so xterm never forwards them to the program; pane
 *   actions are routed to the focused pane via lib/paneCommands.
 */

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useLayoutStore } from '../stores/layoutStore';
import { sendPaneCommand } from '../lib/paneCommands';
import { isInstalledApp, promptInstall, useCanInstall } from '../lib/installPrompt';

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+click', 'Open a link'],
  ['Ctrl+C', 'Copy selection, cleaned of indents and wraps (no selection: interrupt)'],
  ['Ctrl+Shift+C', 'Copy selection exactly as shown'],
  ['Ctrl+V', 'Paste'],
  ['Shift+drag', 'Select text inside Claude and other mouse apps'],
  ['Ctrl+Shift+M', 'Write a message in a text box'],
  ['Ctrl+Shift+K', 'Copy from Claude: last reply and its code blocks'],
  ['Ctrl+Shift+L', 'Recent links'],
  ['Ctrl+Alt+→ / ←', 'Next / previous session in this pane'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Same, when installed as an app'],
  ['Ctrl+Alt+1…9', 'Jump to session 1–9'],
  ['Ctrl+Alt+T', 'Open or start a session in this pane'],
  ['Ctrl+Shift+/', 'Show this list'],
];

/** Text fields other than xterm's own input keep their keys. */
function isForeignTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains('xterm-helper-textarea')) return false;
  if (target.dataset.plComposer !== undefined) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

/** Put session `pick(list, current)` into the focused pane. Sessions already
 *  shown in another pane are skipped — assigning one would pull it out of
 *  that pane. Panes bound to a remote server are left alone. */
function switchFocusedPane(pick: (ids: string[], current: string | null) => string | undefined): void {
  const { focusedPaneId, panes, assignSession } = useLayoutStore.getState();
  const { sessions, activeServerId } = useAppStore.getState();
  const slot = panes.find((p) => p.id === focusedPaneId);
  if (!slot || (slot.serverId && slot.serverId !== activeServerId)) return;
  const elsewhere = new Set(panes.filter((p) => p.id !== slot.id && p.sessionId).map((p) => p.sessionId));
  const ids = sessions.map((s) => s.id).filter((id) => !elsewhere.has(id));
  const next = pick(ids, slot.sessionId);
  if (next && next !== slot.sessionId) assignSession(slot.id, next, activeServerId);
}

function cycle(dir: 1 | -1): void {
  switchFocusedPane((ids, current) => {
    if (ids.length === 0) return undefined;
    const i = current ? ids.indexOf(current) : -1;
    if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
    return ids[(i + dir + ids.length) % ids.length];
  });
}

export function useDesktopShortcuts({ onPickSession, onToggleHelp }: {
  onPickSession: (paneId: string) => void;
  onToggleHelp: () => void;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isForeignTextField(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const pane = useLayoutStore.getState().focusedPaneId;
      let handled = true;
      if (mod && e.shiftKey && !e.altKey && key === 'm') sendPaneCommand(pane, 'composer');
      else if (mod && e.shiftKey && !e.altKey && key === 'k') sendPaneCommand(pane, 'claude');
      else if (mod && e.shiftKey && !e.altKey && key === 'l') sendPaneCommand(pane, 'links');
      else if (e.ctrlKey && e.altKey && !e.shiftKey && key === 't') onPickSession(pane);
      else if (mod && e.shiftKey && !e.altKey && (e.code === 'Slash' || key === '?')) onToggleHelp();
      // Browser tabs reserve Ctrl+Tab (and Ctrl+PgUp/PgDn, Ctrl+Shift+T), so
      // every session shortcut also has a Ctrl+Alt form that works in a tab.
      else if (e.ctrlKey && !e.altKey && e.key === 'Tab') cycle(e.shiftKey ? -1 : 1);
      else if (e.ctrlKey && e.altKey && !e.shiftKey && e.key === 'ArrowRight') cycle(1);
      else if (e.ctrlKey && e.altKey && !e.shiftKey && e.key === 'ArrowLeft') cycle(-1);
      // e.key (not e.code) so AltGr+digit symbols on non-US layouts still type.
      else if (e.ctrlKey && e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        switchFocusedPane((ids) => ids[n]);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onPickSession, onToggleHelp]);
}

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const canInstall = useCanInstall();
  const installed = isInstalledApp();
  return (
    <div
      className="absolute right-0 top-full mt-1 z-50 w-[22rem] max-w-[calc(100vw-2rem)] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 pt-2 pb-1.5 border-b border-zinc-800">
        <span className="text-[11px] font-semibold text-zinc-400">Keyboard shortcuts</span>
        <button onClick={onClose} className="px-1.5 text-zinc-600 hover:text-zinc-300 text-xs">×</button>
      </div>
      <dl className="px-3 py-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[11px]">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="contents">
            <dt className="font-mono text-zinc-300 whitespace-nowrap">{keys}</dt>
            <dd className="text-zinc-500">{what}</dd>
          </div>
        ))}
      </dl>
      <div className="px-3 py-2 border-t border-zinc-800 text-[11px] text-zinc-500">
        {installed ? (
          <span>Running as an installed app — tab shortcuts go to PersaLink.</span>
        ) : canInstall ? (
          <div className="flex items-center justify-between gap-2">
            <span>In a browser tab, Chrome keeps Ctrl+Tab for itself. Install for a real app window.</span>
            <button
              onClick={() => { void promptInstall(); }}
              className="shrink-0 px-2.5 py-1 rounded bg-sky-600 text-white hover:bg-sky-500"
            >
              Install
            </button>
          </div>
        ) : (
          <span>In a browser tab, Chrome keeps Ctrl+Tab for itself — use Ctrl+Alt+→/←, or install PersaLink from the browser menu (Cast, save and share → Install page as app).</span>
        )}
      </div>
    </div>
  );
}
