/**
 * @file Pane commands
 * @description Keyboard shortcuts and the command palette are caught once at
 *   the window level, but most of what they do acts on one terminal's own
 *   state: its socket, its xterm, its sheets. They dispatch a command for
 *   the current terminal; each TerminalPane (desktop) and the phone
 *   TerminalScreen listen for commands addressed to them. The phone
 *   terminal's address is PHONE_TERMINAL.
 */

import { useLayoutStore } from '../stores/layoutStore';
import { isDesktopViewport } from './platform';

export const PANE_COMMAND_EVENT = 'persalink:pane-command';

/** The address of the single terminal on a phone. */
export const PHONE_TERMINAL = 'phone';

export type PaneCommand =
  | 'composer'
  | 'links'
  | 'claude'
  | 'upload'
  /** Type `data` into the terminal (no Enter). */
  | 'insert'
  /** Answer the prompt on screen with option `data` ("1", "2", ...). */
  | 'answer'
  | 'snippets'
  | 'find'
  | 'terminal-settings';

export interface PaneCommandDetail {
  paneId: string;
  command: PaneCommand;
  data?: string;
}

/**
 * Dispatch a command. Returns true when a terminal took it: listeners call
 * preventDefault() on the event once they acted (the event is synchronous),
 * so a caller can tell "answered" from "nobody was there to answer".
 */
export function sendPaneCommand(paneId: string, command: PaneCommand, data?: string): boolean {
  const ev = new CustomEvent<PaneCommandDetail>(PANE_COMMAND_EVENT, { detail: { paneId, command, data }, cancelable: true });
  return !window.dispatchEvent(ev);
}

/** The terminal a window-level command goes to: the focused pane on desktop,
 *  the phone terminal otherwise. */
export function currentTerminal(): string {
  return isDesktopViewport() ? useLayoutStore.getState().focusedPaneId : PHONE_TERMINAL;
}

/** True when keyboard focus is inside a terminal (xterm's input). */
export function terminalHasFocus(target: EventTarget | null = document.activeElement): boolean {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea');
}
