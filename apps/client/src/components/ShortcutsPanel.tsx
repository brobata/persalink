/**
 * @file Keyboard shortcuts
 * @description The window-level key hooks and the one Keyboard shortcuts
 *   sheet that lists them. Keys are caught in the capture phase so xterm
 *   never forwards a shortcut to the program.
 *   - useGlobalShortcuts: works on every screen. Desktop: palette, next
 *     waiting, Files, Settings, the shortcuts sheet, and digit answers when
 *     focus is outside the terminal. Phone with a hardware keyboard (the
 *     Titan): the invisible Alt set (lib/keymap) and the same digit answers.
 *   - useDesktopShortcuts: the desktop grid's pane keys (composer, copy from
 *     Claude, links, session cycling, the pane picker).
 *   Pane actions go to the current terminal through lib/paneCommands.
 */

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useUiStore } from '../stores/uiStore';
import { currentTerminal, PHONE_TERMINAL, sendPaneCommand, terminalHasFocus } from '../lib/paneCommands';
import { answerDigit, desktopAction, phoneAction, DESKTOP_KEYS, PHONE_KEYS, type KeyAction, type KeyRow } from '../lib/keymap';
import { orderSessions } from '../lib/sessionOrder';
import { deviceKind } from '../lib/device';
import { isInstalledApp, promptInstall, useCanInstall } from '../lib/installPrompt';
import { Sheet } from './ui/Sheet';
import { Kbd } from './ui/Kbd';

/** Text fields other than xterm's own input keep their keys. */
function isForeignTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains('xterm-helper-textarea')) return false;
  if (target.dataset.plComposer !== undefined) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

/** Any place text is typed, xterm's input and the composer included. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
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

/** Phone: the previous / next session in attention order (the order every
 *  list shows), wrapping at the ends. */
function stepPhoneSession(dir: 1 | -1): void {
  // The phone terminal steps through its own swipe ring, with the slide.
  if (sendPaneCommand(PHONE_TERMINAL, 'step', String(dir))) return;
  const { sessions, attachedSession, attachSession } = useAppStore.getState();
  const list = orderSessions(sessions);
  if (list.length === 0) return;
  const i = attachedSession ? list.findIndex((s) => s.id === attachedSession.id) : -1;
  const next = i < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[(i + dir + list.length) % list.length];
  if (next && next.id !== attachedSession?.id) attachSession(next.id);
}

/** Run one keyboard action. Shared by both variants of the global hook. */
export function runKeyAction(action: KeyAction): void {
  const app = useAppStore.getState();
  const ui = useUiStore.getState();
  switch (action) {
    case 'palette': ui.togglePalette(); return;
    case 'shortcuts': ui.shortcutsOpen ? ui.closeShortcuts() : ui.openShortcuts(); return;
    case 'next-waiting':
      if (!app.openNextWaiting()) app.pushNotification('info', 'Nothing else needs you');
      return;
    case 'files':
      if (app.filesDisabled) app.pushNotification('info', 'Files are turned off for this connection');
      else if (app.view === 'files') app.closeOverlay();
      else app.openFiles();
      return;
    case 'settings': if (app.view === 'settings') app.closeOverlay(); else app.openSettings(); return;
    case 'home':
      if (deviceKind() === 'desktop') { app.closeOverlay(); useLayoutStore.getState().showHome(); return; }
      if (app.view !== 'home') app.goBack();
      return;
    case 'sidebar': ui.toggleSidebar(); return;
    case 'prev-session': stepPhoneSession(-1); return;
    case 'next-session': stepPhoneSession(1); return;
    case 'composer': sendPaneCommand(currentTerminal(), 'composer'); return;
    case 'copy-claude': sendPaneCommand(currentTerminal(), 'claude'); return;
    case 'links': sendPaneCommand(currentTerminal(), 'links'); return;
    case 'upload': sendPaneCommand(currentTerminal(), 'upload'); return;
  }
}

/**
 * Window-level keys for every screen. `variant` picks the map; `enabled`
 * false mounts nothing (the phone map is only for a hardware keyboard).
 */
