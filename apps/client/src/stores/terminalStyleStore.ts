/**
 * @file Terminal Style Store
 * @description User-tunable xterm appearance: font family, size, weight,
 *   and preset color themes. Persists to localStorage and applies live to
 *   every mounted TerminalPane without re-attaching the session.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type ThemeName =
  | 'persalink'
  | 'tokyo-night'
  | 'dracula'
  | 'one-dark'
  | 'solarized-dark'
  | 'nord'
  | 'gruvbox-dark'
  | 'monokai'
  | 'light';

export const THEMES: Record<ThemeName, { label: string; theme: XtermTheme }> = {
  'persalink': {
    label: 'PersaLink (default)',
    theme: {
      background: '#09090b', foreground: '#fafafa', cursor: '#fafafa',
      selectionBackground: 'rgba(255, 255, 255, 0.2)',
      black: '#18181b', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
      blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#fafafa',
      brightBlack: '#71717a', brightRed: '#f87171', brightGreen: '#4ade80',
      brightYellow: '#facc15', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
      brightCyan: '#22d3ee', brightWhite: '#ffffff',
    },
  },
  'tokyo-night': {
    label: 'Tokyo Night',
    theme: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5',
      selectionBackground: '#283457',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
      brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  'dracula': {
    label: 'Dracula',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  'one-dark': {
    label: 'One Dark',
    theme: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#abb2bf',
      selectionBackground: '#3e4451',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
      brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
      brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
  'solarized-dark': {
    label: 'Solarized Dark',
    theme: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  'nord': {
    label: 'Nord',
    theme: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  'gruvbox-dark': {
    label: 'Gruvbox Dark',
    theme: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2',
      selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
      brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
      brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  'monokai': {
    label: 'Monokai',
    theme: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
      brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  'light': {
    label: 'Light',
    theme: {
      background: '#fafafa', foreground: '#24292e', cursor: '#24292e',
      selectionBackground: 'rgba(0, 0, 0, 0.1)',
      black: '#24292e', red: '#d73a49', green: '#22863a', yellow: '#b08800',
      blue: '#0366d6', magenta: '#6f42c1', cyan: '#1b7c83', white: '#6a737d',
      brightBlack: '#959da5', brightRed: '#cb2431', brightGreen: '#28a745',
      brightYellow: '#dbab09', brightBlue: '#2188ff', brightMagenta: '#8a63d2',
      brightCyan: '#3192aa', brightWhite: '#24292e',
    },
  },
};

export type FontFamilyChoice =
  | 'cascadia' | 'jetbrains' | 'fira' | 'ibm-plex' | 'source-code-pro'
  | 'menlo' | 'consolas' | 'courier' | 'system';

// Variable fonts use the "<Name> Variable" family name that @fontsource-variable
// registers; fall back to the non-variable family name (for users who have it
// installed locally) and then to generic monospace.
export const FONT_FAMILIES: Record<FontFamilyChoice, { label: string; stack: string }> = {
  'cascadia':        { label: 'Cascadia Code',    stack: '"Cascadia Code Variable", "Cascadia Code", monospace' },
  'jetbrains':       { label: 'JetBrains Mono',   stack: '"JetBrains Mono Variable", "JetBrains Mono", monospace' },
  'fira':            { label: 'Fira Code',        stack: '"Fira Code Variable", "Fira Code", monospace' },
  'source-code-pro': { label: 'Source Code Pro',  stack: '"Source Code Pro Variable", "Source Code Pro", monospace' },
  'ibm-plex':        { label: 'IBM Plex Mono',    stack: '"IBM Plex Mono", monospace' },
  'menlo':           { label: 'Menlo',            stack: 'Menlo, Monaco, monospace' },
  'consolas':        { label: 'Consolas',         stack: 'Consolas, "Lucida Console", monospace' },
  'courier':         { label: 'Courier New',      stack: '"Courier New", Courier, monospace' },
  'system':          { label: 'System default',   stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
};

export type FontWeightChoice = '300' | '400' | '500' | '600';

/** Lines of tmux history to prefill into the xterm scrollback on attach.
 *  0 disables prefill (fastest, no risk of cursor corruption from PTY redraw). */
export const HISTORY_OPTIONS = [0, 500, 1000, 2000, 5000, 10000] as const;
export type HistoryOnAttach = typeof HISTORY_OPTIONS[number];

interface TerminalStyleState {
  fontFamily: FontFamilyChoice;
  fontSize: number;
  fontWeight: FontWeightChoice;
  theme: ThemeName;
  historyOnAttach: HistoryOnAttach;

  setFontFamily: (f: FontFamilyChoice) => void;
  setFontSize: (s: number) => void;
  setFontWeight: (w: FontWeightChoice) => void;
  setTheme: (t: ThemeName) => void;
  setHistoryOnAttach: (h: HistoryOnAttach) => void;
  reset: () => void;
}

/** Safe lookup — falls back to Cascadia if a stale persisted key is unknown. */
export function getFontStack(choice: FontFamilyChoice | string): string {
  return FONT_FAMILIES[choice as FontFamilyChoice]?.stack ?? FONT_FAMILIES.cascadia.stack;
}

/** Safe lookup — falls back to PersaLink default if a stale theme key is unknown. */
export function getTheme(name: ThemeName | string): XtermTheme {
  return THEMES[name as ThemeName]?.theme ?? THEMES.persalink.theme;
}

export const useTerminalStyleStore = create<TerminalStyleState>()(
  persist(
    (set) => ({
      fontFamily: 'cascadia',
      fontSize: 13,
      fontWeight: '400',
      theme: 'persalink',
      historyOnAttach: 0,

      setFontFamily: (fontFamily) => set({ fontFamily }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontWeight: (fontWeight) => set({ fontWeight }),
      setTheme: (theme) => set({ theme }),
      setHistoryOnAttach: (historyOnAttach) => set({ historyOnAttach }),
      reset: () => set({
        fontFamily: 'cascadia', fontSize: 13, fontWeight: '400',
        theme: 'persalink', historyOnAttach: 0,
      }),
    }),
    {
      name: 'persalink-terminal-style',
      // Sanitize any stale keys (e.g. 'hack' from older versions) on load.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!FONT_FAMILIES[state.fontFamily]) state.fontFamily = 'cascadia';
        if (!THEMES[state.theme]) state.theme = 'persalink';
      },
    }
  )
);
