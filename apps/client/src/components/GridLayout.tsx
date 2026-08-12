/**
 * @file GridLayout
 * @description Desktop multi-pane container. Renders N TerminalPane components
 *   in a CSS grid based on the layout mode, handles focus tracking, and shows
 *   a session picker popup when the user clicks to fill an empty pane.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore, type ServerEntry } from '../stores/appStore';
import { useLayoutStore, type Layout } from '../stores/layoutStore';
import { TerminalPane } from './TerminalPane';
import { TerminalSettings } from './TerminalSettings';
import { remoteSnapshot, remoteCreateSession, resolveEntryHost } from '../lib/remoteServer';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';

function LayoutIcon({ layout }: { layout: Layout }) {
  const cls = 'w-3.5 h-3.5';
  if (layout === 'single') {
    return (
      <svg className={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="12" height="12" rx="1" />
      </svg>
    );
  }
  if (layout === 'split-h') {
    return (
      <svg className={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="5.5" height="12" rx="1" />
        <rect x="8.5" y="2" width="5.5" height="12" rx="1" />
      </svg>
    );
  }
  if (layout === 'split-v') {
    return (
      <svg className={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="12" height="5.5" rx="1" />
        <rect x="2" y="8.5" width="12" height="5.5" rx="1" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5.5" height="5.5" rx="1" />
      <rect x="8.5" y="2" width="5.5" height="5.5" rx="1" />
      <rect x="2" y="8.5" width="5.5" height="5.5" rx="1" />
      <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" />
    </svg>
  );
}

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
            <div className="px-3 py-4 text-xs text-amber-300/90 leading-snug">{remoteError}</div>
          )}
          {sessions.length > 0 && (
            <section>
              <div className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-1.5 px-1">
                Live sessions
              </div>
              <div className="space-y-1">
                {sessions.map((s: SessionInfo) => {
                  const inUse = usedKeys.has(`${pickServerId ?? ''}:${s.id}`);
                  return (
                    <button
                      key={s.id}
                      onClick={() => onPick(s.id, pickServerId)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-zinc-800 transition-colors text-left"
                    >
                      {s.profileIcon && <span className="text-sm shrink-0">{s.profileIcon}</span>}
                      {!s.profileIcon && (
                        <div
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: s.profileColor || '#22c55e' }}
                        />
                      )}
                      <span className="flex-1 text-sm text-zinc-200 truncate">{s.profileName || s.name}</span>
                      {inUse && (
                        <span className="text-[10px] text-zinc-500">in another pane</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {Array.from(grouped.entries()).map(([group, profs]) => (
            <section key={group}>
              <div className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-1.5 px-1">
                Start from {group}
              </div>
              <div className="space-y-1">
                {profs.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onCreateFromProfile(p.id, pickServerId)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-zinc-800 transition-colors text-left"
                  >
                    <span className="text-sm shrink-0">{p.icon || '\uD83D\uDCC2'}</span>
                    <span className="flex-1 text-sm text-zinc-300 truncate">{p.name}</span>
                    <span className="text-[10px] text-zinc-600">new session</span>
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

export function LayoutSwitcher() {
  const layout = useLayoutStore(s => s.layout);
  const setLayout = useLayoutStore(s => s.setLayout);
  const options: Layout[] = ['single', 'split-h', 'split-v', '2x2'];
  return (
    <div className="flex items-center gap-0.5 bg-zinc-900 border border-zinc-800 rounded p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => setLayout(opt)}
          className={`p-1 rounded transition-colors ${
            layout === opt ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
          }`}
          title={opt}
        >
          <LayoutIcon layout={opt} />
        </button>
      ))}
    </div>
  );
}

function gridClasses(layout: Layout): string {
  if (layout === 'single') return 'grid-cols-1 grid-rows-1';
  if (layout === 'split-h') return 'grid-cols-2 grid-rows-1';
  if (layout === 'split-v') return 'grid-cols-1 grid-rows-2';
  return 'grid-cols-2 grid-rows-2';
}

export function GridLayout() {
  const layout = useLayoutStore(s => s.layout);
  const panes = useLayoutStore(s => s.panes);
  const focusedPaneId = useLayoutStore(s => s.focusedPaneId);
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
  const [showSettings, setShowSettings] = useState(false);

  // Resolve a pane's connection target from its bound server. Legacy panes
  // (serverId null) follow the active server, same as before phase 2.
  const resolvePane = (slotServerId: string | null): { url: string; token: string; entry: ServerEntry | null; isRemote: boolean } => {
    const boundId = slotServerId ?? activeServerId;
    const isRemote = boundId !== activeServerId;
    const entry = servers.find(e => e.id === boundId) ?? null;
    if (!entry || !isRemote) return { url: serverUrl, token: authToken ?? '', entry, isRemote: false };
    return { url: resolveEntryHost(entry), token: entry.authToken ?? '', entry, isRemote: true };
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Top bar with layout switcher */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900 relative">
        <LayoutSwitcher />
        <div className="flex-1" />
        <span className="text-[10px] text-zinc-600">
          {panes.length} pane{panes.length > 1 ? 's' : ''} &middot; click a pane to focus
        </span>
        <div className="relative">
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={`p-1.5 rounded transition-colors ${
              showSettings ? 'text-zinc-100 bg-zinc-800' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
            }`}
            title="Terminal appearance"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
          {showSettings && <TerminalSettings onClose={() => setShowSettings(false)} />}
        </div>
      </div>

      {/* Grid */}
      <div className={`flex-1 min-h-0 grid gap-1 p-1 ${gridClasses(layout)}`}>
        {panes.map((slot, i) => {
          const r = resolvePane(slot.serverId);
          return (
            <TerminalPane
              key={slot.id}
              paneId={slot.id}
              paneNumber={i + 1}
              sessionId={slot.sessionId}
              serverUrl={r.url}
              authToken={r.token}
              serverBadge={r.isRemote ? (r.entry?.serverName || r.entry?.label || 'remote') : null}
              isFocused={slot.id === focusedPaneId}
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
