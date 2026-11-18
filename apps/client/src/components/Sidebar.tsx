/**
 * @file Sidebar
 * @description Persistent sidebar for desktop layout — profiles, live sessions,
 *   and quick actions always visible alongside the terminal.
 */

import { useCallback, useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useLayoutStore } from '../stores/layoutStore';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';
import { useLongPress } from '../lib/useLongPress';
import { useAttentionOrder } from '../lib/sessionOrder';
import { sessionTitle } from '../lib/sessionState';
import { SessionRow } from './ui/SessionRow';
import { ProfileTile } from './ui/ProfileTile';
import { IconButton } from './ui/IconButton';
import { X } from 'lucide-react';

// ============================================================================
// Session Pill (compact, for sidebar)
// ============================================================================

function SessionPill({ session }: { session: SessionInfo }) {
  const killSession = useAppStore(s => s.killSession);
  const closeOverlay = useAppStore(s => s.closeOverlay);
  const panes = useLayoutStore(s => s.panes);
  const focusedPaneId = useLayoutStore(s => s.focusedPaneId);
  const assignSession = useLayoutStore(s => s.assignSession);
  const [confirmKill, setConfirmKill] = useState(false);
  const paneIndex = panes.findIndex(p => p.sessionId === session.id);
  const paneSlot = paneIndex >= 0 ? panes[paneIndex] : null;
  const isActive = !!paneSlot;
  const isInFocusedPane = paneSlot?.id === focusedPaneId;
  const paneNumber = paneIndex + 1;

  return (
    <SessionRow
      session={session}
      density="compact"
      current={isInFocusedPane}
      selected={isActive && !isInFocusedPane}
      detail="never"
      hint={isInFocusedPane ? `In the focused pane (${paneNumber})`
        : isActive ? `In pane ${paneNumber}. Click to move it to the focused pane.`
        : 'Open in the focused pane'}
      // A session click always lands on the grid: close Settings, Files or
      // the profile editor if one is covering it, else the click looks dead.
      onOpen={() => { assignSession(focusedPaneId, session.id); closeOverlay(); }}
      trailing={confirmKill ? (
        <button
          type="button"
          onClick={() => { killSession(session.id); setConfirmKill(false); }}
          onBlur={() => setConfirmKill(false)}
          className="h-7 px-2 rounded-[6px] text-micro font-semibold text-danger hover:bg-danger-soft"
        >
          Kill?
        </button>
      ) : (
        <IconButton
          size="xs"
          label={`Kill ${sessionTitle(session)}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => { e.stopPropagation(); setConfirmKill(true); }}
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </IconButton>
      )}
    />
  );
}

// ============================================================================
// Profile Row (compact sidebar version)
// ============================================================================

function ProfileRow({ profile }: { profile: Profile }) {
  const { createSession, sessions, healthStatuses, editProfile } = useAppStore();
  const focusedPaneId = useLayoutStore(s => s.focusedPaneId);
  const panes = useLayoutStore(s => s.panes);
  const markPendingAssign = useLayoutStore(s => s.markPendingAssign);

  const health = healthStatuses.find(h => h.profileId === profile.id);
  const liveSessions = sessions.filter(s => s.profileId === profile.id);
  const liveCount = liveSessions.length;
  const focusedSessionId = panes.find(p => p.id === focusedPaneId)?.sessionId;
  const isActive = !!(focusedSessionId && liveSessions.some(s => s.id === focusedSessionId));

  // Shift/Alt-click OR long-press forces a new instance even if one already
  // exists. Plain click attaches the first existing session (default
  // ergonomic). Mirrors the mobile profile card's tap / hold contract.
  // Either way the grid comes back to the front (closeOverlay is a no-op when
  // nothing covers it).
  const handleNewInstance = useCallback(() => {
    markPendingAssign(focusedPaneId);
    createSession(profile.id);
    useAppStore.getState().closeOverlay();
  }, [markPendingAssign, focusedPaneId, createSession, profile.id]);
  const handleClick = useCallback((e: React.MouseEvent) => {
    const forceNew = e.shiftKey || e.altKey;
    const existing = liveSessions[0];
    if (existing && !forceNew) {
      useLayoutStore.getState().assignSession(focusedPaneId, existing.id);
      useAppStore.getState().closeOverlay();
      return;
    }
    handleNewInstance();
  }, [liveSessions, focusedPaneId, handleNewInstance]);
  const press = useLongPress(handleNewInstance, handleClick);

  return (
    <div className={`flex items-center gap-0 rounded-lg transition-colors ${
      isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
    }`}>
      <button
        {...press}
        title={liveCount > 0 ? 'Click to attach. Shift+click or hold for a new instance.' : profile.name}
        className="flex items-center gap-2.5 flex-1 min-w-0 px-3 py-2 text-left"
      >
        <ProfileTile name={profile.name} color={profile.color} size={20} />
        <span className={`flex-1 text-xs font-medium truncate ${
          isActive ? 'text-zinc-100' : 'text-zinc-300'
        }`}>
          {profile.name}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {health && !health.healthy && (
            <span className="text-micro font-medium text-danger" title="Health check failing">Unhealthy</span>
          )}
          {liveCount > 0 && (
            <span className="text-micro text-fg-3 tnum" title={`${liveCount} live`}>{liveCount > 1 ? `${liveCount} live` : 'Live'}</span>
          )}
        </div>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); editProfile(profile); }}
        className="shrink-0 px-2 py-2 text-zinc-600 hover:text-zinc-400 transition-colors"
        title="Edit profile"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
          <path d="m15 5 4 4"/>
        </svg>
      </button>
    </div>
  );
}

// ============================================================================
// Sidebar
// ============================================================================

export function Sidebar() {
  const { sessions, profiles, serverName, openSettings, openServers, openFiles, discoverProfiles, createSession, editProfile } = useAppStore();
  const filesDisabled = useAppStore((s) => s.filesDisabled);
  const focusedPaneId = useLayoutStore(s => s.focusedPaneId);
  const markPendingAssign = useLayoutStore(s => s.markPendingAssign);
  const orderedSessions = useAttentionOrder(sessions);

  const groupedProfiles = useMemo(() => {
    const groups = new Map<string, Profile[]>();
    const pinned: Profile[] = [];

    for (const profile of profiles) {
      if (profile.pinned) {
        pinned.push(profile);
        continue;
      }
      const group = profile.group || 'Other';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(profile);
    }

    return { pinned, groups };
  }, [profiles]);

  return (
    <div className="flex flex-col h-full w-[260px] shrink-0 bg-zinc-950 border-r border-zinc-800">
      {/* Header */}
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-zinc-800">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-sm font-bold text-zinc-100">PersaLink</h1>
            {/* Server chip — opens the Servers screen (multi-server switch) */}
          <button
            onClick={openServers}
            className="flex items-center gap-1 text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Switch server"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
            {serverName || 'Connected'}
            <svg className="w-2.5 h-2.5 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
            </svg>
          </button>
          </div>
          <div className="flex gap-1">
            <button
              // Hard reload to pull a fresh bundle. The PWA window has no
              // address bar / reload affordance, so an installed desktop app
              // can sit on a stale in-memory build indefinitely (this is how
              // the mic button "disappeared"). The service worker caches
              // nothing, so a plain reload re-fetches current assets; tmux
              // sessions survive and the app auto-reconnects on load.
              onClick={() => window.location.reload()}
              className="p-1.5 text-zinc-600 hover:text-zinc-400 transition-colors rounded"
              title="Refresh app"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>
              </svg>
            </button>
            <button
              onClick={discoverProfiles}
              className="p-1.5 text-zinc-600 hover:text-zinc-400 transition-colors rounded"
              title="Scan for projects"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
              </svg>
            </button>
            <button
              onClick={openFiles}
              hidden={filesDisabled}
              className="p-1.5 text-zinc-600 hover:text-zinc-400 transition-colors rounded"
              title="Files"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
              </svg>
            </button>
            <button
              onClick={openSettings}
              className="p-1.5 text-zinc-600 hover:text-zinc-400 transition-colors rounded"
              title="Settings"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {/* Live Sessions */}
        {sessions.length > 0 && (
          <section>
            <h2 className="text-meta font-semibold text-fg-2 mb-1 px-1 flex items-baseline gap-2">
              Sessions
              <span className="font-medium text-fg-3 tnum">{sessions.length}</span>
            </h2>
            <div className="space-y-1">
              {orderedSessions.map((session) => (
                <SessionPill key={session.id} session={session} />
              ))}
            </div>
          </section>
        )}

        {/* Pinned Profiles */}
        {groupedProfiles.pinned.length > 0 && (
          <section>
            <h2 className="text-meta font-semibold text-fg-2 mb-1 px-1">
              Pinned
            </h2>
            <div className="space-y-0.5">
              {groupedProfiles.pinned.map((profile) => (
                <ProfileRow key={profile.id} profile={profile} />
              ))}
            </div>
          </section>
        )}

        {/* Profile Groups */}
        {Array.from(groupedProfiles.groups.entries()).map(([group, profs]) => (
          <section key={group}>
            <h2 className="text-meta font-semibold text-fg-2 mb-1 px-1">
              {group}
            </h2>
            <div className="space-y-0.5">
              {profs.map((profile) => (
                <ProfileRow key={profile.id} profile={profile} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Bottom actions */}
      <div className="shrink-0 px-2 py-2 border-t border-zinc-800 space-y-1">
        <button
          onClick={() => { markPendingAssign(focusedPaneId); createSession(); useAppStore.getState().closeOverlay(); }}
          className="w-full py-1.5 text-xs text-zinc-600 hover:text-zinc-400
                     border border-dashed border-zinc-800 hover:border-zinc-700
                     rounded-lg transition-colors"
        >
          + New Session
        </button>
        <button
          onClick={() => editProfile(null)}
          className="w-full py-1.5 text-xs text-zinc-600 hover:text-zinc-400
                     border border-dashed border-zinc-800 hover:border-zinc-700
                     rounded-lg transition-colors"
        >
          + New Profile
        </button>
      </div>
    </div>
  );
}
