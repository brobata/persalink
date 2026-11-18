/**
 * @file Layout Store
 * @description Desktop pane state. The live workspace's layout (single /
 *   split / 2x2), which session each pane shows and which pane has keyboard
 *   focus sit at the top level, so every consumer reads them as before.
 *   Other workspaces (the title-bar tabs) are kept as snapshots in
 *   `workspaces` and swapped in on switch. `home` is the desktop Home tab
 *   (the summary of who needs you); assigning or focusing a pane leaves it.
 *   Each TerminalPane reads its slot here and owns its own WebSocket + xterm.
 *   The pure rules live in lib/workspaces.ts.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistName } from '../lib/platform';
import {
  clearWhere, dedupePanes, dropWhere, newWorkspaceId, reshape,
  type Layout, type PaneSlot, type Workspace,
} from '../lib/workspaces';

export type { Layout, PaneSlot, Workspace } from '../lib/workspaces';

interface LayoutState {
  layout: Layout;
  panes: PaneSlot[];
  focusedPaneId: string;
  /** Assigned panes the current layout has no room for (see lib/workspaces). */
  stash: PaneSlot[];
  /** Every workspace, the active one included (its entry is refreshed on switch). */
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /** The desktop Home tab is showing instead of the panes. */
  home: boolean;
  /** Pane id waiting for the next newly-created session to be routed into it. */
  pendingAssignPaneId: string | null;

  setLayout: (layout: Layout) => void;
  setFocusedPane: (id: string) => void;
  assignSession: (paneId: string, sessionId: string, serverId?: string | null) => void;
  clearPane: (paneId: string) => void;
  /** Vacate every pane currently holding this session ON this server (session
   *  names collide across servers — pl-claude exists on every box). */
  clearSession: (sessionId: string, serverId?: string | null) => void;
  /** Drop any pane assignment whose session is no longer live ON the given
   *  server, in every workspace. Panes bound to other servers are none of
   *  this list's business — their own sockets receive their own sessions.list. */
  reconcile: (liveSessionIds: string[], serverId?: string | null) => void;
  /** Put a newly created session into the focused pane (or first empty). */
  autoAssign: (sessionId: string) => void;
  /** Mark a pane to receive the next newly-created session. */
  markPendingAssign: (paneId: string) => void;
  clearPendingAssign: () => void;

  showHome: () => void;
  showPanes: () => void;
  switchWorkspace: (id: string) => void;
  /** A new empty workspace (one pane), made active. */
  addWorkspace: () => void;
  renameWorkspace: (id: string, name: string) => void;
  /** Close a workspace (never the last one). */
  closeWorkspace: (id: string) => void;
}

const FIRST: Workspace = {
  id: 'ws-1',
  name: null,
  layout: 'single',
  panes: [{ id: 'pane-0', sessionId: null, serverId: null }],
  focusedPaneId: 'pane-0',
  stash: [],
};

/** The live workspace as a snapshot. */
function live(s: Pick<LayoutState, 'activeWorkspaceId' | 'workspaces' | 'layout' | 'panes' | 'focusedPaneId' | 'stash'>): Workspace {
  const meta = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  return {
    id: s.activeWorkspaceId,
    name: meta?.name ?? null,
    layout: s.layout,
    panes: s.panes,
    focusedPaneId: s.focusedPaneId,
    stash: s.stash,
  };
}

/** Write the live workspace back into the list. */
function synced(s: LayoutState): Workspace[] {
  const cur = live(s);
  return s.workspaces.some((w) => w.id === cur.id)
    ? s.workspaces.map((w) => (w.id === cur.id ? cur : w))
    : [...s.workspaces, cur];
}

