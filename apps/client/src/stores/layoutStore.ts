/**
 * @file Layout Store
 * @description Grid layout state for desktop multi-pane view. Tracks layout
 *   mode (single / split / 2x2), which sessionId is in each pane slot, and
 *   which pane currently has keyboard focus. Each TerminalPane component
 *   reads its slot here and owns its own WebSocket + xterm instance.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Layout = 'single' | 'split-h' | 'split-v' | '2x2';

export interface PaneSlot {
  id: string;
  sessionId: string | null;
}

interface LayoutState {
  layout: Layout;
  panes: PaneSlot[];
  focusedPaneId: string;
  /** Pane id waiting for the next newly-created session to be routed into it. */
  pendingAssignPaneId: string | null;

  setLayout: (layout: Layout) => void;
  setFocusedPane: (id: string) => void;
  assignSession: (paneId: string, sessionId: string) => void;
  clearPane: (paneId: string) => void;
  /** Put a newly created session into the focused pane (or first empty). */
  autoAssign: (sessionId: string) => void;
  /** Mark a pane to receive the next newly-created session. */
  markPendingAssign: (paneId: string) => void;
  clearPendingAssign: () => void;
}

function paneCountFor(layout: Layout): number {
  if (layout === 'single') return 1;
  if (layout === '2x2') return 4;
  return 2;
}

function reshapePanes(count: number, existing: PaneSlot[]): PaneSlot[] {
  const result: PaneSlot[] = [];
  for (let i = 0; i < count; i++) {
    result.push(existing[i] ?? { id: `pane-${i}`, sessionId: null });
  }
  return result;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      layout: 'single',
      panes: [{ id: 'pane-0', sessionId: null }],
      focusedPaneId: 'pane-0',
      pendingAssignPaneId: null,

      setLayout: (layout) => set((state) => {
        const panes = reshapePanes(paneCountFor(layout), state.panes);
        const focusedPaneId = panes.some(p => p.id === state.focusedPaneId)
          ? state.focusedPaneId
          : panes[0].id;
        return { layout, panes, focusedPaneId };
      }),

      setFocusedPane: (id) => set({ focusedPaneId: id }),

      assignSession: (paneId, sessionId) => set((state) => ({
        // Move (not copy) — if this session was in another pane, vacate it
        // first. Two xterm clients on one tmux session fight over resize and
        // produce corrupted output.
        panes: state.panes.map(p => {
          if (p.id === paneId) return { ...p, sessionId };
          if (p.sessionId === sessionId) return { ...p, sessionId: null };
          return p;
        }),
        focusedPaneId: paneId,
      })),

      clearPane: (paneId) => set((state) => ({
        panes: state.panes.map(p => (p.id === paneId ? { ...p, sessionId: null } : p)),
      })),

      autoAssign: (sessionId) => set((state) => {
        const focused = state.panes.find(p => p.id === state.focusedPaneId);
        const targetId = focused && !focused.sessionId
          ? focused.id
          : (state.panes.find(p => !p.sessionId)?.id ?? state.focusedPaneId);
        return {
          panes: state.panes.map(p => (p.id === targetId ? { ...p, sessionId } : p)),
          focusedPaneId: targetId,
        };
      }),

      markPendingAssign: (paneId) => set({ pendingAssignPaneId: paneId }),
      clearPendingAssign: () => set({ pendingAssignPaneId: null }),
    }),
    {
      name: 'persalink-layout',
      partialize: (state) => ({ layout: state.layout, panes: state.panes }),
      // Sanitize on rehydrate: a pane assignment race in a previous session
      // could leave duplicate sessionIds across panes. Two panes attached to
      // the same tmux session both receive output and confuse the user (one
      // looks doubled). Keep the first occurrence; clear the rest.
      onRehydrateStorage: () => (state) => {
        if (!state?.panes) return;
        const seen = new Set<string>();
        state.panes = state.panes.map(p => {
          if (!p.sessionId) return p;
          if (seen.has(p.sessionId)) return { ...p, sessionId: null };
          seen.add(p.sessionId);
          return p;
        });
      },
    }
  )
);
