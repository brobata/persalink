/**
 * @file GridLayout
 * @description Desktop pane grid. Renders the live workspace's panes
 *   (single, split or 2x2) with 1px hairline gutters, tracks focus, and
 *   shows a session picker when an empty pane is filled. With a right panel
 *   open (Settings, Files, the profile editor; `panel`), the focused pane
 *   keeps the space and every other pane collapses to its 28px strip, still
 *   live; clicking a strip brings that pane up. The title bar and status bar
 *   live in components/desktop.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore, type ServerEntry } from '../stores/appStore';
import { useLayoutStore, type Layout } from '../stores/layoutStore';
import { TerminalPane } from './TerminalPane';
import { SessionRow } from './ui/SessionRow';
import { ProfileTile } from './ui/ProfileTile';
import { useDesktopShortcuts } from './ShortcutsPanel';
import { orderSessions } from '../lib/sessionOrder';
import { remoteSnapshot, remoteCreateSession, resolveEntryHost } from '../lib/remoteServer';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';

function SessionPicker({
  onPick, onClose, onCreateFromProfile,
}: {
  onPick: (sessionId: string, serverId: string | null) => void;
  onClose: () => void;
  onCreateFromProfile: (profileId: string, serverId: string | null) => void;
}) {
  const activeProfiles = useAppStore(s => s.profiles);
  const activeSessions = useAppStore(s => s.sessions);
  const servers = useAppStore(s => s.servers);
  const activeServerId = useAppStore(s => s.activeServerId);

  // Which server this pane should draw from. Active server reads the live
  // store; any other saved server gets a one-shot snapshot over a throwaway
  // socket (see lib/remoteServer.ts).
  const [pickServerId, setPickServerId] = useState<string | null>(activeServerId);
  const [remote, setRemote] = useState<{ sessions: SessionInfo[]; profiles: Profile[] } | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const isActivePick = pickServerId === activeServerId;

  useEffect(() => {
    setRemote(null);
    setRemoteError(null);
    if (isActivePick) return;
    const entry = servers.find(e => e.id === pickServerId);
    if (!entry) return;
    let cancelled = false;
    remoteSnapshot(entry)
      .then((snap) => { if (!cancelled) setRemote(snap); })
      .catch((err: Error) => {
        if (cancelled) return;
        setRemoteError(
          err.message === 'no-token' || err.message === 'auth'
            ? 'No saved login for this server — switch to it once from the Servers screen to sign in.'
            : 'Could not reach this server.'
        );
      });
    return () => { cancelled = true; };
  }, [pickServerId, isActivePick, servers]);

  const sessions = isActivePick ? activeSessions : (remote?.sessions ?? []);
  const profiles = isActivePick ? activeProfiles : (remote?.profiles ?? []);
  const remoteLoading = !isActivePick && !remote && !remoteError;

  const usedKeys = new Set(
    useLayoutStore.getState().panes
      .filter(p => p.sessionId)
      .map(p => `${p.serverId ?? activeServerId ?? ''}:${p.sessionId}`)
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, Profile[]>();
    for (const p of profiles) {
      const g = p.group || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(p);
    }
    return groups;
  }, [profiles]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[420px] max-h-[80vh] bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-200">Assign session to pane</span>
          <button onClick={onClose} className="px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
        </div>
        {servers.length > 1 && (
          <div className="shrink-0 flex flex-wrap gap-1.5 px-4 py-2.5 border-b border-zinc-800">
            {servers.map((e) => (
              <button
                key={e.id}
                onClick={() => setPickServerId(e.id)}
                className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${
                  pickServerId === e.id
                    ? 'bg-zinc-700 text-zinc-100 ring-1 ring-zinc-500'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {e.serverName || e.label}
                {e.id === activeServerId && <span className="ml-1 text-zinc-500">(active)</span>}
              </button>
            ))}
          </div>
        )}
        <div className="overflow-y-auto p-3 space-y-4">
          {remoteLoading && (
            <div className="px-3 py-6 text-center text-xs text-zinc-500">
              <span className="inline-block w-3.5 h-3.5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin align-middle mr-2" />
              Fetching sessions…
            </div>
          )}
          {remoteError && (
            <div className="px-3 py-4 text-xs text-danger leading-snug">{remoteError}</div>
          )}
          {sessions.length > 0 && (
            <section>
              <div className="text-meta font-semibold text-fg-2 mb-1.5 px-1">
                Live sessions
              </div>
              <div className="space-y-1">
                {orderSessions(sessions).map((s: SessionInfo) => {
                  const inUse = usedKeys.has(`${pickServerId ?? ''}:${s.id}`);
                  return (
                    <SessionRow
                      key={s.id}
                      session={s}
                      density="compact"
                      detail="never"
                      hint={inUse ? 'In another pane' : undefined}
                      onOpen={() => onPick(s.id, pickServerId)}
                      trailing={inUse ? <span className="px-1.5 text-micro text-fg-3">in another pane</span> : undefined}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {Array.from(grouped.entries()).map(([group, profs]) => (
            <section key={group}>
              <div className="text-meta font-semibold text-fg-2 mb-1.5 px-1">
                Start from {group}
              </div>
              <div className="space-y-1">
                {profs.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onCreateFromProfile(p.id, pickServerId)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-zinc-800 transition-colors text-left"
                  >
                    <ProfileTile name={p.name} color={p.color} size={20} />
                    <span className="flex-1 text-sm text-zinc-300 truncate">{p.name}</span>
                    <span className="text-[11px] text-zinc-600">new session</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function gridClasses(layout: Layout): string {
  if (layout === 'single') return 'grid-cols-1 grid-rows-1';
  if (layout === 'split-h') return 'grid-cols-2 grid-rows-1';
  if (layout === 'split-v') return 'grid-cols-1 grid-rows-2';
  return 'grid-cols-2 grid-rows-2';
}

export function GridLayout({ panel = false }: { panel?: boolean }) {
  const layout = useLayoutStore(s => s.layout);
  const panes = useLayoutStore(s => s.panes);
  const focusedPaneId = useLayoutStore(s => s.focusedPaneId);
  const workspaceId = useLayoutStore(s => s.activeWorkspaceId);
  const assignSession = useLayoutStore(s => s.assignSession);
  const clearPane = useLayoutStore(s => s.clearPane);
  const setFocusedPane = useLayoutStore(s => s.setFocusedPane);

  const serverUrl = useAppStore(s => s.serverUrl);
  const authToken = useAppStore(s => s.authToken);
  const servers = useAppStore(s => s.servers);
  const activeServerId = useAppStore(s => s.activeServerId);
  const createSession = useAppStore(s => s.createSession);
  const markPendingAssign = useLayoutStore(s => s.markPendingAssign);
  const pushNotification = useAppStore(s => s.pushNotification);

  const [pickerPaneId, setPickerPaneId] = useState<string | null>(null);
  useDesktopShortcuts({ onPickSession: setPickerPaneId });

  // Resolve a pane's connection target from its bound server. Legacy panes
  // (serverId null) follow the active server, same as before phase 2.
  const resolvePane = (slotServerId: string | null): { url: string; token: string; entry: ServerEntry | null; isRemote: boolean } => {
    const boundId = slotServerId ?? activeServerId;
    const isRemote = boundId !== activeServerId;
    const entry = servers.find(e => e.id === boundId) ?? null;
    if (!entry || !isRemote) return { url: serverUrl, token: authToken ?? '', entry, isRemote: false };
    return { url: resolveEntryHost(entry), token: entry.authToken ?? '', entry, isRemote: true };
  };

  const multi = panes.length > 1;
  // Panel mode: one column, the focused pane first and full, the rest as
  // strips. Still a grid (only the template changes): switching the
  // container to flex left Chromium with a stale zero-height layout inside
  // the focused pane.
  const panelStyle = panel && multi
    ? { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: `minmax(0, 1fr) ${'28px '.repeat(panes.length - 1).trim()}` }
    : undefined;

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-0">
      <div className={`pl-wsg flex-1 min-h-0 ${panelStyle ? '' : gridClasses(layout)}${multi ? ' multi' : ''}`} style={panelStyle}>
        {panes.map((slot, i) => {
          const r = resolvePane(slot.serverId);
          const focused = slot.id === focusedPaneId;
          const collapsed = !!panelStyle && !focused;
          return (
            <TerminalPane
              key={`${workspaceId}:${slot.id}`}
              paneId={slot.id}
              paneNumber={i + 1}
              sessionId={slot.sessionId}
              serverUrl={r.url}
              authToken={r.token}
              serverBadge={r.isRemote ? (r.entry?.serverName || r.entry?.label || 'remote') : null}
              isFocused={focused}
              collapsed={collapsed}
              order={panelStyle ? (focused ? 0 : 1 + i) : undefined}
              onFocus={() => setFocusedPane(slot.id)}
              onClear={() => clearPane(slot.id)}
              onPickSession={() => setPickerPaneId(slot.id)}
            />
          );
        })}
      </div>

      {pickerPaneId && (
        <SessionPicker
          onClose={() => setPickerPaneId(null)}
          onPick={(sessionId, serverId) => {
            assignSession(pickerPaneId, sessionId, serverId ?? activeServerId);
            setPickerPaneId(null);
          }}
          onCreateFromProfile={(profileId, serverId) => {
            const boundId = serverId ?? activeServerId;
            if (boundId === activeServerId) {
              // Active server: existing flow — the store routes the freshly
              // created session into the pending pane via sessions.list.
              markPendingAssign(pickerPaneId);
              createSession(profileId);
              setPickerPaneId(null);
              return;
            }
            // Remote server: create over a throwaway socket, then bind the
            // new session id directly to this pane.
            const entry = servers.find(e => e.id === boundId);
            const paneId = pickerPaneId;
            setPickerPaneId(null);
            if (!entry) return;
            remoteCreateSession(entry, profileId)
              .then((sessionId) => assignSession(paneId, sessionId, boundId))
              .catch((err: Error) => {
                pushNotification('error', `Could not start session on ${entry.label}: ${err.message}`, 'remote');
              });
          }}
        />
      )}
    </div>
  );
}
