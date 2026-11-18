/**
 * @file TitleBar
 * @description The one desktop title bar, 36px: sidebar toggle, the
 *   workspace tabs (Home first, then each saved arrangement of panes, plus
 *   a new-workspace button), the palette trigger in the middle, then the
 *   "N waiting" pill (the screen's one primary action when someone waits),
 *   the layout switch and terminal appearance. A tab gets an amber dot only
 *   when it is not the active tab and one of its panes waits; Home never
 *   gets one (Home is where waiting agents are listed already).
 */

import { useRef, useState } from 'react';
import { Columns2, House, LayoutGrid, PanelLeft, Plus, Rows2, Search, SlidersHorizontal, Square, X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useLayoutStore, type Layout, type Workspace } from '../../stores/layoutStore';
import { useUiStore } from '../../stores/uiStore';
import { workspaceLabel, paneCountFor } from '../../lib/workspaces';
import { needsYou } from '../../lib/sessionOrder';
import { sessionTitle } from '../../lib/sessionState';
import { WaitPill } from '../ui/WaitPill';
import { IconButton } from '../ui/IconButton';
import { Kbd } from '../ui/Kbd';
import { TerminalSettings } from '../TerminalSettings';
import { UpdatePill } from '../UpdatePill';

const LAYOUTS: Array<{ id: Layout; label: string; Icon: typeof Square }> = [
  { id: 'single', label: 'One pane', Icon: Square },
  { id: 'split-h', label: 'Two panes side by side', Icon: Columns2 },
  { id: 'split-v', label: 'Two panes stacked', Icon: Rows2 },
  { id: '2x2', label: 'Four panes', Icon: LayoutGrid },
];

function WorkspaceTab({ ws, on, label, waiting, canClose }: {
  ws: Workspace;
  on: boolean;
  label: string;
  waiting: boolean;
  canClose: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = () => {
    useLayoutStore.getState().renameWorkspace(ws.id, draft);
    setEditing(false);
  };
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={on}
      className={`pl-tab${on ? ' on' : ''}`}
      title={`${label}. Double-click to rename.`}
      onClick={() => { useAppStore.getState().closeOverlay(); useLayoutStore.getState().switchWorkspace(ws.id); }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !editing) useLayoutStore.getState().switchWorkspace(ws.id); }}
      onDoubleClick={() => { setDraft(ws.name ?? label); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="Workspace name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          autoFocus
        />
      ) : (
        <span className="nm">{label}</span>
      )}
      {waiting && !on && <span className="wdot" aria-label="someone here is waiting" />}
      {canClose && !editing && (
        <button
          type="button"
          className="x"
          aria-label={`Close ${label}`}
          title="Close this workspace (its sessions keep running)"
          onClick={(e) => { e.stopPropagation(); useLayoutStore.getState().closeWorkspace(ws.id); }}
        >
          <X className="w-3 h-3" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

export function TitleBar() {
  const sessions = useAppStore((s) => s.sessions);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const openNextWaiting = useAppStore((s) => s.openNextWaiting);
  const workspaces = useLayoutStore((s) => s.workspaces);
  const activeId = useLayoutStore((s) => s.activeWorkspaceId);
  const home = useLayoutStore((s) => s.home);
  const layout = useLayoutStore((s) => s.layout);
  const panes = useLayoutStore((s) => s.panes);
  const stash = useLayoutStore((s) => s.stash);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebar = useUiStore((s) => s.sidebar);
  const openPalette = useUiStore((s) => s.openPalette);
  const [appearance, setAppearance] = useState(false);

  const homeOn = home;
  const byId = new Map(sessions.map((s) => [s.id, s] as const));
  const titleOf = (id: string) => { const s = byId.get(id); return s ? sessionTitle(s) : null; };
  const onActive = (serverId: string | null) => !serverId || serverId === activeServerId;
  const tabs = workspaces.map((w) => (w.id === activeId ? { ...w, layout, panes, stash, focusedPaneId } : w));
  const focused = panes.find((p) => p.id === focusedPaneId);
  const current = !homeOn && focused && onActive(focused.serverId) ? focused.sessionId : null;

  return (
    <header className="pl-tb">
      <IconButton label="Sidebar (Ctrl+Alt+B)" pressed={sidebar === 'expanded' && !homeOn} onClick={toggleSidebar} disabled={homeOn}>
        <PanelLeft className="w-4 h-4" strokeWidth={1.75} />
      </IconButton>
      <nav className="pl-tabs" role="tablist" aria-label="Workspaces">
        <div
          role="tab"
          tabIndex={0}
          aria-selected={homeOn}
          className={`pl-tab${homeOn ? ' on' : ''}`}
          title="Home: who needs you, then your profiles (Ctrl+Alt+H)"
          onClick={() => { useAppStore.getState().closeOverlay(); useLayoutStore.getState().showHome(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') useLayoutStore.getState().showHome(); }}
        >
          <House className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
          <span className="nm">Home</span>
        </div>
        {tabs.map((w) => {
          const shown = w.panes.slice(0, paneCountFor(w.layout));
          const waiting = shown.some((p) => p.sessionId && onActive(p.serverId) && byId.get(p.sessionId) && needsYou(byId.get(p.sessionId)!));
          const on = w.id === activeId && !homeOn;
          return (
            <WorkspaceTab key={w.id} ws={w} on={on} label={workspaceLabel(w, titleOf)} waiting={waiting} canClose={tabs.length > 1} />
          );
        })}
        <IconButton size="xs" label="New workspace" onClick={() => { useAppStore.getState().closeOverlay(); useLayoutStore.getState().addWorkspace(); }}>
          <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
        </IconButton>
      </nav>
      <div className="flex-1 min-w-0 flex justify-center">
        <button type="button" className="pl-paltrig" onClick={() => openPalette()} title="Search and commands (Ctrl+Shift+K)">
          <Search className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="grow">Jump to a session or run a command</span>
          <Kbd keys="Ctrl+Shift+K" />
        </button>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <UpdatePill inline />
        <WaitPill variant="desktop" sessions={sessions} currentId={current} onJump={() => openNextWaiting()} />
        {!homeOn && (
          <div className="flex items-center" role="group" aria-label="Layout">
            {LAYOUTS.map(({ id, label, Icon }) => (
              <IconButton
                key={id}
                size="xs"
                label={label}
                pressed={layout === id}
                onClick={() => useLayoutStore.getState().setLayout(id)}
                className="!w-7 !h-7"
              >
                <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
              </IconButton>
            ))}
          </div>
        )}
        <div className="relative">
          <IconButton label="Terminal appearance" pressed={appearance} onClick={() => setAppearance((v) => !v)}>
            <SlidersHorizontal className="w-4 h-4" strokeWidth={1.75} />
          </IconButton>
          {appearance && <TerminalSettings onClose={() => setAppearance(false)} />}
        </div>
      </div>
    </header>
  );
}
