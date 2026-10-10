/**
 * @file Pane commands
 * @description Desktop keyboard shortcuts are caught once at the window level
 *   (GridLayout), but most act on one pane's own state — its socket, its
 *   xterm, its dropdowns. The shortcut handler dispatches a command event for
 *   the focused pane; each TerminalPane listens for commands addressed to it.
 */

export const PANE_COMMAND_EVENT = 'persalink:pane-command';

export type PaneCommand = 'composer' | 'links' | 'claude';

export interface PaneCommandDetail {
  paneId: string;
  command: PaneCommand;
}

export function sendPaneCommand(paneId: string, command: PaneCommand): void {
  window.dispatchEvent(new CustomEvent<PaneCommandDetail>(PANE_COMMAND_EVENT, { detail: { paneId, command } }));
}
