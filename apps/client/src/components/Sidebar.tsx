/**
 * @file Sidebar
 * @description Persistent sidebar for desktop layout — profiles, live sessions,
 *   and quick actions always visible alongside the terminal.
 */

import { useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useLayoutStore } from '../stores/layoutStore';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';

// ============================================================================
// Session Pill (compact, for sidebar)
// ============================================================================

function SessionPill({ session }: { session: SessionInfo }) {
  const killSession = useAppStore(s => s.killSession);
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
    <div className={`flex items-center gap-1.5 rounded-lg pl-2.5 pr-1 py-1.5 transition-colors ${
      isInFocusedPane ? 'bg-zinc-700 border border-zinc-600'
        : isActive ? 'bg-zinc-800 border border-zinc-700'
        : 'bg-zinc-800/50 border border-zinc-800 hover:bg-zinc-800'
    }`}>
      {session.profileIcon && (
        <span className="text-xs shrink-0">{session.profileIcon}</span>
      )}
      {!session.profileIcon && (
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: session.profileColor || '#22c55e' }}
        />
      )}
      <button
        onClick={() => assignSession(focusedPaneId, session.id)}
        className={`text-xs font-medium truncate flex-1 text-left transition-colors ${
          isInFocusedPane ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        title={
          isInFocusedPane ? `In focused pane (${paneNumber})`
            : isActive ? `In pane ${paneNumber} — click to move to focused pane`
            : 'Attach to focused pane'
        }
      >
        {session.profileName || session.name}
      </button>
      {isActive && (
        <span
          className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded text-[9px] font-semibold ${
            isInFocusedPane ? 'bg-zinc-500 text-zinc-50' : 'bg-zinc-700 text-zinc-300'
          }`}
          title={`Pane ${paneNumber}`}
        >
          {paneNumber}
        </span>
      )}
      {confirmKill ? (
        <button
          onClick={() => { killSession(session.id); setConfirmKill(false); }}
          onBlur={() => setConfirmKill(false)}
          className="px-1.5 py-0.5 text-[10px] font-medium bg-red-900/50 text-red-400
                     rounded transition-colors hover:bg-red-800/50"
        >
          Kill?
        </button>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmKill(true); }}
          className="px-1 py-0.5 text-zinc-600 hover:text-red-400 transition-colors text-sm leading-none"
          title="Kill session"
        >
          &times;
        </button>
      )}
    </div>
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

  const handleClick = () => {
    // If there's already a live session for this profile, attach it into the
    // focused pane. Otherwise create a new one (routed via pendingAssign).
    const existing = liveSessions[0];
    if (existing) {
      useLayoutStore.getState().assignSession(focusedPaneId, existing.id);
      return;
    }
    markPendingAssign(focusedPaneId);
    createSession(profile.id);
  };

  return (
    <div className={`flex items-center gap-0 rounded-lg transition-colors ${
      isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
    }`}>
      <button
        onClick={handleClick}
        className="flex items-center gap-2.5 flex-1 min-w-0 px-3 py-2 text-left"
      >
        <div className="relative shrink-0">
          <span className="text-sm">{profile.icon || '\uD83D\uDCC2'}</span>
          {liveCount > 0 && liveCount < 2 && (
            <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          )}
          {liveCount >= 2 && (
            <div className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] px-1
                            rounded-full bg-green-500 text-[9px] font-bold text-zinc-950
                            flex items-center justify-center">
              {liveCount}
            </div>
          )}
        </div>
        <span className={`flex-1 text-xs font-medium truncate ${
          isActive ? 'text-zinc-100' : 'text-zinc-300'
        }`}>
          {profile.name}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {health && (
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: health.healthy ? '#22c55e' : '#ef4444' }}
            />
          )}
          {profile.color && (
            <div
              className="w-1 h-3.5 rounded-full"
              style={{ backgroundColor: profile.color }}
            />
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
  const { sessions, profiles, serverName, openSettings, discoverProfiles, createSession, editProfile } = useAppStore();
  const focusedPaneId = useLayoutStore(s => s.focusedPaneId);
  const markPendingAssign = useLayoutStore(s => s.markPendingAssign);

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
            <p className="text-[10px] text-zinc-600">{serverName || 'Connected'}</p>
          </div>
          <div className="flex gap-1">
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
            <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-1.5 px-1 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Live ({sessions.length})
            </h2>
            <div className="space-y-1">
              {sessions.map((session) => (
                <SessionPill key={session.id} session={session} />
              ))}
            </div>
          </section>
        )}

        {/* Pinned Profiles */}
        {groupedProfiles.pinned.length > 0 && (
          <section>
            <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-1 px-1">
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
            <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-1 px-1">
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
          onClick={() => { markPendingAssign(focusedPaneId); createSession(); }}
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
