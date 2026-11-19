/**
 * @file UI store
 * @description Window-level surfaces any screen can open: the command
 *   palette, the Keyboard shortcuts sheet, and the result sheet of a quick
 *   action run from the palette. Also the desktop shell's own state: the
 *   sidebar (expanded or rail, which groups and profile categories are
 *   folded; saved under the build's own key, so /beta/ never touches the
 *   live app's copy), the status-bar
 *   message slot, and each pane's size for the status bar. Kept apart from
 *   appStore so opening a surface never re-renders the session lists.
 */

import { create } from 'zustand';
import { persistName } from '../lib/platform';
import { isArchiveGroup } from '../lib/profileGroups';

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
export type SidebarGroup = 'active' | 'ended' | 'profiles' | 'servers';

/** Ended starts folded (a count only). */
const FOLD_DEFAULT: Record<SidebarGroup, boolean> = {
  active: false, ended: true, profiles: false, servers: false,
};

/** Is a profile category folded? Saved choice, else Archive starts folded. */
export function profileGroupFolded(folds: Record<string, boolean>, key: string, label: string): boolean {
  return folds[key] ?? isArchiveGroup(label);
}

/** One sentence in the desktop status bar ("Sent 'Yes' to Ops Suite"),
 *  with at most one action ("Stop"). */
export interface StatusMessage {
  id: number;
  text: string;
  action?: { label: string; title?: string; run: () => void };
  /** How long it stays, ms. */
  ttl: number;
}

const SIDEBAR_KEY = persistName('persalink-sidebar-v2');
/** The first desktop sidebar's key (unsuffixed even on /beta/; read only). */
const LEGACY_SIDEBAR_KEY = 'persalink-sidebar';

interface SidebarSaved { mode: SidebarMode; folded: Record<SidebarGroup, boolean>; profileFolds: Record<string, boolean> }

function readSidebar(): SidebarSaved {
  try {
    type Saved = { mode?: string; folded?: Partial<Record<SidebarGroup, boolean>>; profileFolds?: Record<string, boolean> };
    const cur = localStorage.getItem(SIDEBAR_KEY);
    // From the first sidebar only the mode carries over (its groups were renamed).
    const raw: Saved | null = cur
      ? JSON.parse(cur) as Saved
      : { mode: (JSON.parse(localStorage.getItem(LEGACY_SIDEBAR_KEY) || 'null') as Saved | null)?.mode };
    return {
      mode: raw?.mode === 'rail' ? 'rail' : 'expanded',
      folded: { ...FOLD_DEFAULT, ...(raw?.folded ?? {}) },
      profileFolds: { ...(raw?.profileFolds ?? {}) },
    };
  } catch {
    return { mode: 'expanded', folded: { ...FOLD_DEFAULT }, profileFolds: {} };
  }
}

function writeSidebar(saved: SidebarSaved): void {
  try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify(saved)); } catch { /* per-viewer nicety only */ }
}

const initialSidebar = readSidebar();
let statusSeq = 0;

interface UiState {
  sidebar: SidebarMode;
  folded: Record<SidebarGroup, boolean>;
  /** Profile categories the person folded or unfolded, by group key. */
  profileFolds: Record<string, boolean>;
  status: StatusMessage | null;
  /** cols x rows per desktop pane, for the status bar. */
  paneDims: Record<string, { cols: number; rows: number }>;
  toggleSidebar: () => void;
  toggleGroup: (g: SidebarGroup) => void;
  /** Fold or unfold a profile category (key from lib/profileGroups). */
  toggleProfileGroup: (key: string, label: string) => void;
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
  profileFolds: initialSidebar.profileFolds,
  status: null,
  paneDims: {},
  toggleSidebar: () => {
    const sidebar: SidebarMode = get().sidebar === 'rail' ? 'expanded' : 'rail';
    writeSidebar({ mode: sidebar, folded: get().folded, profileFolds: get().profileFolds });
    set({ sidebar });
  },
  toggleGroup: (g) => {
    const folded = { ...get().folded, [g]: !get().folded[g] };
    writeSidebar({ mode: get().sidebar, folded, profileFolds: get().profileFolds });
    set({ folded });
  },
  toggleProfileGroup: (key, label) => {
    const cur = get().profileFolds;
    const profileFolds = { ...cur, [key]: !profileGroupFolded(cur, key, label) };
    writeSidebar({ mode: get().sidebar, folded: get().folded, profileFolds });
    set({ profileFolds });
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
