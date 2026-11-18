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

