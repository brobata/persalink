/**
 * @file DesktopShell
 * @description The desktop frame, one spatial model: the title bar on top;
 *   left = where (the sidebar inbox or its rail); centre = the work (the
 *   pane grid, or the Home tab); right = details on demand (Settings, Files
 *   and the profile editor slide over the right edge as a 480px panel while
 *   the panes stay live, the unfocused ones folded to their strips); the
 *   status bar at the bottom carries every confirmation. Window-level
 *   surfaces (palette, shortcuts, PUBLIC badge) come in as children.
 */

import type { ReactNode } from 'react';
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

function RightPanel({ children, label }: { children: ReactNode; label: string }) {
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  return (
    <aside className="pl-rp" aria-label={label}>
      {/* Each screen's own Back closes it, and so does Esc. */}
      <div
        className="flex-1 min-h-0 overflow-hidden flex flex-col"
        onKeyDown={(e) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) closeOverlay(); }}
      >
        {children}
      </div>
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
        <main className="flex-1 min-w-0 min-h-0 flex">
          <div className="flex-1 min-w-0 min-h-0">
            {home ? <DesktopHome /> : <GridLayout panel={panel} />}
          </div>
          {panel && (
            <RightPanel key={view} label={panelLabel}>
              {view === 'settings' && <SettingsScreen />}
              {view === 'profile-editor' && <ProfileEditor />}
              {view === 'files' && <FilesScreen />}
            </RightPanel>
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
