/**
 * @file UI store
 * @description Window-level surfaces any screen can open: the command
 *   palette, the Keyboard shortcuts sheet, and the result sheet of a quick
 *   action run from the palette. Also the desktop shell's own state: the
 *   sidebar (expanded or rail, and which groups are folded), the status-bar
 *   message slot, and each pane's size for the status bar. Kept apart from
 *   appStore so opening a surface never re-renders the session lists.
 */

import { create } from 'zustand';

export interface QuickRun {
  profileId: string;
  actionId: string;
  /** "Ops Suite: Deploy" */
  title: string;
  command: string;
  /** The action asks before it runs (QuickAction.confirm); Run again asks too. */
  confirm?: boolean;
  startedAt: number;
}

export type SidebarMode = 'expanded' | 'rail';
/** Sidebar groups that fold. */
export type SidebarGroup = 'needs' | 'working' | 'quiet' | 'ended' | 'profiles' | 'servers';

/** Quiet, Ended and Profiles start folded (a count only). */
const FOLD_DEFAULT: Record<SidebarGroup, boolean> = {
  needs: false, working: false, quiet: true, ended: true, profiles: true, servers: false,
};

/** One sentence in the desktop status bar ("Sent 'Yes' to Ops Suite"),
 *  with at most one action ("Stop"). */
export interface StatusMessage {
  id: number;
  text: string;
  action?: { label: string; title?: string; run: () => void };
  /** How long it stays, ms. */
  ttl: number;
}

const SIDEBAR_KEY = 'persalink-sidebar';

function readSidebar(): { mode: SidebarMode; folded: Record<SidebarGroup, boolean> } {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDEBAR_KEY) || 'null') as { mode?: string; folded?: Partial<Record<SidebarGroup, boolean>> } | null;
    return {
      mode: raw?.mode === 'rail' ? 'rail' : 'expanded',
      folded: { ...FOLD_DEFAULT, ...(raw?.folded ?? {}) },
    };
  } catch {
    return { mode: 'expanded', folded: { ...FOLD_DEFAULT } };
  }
}

function writeSidebar(mode: SidebarMode, folded: Record<SidebarGroup, boolean>): void {
  try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ mode, folded })); } catch { /* per-viewer nicety only */ }
}

const initialSidebar = readSidebar();
let statusSeq = 0;

interface UiState {
  sidebar: SidebarMode;
  folded: Record<SidebarGroup, boolean>;
  status: StatusMessage | null;
  /** cols x rows per desktop pane, for the status bar. */
  paneDims: Record<string, { cols: number; rows: number }>;
  toggleSidebar: () => void;
  toggleGroup: (g: SidebarGroup) => void;
  /** Say one sentence in the status bar (desktop). */
  say: (text: string, opts?: { action?: StatusMessage['action']; ttl?: number }) => void;
  clearStatus: (id?: number) => void;
  setPaneDims: (paneId: string, cols: number, rows: number) => void;
  paletteOpen: boolean;
  /** Text the palette opens with. */
  paletteQuery: string;
  shortcutsOpen: boolean;
  quickRun: QuickRun | null;
  openPalette: (query?: string) => void;
  closePalette: () => void;
  togglePalette: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  setQuickRun: (run: QuickRun | null) => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  sidebar: initialSidebar.mode,
  folded: initialSidebar.folded,
  status: null,
  paneDims: {},
  toggleSidebar: () => {
    const sidebar: SidebarMode = get().sidebar === 'rail' ? 'expanded' : 'rail';
    writeSidebar(sidebar, get().folded);
    set({ sidebar });
  },
  toggleGroup: (g) => {
    const folded = { ...get().folded, [g]: !get().folded[g] };
    writeSidebar(get().sidebar, folded);
    set({ folded });
  },
  say: (text, opts = {}) => set({ status: { id: ++statusSeq, text, action: opts.action, ttl: opts.ttl ?? 5000 } }),
  clearStatus: (id) => { if (id === undefined || get().status?.id === id) set({ status: null }); },
  setPaneDims: (paneId, cols, rows) => {
    const cur = get().paneDims[paneId];
    if (cur && cur.cols === cols && cur.rows === rows) return;
    set({ paneDims: { ...get().paneDims, [paneId]: { cols, rows } } });
  },
  paletteOpen: false,
  paletteQuery: '',
  shortcutsOpen: false,
  quickRun: null,
  openPalette: (query = '') => set({ paletteOpen: true, paletteQuery: query, shortcutsOpen: false }),
  closePalette: () => set({ paletteOpen: false, paletteQuery: '' }),
  togglePalette: () => (get().paletteOpen ? get().closePalette() : get().openPalette()),
  openShortcuts: () => set({ shortcutsOpen: true, paletteOpen: false }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  setQuickRun: (quickRun) => set({ quickRun }),
}));