function load(ws: Workspace) {
  return { activeWorkspaceId: ws.id, layout: ws.layout, panes: ws.panes, focusedPaneId: ws.focusedPaneId, stash: ws.stash };
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      layout: FIRST.layout,
      panes: FIRST.panes,
      focusedPaneId: FIRST.focusedPaneId,
      stash: [],
      workspaces: [FIRST],
      activeWorkspaceId: FIRST.id,
      home: false,
      pendingAssignPaneId: null,

      setLayout: (layout) => set((state) => {
        const { panes, stash } = reshape(layout, state.panes, state.stash);
        const focusedPaneId = panes.some((p) => p.id === state.focusedPaneId) ? state.focusedPaneId : panes[0].id;
        return { layout, panes, stash, focusedPaneId, home: false };
      }),

      setFocusedPane: (id) => set({ focusedPaneId: id, home: false }),

      assignSession: (paneId, sessionId, serverId = null) => set((state) => ({
        // Move (not copy) — if this (server, session) pair was in another
        // pane, vacate it first. Two xterm clients on one tmux session fight
        // over resize and produce corrupted output. Same name on a DIFFERENT
        // server is a different session and may stay.
        panes: state.panes.map((p) => {
          if (p.id === paneId) return { ...p, sessionId, serverId };
          if (p.sessionId === sessionId && (p.serverId ?? serverId) === (serverId ?? p.serverId)) {
            return { ...p, sessionId: null };
          }
          return p;
        }),
        stash: state.stash.filter((p) => !(p.sessionId === sessionId && (p.serverId ?? serverId) === (serverId ?? p.serverId))),
        focusedPaneId: paneId,
        home: false,
      })),

      clearPane: (paneId) => set((state) => ({
        panes: state.panes.map((p) => (p.id === paneId ? { ...p, sessionId: null } : p)),
      })),

      clearSession: (sessionId, serverId = null) => set((state) => {
        // Legacy panes (serverId null) are active-server panes — they match.
        const dead = (p: PaneSlot) => p.sessionId === sessionId && (p.serverId ?? serverId) === serverId;
        return sweep(state, dead);
      }),

      reconcile: (liveSessionIds, serverId = null) => set((state) => {
        const alive = new Set(liveSessionIds);
        // A pane is subject to this list only if it's bound to this server
        // (or is a legacy null-server pane, which follows the active server).
        const dead = (p: PaneSlot) => !!p.sessionId && (p.serverId ?? serverId) === serverId && !alive.has(p.sessionId);
        return sweep(state, dead);
      }),

      autoAssign: (sessionId) => set((state) => {
        const focused = state.panes.find((p) => p.id === state.focusedPaneId);
        const targetId = focused && !focused.sessionId
          ? focused.id
          : (state.panes.find((p) => !p.sessionId)?.id ?? state.focusedPaneId);
        return {
          panes: state.panes.map((p) => (p.id === targetId ? { ...p, sessionId } : p)),
          focusedPaneId: targetId,
        };
      }),

      markPendingAssign: (paneId) => set({ pendingAssignPaneId: paneId }),
      clearPendingAssign: () => set({ pendingAssignPaneId: null }),

      showHome: () => set({ home: true }),
      showPanes: () => set({ home: false }),

      switchWorkspace: (id) => {
        const state = get();
        if (id === state.activeWorkspaceId) { set({ home: false }); return; }
        const workspaces = synced(state);
        const target = workspaces.find((w) => w.id === id);
        if (!target) return;
        set({ workspaces, ...load(target), home: false });
      },

      addWorkspace: () => {
        const state = get();
        const workspaces = synced(state);
        const ws: Workspace = { ...FIRST, id: newWorkspaceId(workspaces.map((w) => w.id)), panes: [...FIRST.panes] };
        set({ workspaces: [...workspaces, ws], ...load(ws), home: false });
      },

      renameWorkspace: (id, name) => set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, name: name.trim() || null } : w)),
      })),

      closeWorkspace: (id) => {
        const state = get();
        const workspaces = synced(state);
        if (workspaces.length <= 1) return;
        const i = workspaces.findIndex((w) => w.id === id);
        if (i < 0) return;
        const rest = workspaces.filter((w) => w.id !== id);
        if (id !== state.activeWorkspaceId) { set({ workspaces: rest }); return; }
        const next = rest[Math.max(0, i - 1)];
        set({ workspaces: rest, ...load(next) });
      },
    }),
    {
      name: persistName('persalink-layout'),
      partialize: (state) => ({
        layout: state.layout,
        panes: state.panes,
        focusedPaneId: state.focusedPaneId,
        stash: state.stash,
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
      }),
      // Sanitize on rehydrate: a pane assignment race in a previous session
      // could leave duplicate sessionIds across panes. Two panes attached to
      // the same tmux session both receive output and confuse the user (one
      // looks doubled). Keep the first occurrence; clear the rest. A layout
      // saved before workspaces existed becomes the first workspace. The
      // layout you chose (a four-pane grid too) and the tab order reopen as
      // saved.
      onRehydrateStorage: () => (state) => {
        if (!state?.panes) return;
        const panes = dedupePanes(state.panes);
        const focusedPaneId = panes.some((p) => p.id === state.focusedPaneId) ? state.focusedPaneId : panes[0]?.id ?? 'pane-0';
        const activeId = state.activeWorkspaceId || FIRST.id;
        const named = (state.workspaces ?? []).find((w) => w.id === activeId)?.name ?? null;
        const cur: Workspace = { id: activeId, name: named, layout: state.layout, panes, focusedPaneId, stash: state.stash ?? [] };
        const workspaces = (state.workspaces ?? []).map((w) => (w.id === activeId
          ? cur
          : { ...w, panes: dedupePanes(w.panes ?? []), stash: w.stash ?? [] }));
        if (!workspaces.some((w) => w.id === activeId)) workspaces.unshift(cur);
        Object.assign(state, load(cur), {
          workspaces,
          // Nothing on screen anywhere: open on Home rather than an empty pane.
          home: !cur.panes.some((p) => p.sessionId),
        });
      },
    }
  )
);

/** Apply a dead-pane rule to the live panes, the stash and every other
 *  workspace's snapshot. */
function sweep(state: LayoutState, dead: (p: PaneSlot) => boolean): Partial<LayoutState> | LayoutState {
  const panes = clearWhere(state.panes, dead);
  const stash = dropWhere(state.stash, dead);
  let wsChanged = false;
  const workspaces = state.workspaces.map((w) => {
    if (w.id === state.activeWorkspaceId) return w;
    const p = clearWhere(w.panes, dead);
    const st = dropWhere(w.stash ?? [], dead);
    if (p === w.panes && st === w.stash) return w;
    wsChanged = true;
    return { ...w, panes: p, stash: st };
  });
  if (panes === state.panes && stash === state.stash && !wsChanged) return state;
  return { panes, stash, workspaces };
}
