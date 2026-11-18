/**
 * @file Keymap
 * @description Every keyboard shortcut in one place: the lists the Keyboard
 *   shortcuts sheet shows (desktop, and a phone with a hardware keyboard),
 *   the chord the palette shows next to an action on desktop, and the pure
 *   matchers the window-level key hooks use. Phone keys are invisible
 *   accelerators: every action is also a tap, and no keycap is drawn on a
 *   phone. Matching uses e.key (the character the keyboard produced), not
 *   e.code, so a symbol typed through an Alt or AltGr layer (the Titan's
 *   Alt+M gives ".") is never taken as a shortcut; only a chord that
 *   produced the plain letter is.
 */

export type KeyAction =
  | 'palette'
  | 'next-waiting'
  | 'prev-session'
  | 'next-session'
  | 'composer'
  | 'copy-claude'
  | 'links'
  | 'upload'
  | 'home'
  | 'files'
  | 'settings'
  | 'shortcuts'
  | 'sidebar';

export interface KeyRow { keys: string; action: string }

/** Desktop map (Cmd replaces Ctrl on macOS). */
export const DESKTOP_KEYS: readonly KeyRow[] = [
  { keys: 'Ctrl+Shift+K', action: 'Command palette (Ctrl+K outside the terminal)' },
  { keys: 'Ctrl+Alt+J', action: 'Next agent waiting for you' },
  { keys: '1-9', action: 'Answer the waiting agent (focus outside the terminal)' },
  { keys: 'Ctrl+Alt+← / →', action: 'Previous / next session in this pane' },
  { keys: 'Ctrl+Alt+1-9', action: 'Jump to session 1-9 in this pane' },
  { keys: 'Ctrl+Alt+T', action: 'Open or start a session in this pane' },
  { keys: 'Ctrl+Alt+H', action: 'Home: who needs you' },
  { keys: 'Ctrl+Alt+B', action: 'Sidebar: expanded or rail' },
  { keys: 'Ctrl+Shift+M', action: 'Write a message in a text box' },
  { keys: 'Ctrl+Shift+Y', action: 'Copy from Claude' },
  { keys: 'Ctrl+Shift+L', action: 'Links in this session' },
  { keys: 'Ctrl+Alt+F', action: 'Files' },
  { keys: 'Ctrl+Alt+,', action: 'Settings' },
  { keys: 'Ctrl+Shift+/', action: 'Keyboard shortcuts' },
  { keys: 'Ctrl+C', action: 'Copy selection, cleaned of indents and wraps (no selection: interrupt)' },
  { keys: 'Ctrl+Shift+C', action: 'Copy selection exactly as shown' },
  { keys: 'Ctrl+V', action: 'Paste' },
  { keys: 'Ctrl+click', action: 'Open a link' },
  { keys: 'Shift+drag', action: 'Select text inside Claude and other mouse apps' },
  { keys: 'Ctrl+Tab', action: 'Next session, when installed as an app' },
];

/** A phone with a hardware keyboard (the Titan 2). */
export const PHONE_KEYS: readonly KeyRow[] = [
  { keys: 'Alt+K', action: 'Command palette' },
  { keys: 'Alt+J', action: 'Next agent waiting for you' },
  { keys: '1-9', action: 'Answer the waiting agent (focus outside the terminal)' },
  { keys: 'Alt+[ / ]', action: 'Previous / next session' },
  { keys: 'Alt+M', action: 'Write a message' },
  { keys: 'Alt+Y', action: 'Copy from Claude' },
  { keys: 'Alt+U', action: 'Upload a file' },
  { keys: 'Alt+H', action: 'Home' },
];

/** The chord the palette shows beside an action, desktop only. */
export const DESKTOP_CHORD: Partial<Record<KeyAction, string>> = {
  'palette': 'Ctrl+Shift+K',
  'next-waiting': 'Ctrl+Alt+J',
  'composer': 'Ctrl+Shift+M',
  'copy-claude': 'Ctrl+Shift+Y',
  'links': 'Ctrl+Shift+L',
  'files': 'Ctrl+Alt+F',
  'settings': 'Ctrl+Alt+,',
  'shortcuts': 'Ctrl+Shift+/',
  'home': 'Ctrl+Alt+H',
  'sidebar': 'Ctrl+Alt+B',
};

/** The parts of a KeyboardEvent the matchers read (testable without a DOM). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const lower = (e: KeyLike) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

/** A digit 1-9 with no modifier: an answer to a numbered prompt. */
export function answerDigit(e: KeyLike): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  return /^[1-9]$/.test(e.key) ? e.key : null;
}

/**
 * Window-level shortcuts that work on every desktop screen. `inTerminal` is
 * whether a terminal has keyboard focus: plain Ctrl+K stays readline's
 * kill-line there, and opens the palette everywhere else.
 */
export function desktopAction(e: KeyLike, inTerminal: boolean): KeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = lower(e);
  if (mod && e.shiftKey && !e.altKey && k === 'k') return 'palette';
  if (mod && !e.shiftKey && !e.altKey && k === 'k' && !inTerminal) return 'palette';
  if (e.ctrlKey && e.altKey && !e.shiftKey && k === 'j') return 'next-waiting';
  if (e.ctrlKey && e.altKey && !e.shiftKey && k === 'f') return 'files';
  if (e.ctrlKey && e.altKey && !e.shiftKey && k === ',') return 'settings';
  if (e.ctrlKey && e.altKey && !e.shiftKey && k === 'b') return 'sidebar';
  if (e.ctrlKey && e.altKey && !e.shiftKey && k === 'h') return 'home';
  if (mod && e.shiftKey && !e.altKey && (e.code === 'Slash' || k === '?' || k === '/')) return 'shortcuts';
  return null;
}

/**
 * A phone with a hardware keyboard: the Alt set, plus the desktop palette and
 * next-waiting chords for a full keyboard plugged into a phone.
 */
export function phoneAction(e: KeyLike): KeyAction | null {
  const k = lower(e);
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    switch (k) {
      case 'k': return 'palette';
      case 'j': return 'next-waiting';
      case 'm': return 'composer';
      case 'y': return 'copy-claude';
      case 'u': return 'upload';
      case 'h': return 'home';
    }
    // Brackets need the bracket key itself: a symbol layer that happens to
    // produce "[" from a letter key must still type it.
    if ((k === '[' || k === '{') && e.code === 'BracketLeft') return 'prev-session';
    if ((k === ']' || k === '}') && e.code === 'BracketRight') return 'next-session';
    return null;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && !e.altKey && k === 'k') return 'palette';
  if (e.ctrlKey && e.altKey && !e.shiftKey && k === 'j') return 'next-waiting';
  return null;
}
