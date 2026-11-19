/**
 * @file DesktopShell
 * @description The desktop frame, one spatial model: the title bar on top;
 *   left = where (the sidebar inbox or its rail); centre = the work (the
 *   pane grid, or the Home tab); the status bar at the bottom carries every
 *   confirmation. Settings, Files and the profile editor open where they are
 *   clicked: a panel slides out from the sidebar's right edge over the left
 *   of the work area. The panes behind it keep their size (nothing
 *   collapses or re-fits). Its X, Esc, a second click on its sidebar button
 *   or a click anywhere outside it closes it (not the profile editor, which
 *   holds unsaved typing: X, Save or Esc only). Window-level surfaces
 *   (palette, shortcuts, PUBLIC badge) come in as children.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { Sidebar } from '../Sidebar';
import { GridLayout } from '../GridLayout';
import { SettingsScreen } from '../SettingsScreen';
import { ProfileEditor } from '../ProfileEditor';
import { FilesScreen } from '../files/FilesScreen';
import { ToastStack } from '../Toast';
import { ReconnectLine, ReconnectBanner } from '../ui/Reconnect';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { DesktopHome } from './DesktopHome';

/** Clicks here never count as "outside the panel": the panel's own toggle
 *  buttons (they toggle it themselves), and dialogs, sheets and toasts that
 *  float above everything. */
const KEEP_OPEN = '[data-panel-toggle],[role="dialog"],[data-panel-keep]';

function SidePanel({ children, label, closeOnOutside }: { children: ReactNode; label: string; closeOnOutside: boolean }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const close = () => useAppStore.getState().closeOverlay();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!closeOnOutside) return;
      if (!t || !t.isConnected || ref.current?.contains(t) || t.closest(KEEP_OPEN)) return;
      close();
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as Element | null;
      // Esc in a text field belongs to the field (clear a search, cancel a
      // rename); Esc in a terminal belongs to the program in it.
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (t?.closest?.('.xterm, [role="dialog"]')) return;
      // Decide after every listener ran: a screen that used this Esc for
      // something inner (close a menu, clear a selection) marks it handled.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (!e.defaultPrevented) close(); }, 0);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      if (timer) clearTimeout(timer);
    };
  }, [closeOnOutside]);

  return (
    <aside ref={ref} className="pl-lp" aria-label={label}>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{children}</div>
    </aside>
  );
}

export function DesktopShell({ children }: { children?: ReactNode }) {
  const view = useAppStore((s) => s.view);
  const home = useLayoutStore((s) => s.home);
  const panel = view === 'settings' || view === 'files' || view === 'profile-editor';
  const panelLabel = view === 'settings' ? 'Settings' : view === 'files' ? 'Files' : 'Profile';

  return (
    <div className="flex flex-col h-screen bg-bg-0 relative">
      <TitleBar />
      <div className="flex-1 min-h-0 flex">
        <Sidebar />
        <main className="flex-1 min-w-0 min-h-0 flex relative">
          <div className="flex-1 min-w-0 min-h-0">
            {home ? <DesktopHome /> : <GridLayout />}
          </div>
          {panel && (
            // The profile editor holds unsaved typing: only its X, Save or
            // Esc close it, never a stray click on a terminal.
            <SidePanel key={view} label={panelLabel} closeOnOutside={view !== 'profile-editor'}>
              {view === 'settings' && <SettingsScreen />}
              {view === 'profile-editor' && <ProfileEditor />}
              {view === 'files' && <FilesScreen />}
            </SidePanel>
          )}
        </main>
      </div>
      <StatusBar />
      <ReconnectLine />
      <ReconnectBanner />
      <ToastStack desktop />
      {children}
    </div>
  );
}