export function useGlobalShortcuts({ variant, enabled = true }: { variant: 'desktop' | 'phone'; enabled?: boolean }): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const ui = useUiStore.getState();
      const action = variant === 'desktop' ? desktopAction(e, terminalHasFocus(e.target)) : phoneAction(e);
      const done = () => { e.preventDefault(); e.stopPropagation(); };
      // The palette chord toggles from anywhere, the palette's own field included.
      if (action === 'palette') { done(); runKeyAction('palette'); return; }
      if (ui.paletteOpen) return; // the palette owns every other key while open
      if (isForeignTextField(e.target)) return;
      if (action) { done(); runKeyAction(action); return; }
      // Digit answers: only when the terminal itself does not have the key
      // (there, the digit already reaches the agent as typed).
      // Never from any text field either (the composer included: a digit
      // typed into a message is part of the message).
      const digit = answerDigit(e);
      if (digit && !e.repeat && !terminalHasFocus(e.target) && !isTextEntry(e.target)) {
        if (sendPaneCommand(currentTerminal(), 'answer', digit)) done();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [variant, enabled]);
}

/** The desktop grid's pane keys. */
export function useDesktopShortcuts({ onPickSession }: { onPickSession: (paneId: string) => void }): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isForeignTextField(e.target)) return;
      if (useUiStore.getState().paletteOpen) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const pane = useLayoutStore.getState().focusedPaneId;
      let handled = true;
      if (mod && e.shiftKey && !e.altKey && key === 'm') sendPaneCommand(pane, 'composer');
      else if (mod && e.shiftKey && !e.altKey && key === 'y') sendPaneCommand(pane, 'claude');
      else if (mod && e.shiftKey && !e.altKey && key === 'l') sendPaneCommand(pane, 'links');
      else if (e.ctrlKey && e.altKey && !e.shiftKey && key === 't') onPickSession(pane);
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
  }, [onPickSession]);
}

function KeyList({ title, rows }: { title: string; rows: readonly KeyRow[] }) {
  return (
    <section className="px-2 pb-3">
      <h3 className="pt-2 pb-1.5 text-meta font-semibold text-fg-3">{title}</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-body text-fg-2">
        {rows.map((r) => (
          <div key={r.keys} className="contents">
            <dt className="min-w-0">{r.action}</dt>
            <dd className="text-right whitespace-nowrap"><Kbd keys={r.keys} /></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The one list of keys. On a phone this is the only place keys are drawn. */
export function KeyboardShortcutsSheet({ onClose }: { onClose: () => void }) {
  const canInstall = useCanInstall();
  const installed = isInstalledApp();
  const phone = deviceKind() === 'phone';
  const phoneList = <KeyList key="p" title="Phone with a keyboard" rows={PHONE_KEYS} />;
  const deskList = <KeyList key="d" title="Desktop" rows={DESKTOP_KEYS} />;
  return (
    <Sheet title="Keyboard shortcuts" sub="Every action is also a tap or a click" onClose={onClose} tall={phone}>
      {phone ? [phoneList, deskList] : [deskList, phoneList]}
      {!phone && (
        <div className="mx-2 mt-1 pt-3 border-t border-line text-meta text-fg-3">
          {installed ? (
            <span>Running as an installed app, so tab shortcuts go to PersaLink.</span>
          ) : canInstall ? (
            <div className="flex items-center justify-between gap-3">
              <span>In a browser tab, Chrome keeps Ctrl+Tab for itself. Install for a real app window.</span>
              <button
                type="button"
                onClick={() => { void promptInstall(); }}
                className="shrink-0 h-8 px-3 rounded-[6px] bg-accent text-accent-ink font-semibold hover:bg-accent-hi"
              >
                Install
              </button>
            </div>
          ) : (
            <span>In a browser tab, Chrome keeps Ctrl+Tab for itself. Use Ctrl+Alt+→ / ←, or install PersaLink from the browser menu.</span>
          )}
        </div>
      )}
    </Sheet>
  );
}
