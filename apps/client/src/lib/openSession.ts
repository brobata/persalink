/**
 * @file Open a session or start a profile, wherever you are
 * @description The one rule every list uses (palette, desktop sidebar,
 *   desktop Home): on desktop, a session already showing in a pane gets the
 *   focus, otherwise it goes into the focused pane, and any right panel
 *   (Settings, Files, the profile editor) closes so the click visibly lands;
 *   on a phone, the terminal attaches it. Another server's session on a
 *   phone switches to that server, which then opens it.
 */

import { useAppStore } from '../stores/appStore';
import { useLayoutStore } from '../stores/layoutStore';
import { deviceKind } from './device';
import { getInitialDims } from './terminalDims';
import { currentTerminal, sendPaneCommand } from './paneCommands';

/** Open a session wherever you are: the focused pane on desktop (or the pane
 *  already showing it), the terminal on a phone. Another server's session on
 *  a phone switches to that server, which then opens it. */
export function openSession(id: string, serverId: string | null): void {
  const app = useAppStore.getState();
  const onActive = !serverId || serverId === app.activeServerId;
  if (deviceKind() === 'desktop') {
    const layout = useLayoutStore.getState();
    const boundTo = (p: { serverId: string | null }) => p.serverId ?? app.activeServerId;
    const shown = layout.panes.find((p) => p.sessionId === id && boundTo(p) === (serverId ?? app.activeServerId));
    if (shown) layout.setFocusedPane(shown.id);
    else layout.assignSession(layout.focusedPaneId, id, serverId ?? app.activeServerId);
    app.closeOverlay();
    return;
  }
  if (onActive) {
    app.attachSession(id);
    return;
  }
  app.selectServer(serverId!);
  // The cold open after sign-in lands on the last session when it is recent.
  useAppStore.setState({ lastActiveSessionId: id, lastActiveAt: Date.now() });
}

export function startProfile(profileId: string): void {
  const app = useAppStore.getState();
  if (deviceKind() === 'desktop') {
    const layout = useLayoutStore.getState();
    layout.markPendingAssign(layout.focusedPaneId);
    app.createSession(profileId);
    app.closeOverlay();
    return;
  }
  const { cols, rows } = getInitialDims();
  app.createSession(profileId, cols, rows);
}


/**
 * Open a session with the composer up, to answer in your own words (the
 * reply chip and "No, explain" on a Needs-you card). The composer belongs
 * to the terminal, which exists only once the session is open, so the
 * command is retried briefly until a terminal takes it.
 */
export function openSessionToReply(id: string): void {
  openSession(id, null);
  let tries = 0;
  const attempt = () => {
    tries++;
    const app = useAppStore.getState();
    const ready = deviceKind() === 'desktop' || (app.view === 'terminal' && app.attachedSession?.id === id);
    if (ready && sendPaneCommand(currentTerminal(), 'composer')) return;
    if (tries < 12) setTimeout(attempt, 150);
  };
  setTimeout(attempt, 120);
}
