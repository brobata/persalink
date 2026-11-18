/**
 * @file UI store
 * @description Window-level surfaces any screen can open: the command
 *   palette, the Keyboard shortcuts sheet, and the result sheet of a quick
 *   action run from the palette. Kept apart from appStore so opening a
 *   surface never re-renders the session lists.
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

interface UiState {
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
