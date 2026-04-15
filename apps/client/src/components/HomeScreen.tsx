import { useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';

// ============================================================================
// Reorder helpers
// ============================================================================

function moveProfile(profiles: Profile[], profileId: string, direction: 'up' | 'down'): string[] {
  const ids = profiles.map(p => p.id);
  const idx = ids.indexOf(profileId);
  if (idx < 0) return ids;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= ids.length) return ids;
  [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
  return ids;
}

// ============================================================================
// Session Pill (compact inline for live sessions bar)
// ============================================================================

function SessionPill({ session }: { session: SessionInfo }) {
  const { attachSession, killSession } = useAppStore();
  const [confirmKill, setConfirmKill] = useState(false);

  return (
    <div className="shrink-0 flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-lg pl-2.5 pr-1 py-1">
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
        onClick={() => attachSession(session.id)}
        className="text-xs font-medium text-zinc-300 truncate max-w-[100px]
                   active:text-zinc-100 transition-colors"
      >
        {session.name}
      </button>
      {confirmKill ? (
        <button
          onClick={() => { killSession(session.id); setConfirmKill(false); }}
          onBlur={() => setConfirmKill(false)}
          className="px-1.5 py-0.5 text-[10px] font-medium bg-red-900/50 text-red-400
                     rounded transition-colors active:bg-red-800/50"
        >
          Kill?
        </button>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmKill(true); }}
          className="px-1 py-0.5 text-zinc-600 active:text-red-400 transition-colors text-sm leading-none"
          title="Kill session"
        >
          &times;
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Profile Card
// ============================================================================

function ProfileCard({ profile, isLive, reordering, onMove }: {
  profile: Profile; isLive: boolean; reordering: boolean;
  onMove?: (direction: 'up' | 'down') => void;
}) {
  const { createSession, sessions, healthStatuses, editProfile } = useAppStore();

  const health = healthStatuses.find(h => h.profileId === profile.id);
  const liveSessions = sessions.filter(s => s.profileId === profile.id);
  const liveCount = liveSessions.length;

  const handleTap = () => {
    createSession(profile.id);
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    editProfile(profile);
  };

  return (
    <div className="flex items-center gap-0 bg-zinc-900 border border-zinc-800 rounded-xl">
      {reordering && onMove && (
        <div className="flex flex-col shrink-0 border-r border-zinc-800">
          <button
            onClick={(e) => { e.stopPropagation(); onMove('up'); }}
            className="px-2 py-1.5 text-zinc-500 active:text-zinc-200 transition-colors text-xs"
          >
            ▲
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onMove('down'); }}
            className="px-2 py-1.5 text-zinc-500 active:text-zinc-200 transition-colors text-xs"
          >
            ▼
          </button>
        </div>
      )}
      <button
        onClick={handleTap}
        className={`flex items-center gap-3 flex-1 min-w-0 px-4 py-3.5
                   active:bg-zinc-800 transition-colors text-left ${reordering ? '' : 'rounded-l-xl'}`}
      >
        <div className="relative shrink-0">
          <span className="text-lg">{profile.icon || '\uD83D\uDCC2'}</span>
          {liveCount > 0 && liveCount < 2 && (
            <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          )}
          {liveCount >= 2 && (
            <div className="absolute -top-1 -right-1.5 min-w-[16px] h-[16px] px-1
                            rounded-full bg-green-500 text-[10px] font-bold text-zinc-950
                            flex items-center justify-center">
              {liveCount}
            </div>
          )}
        </div>
        <span className="flex-1 text-sm font-medium truncate">{profile.name}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {health && (
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: health.healthy ? '#22c55e' : '#ef4444' }}
            />
          )}
          {profile.color && (
            <div
              className="w-1.5 h-4 rounded-full"
              style={{ backgroundColor: profile.color }}
            />
          )}
        </div>
      </button>
      {!reordering && (
        <button
          onClick={handleEdit}
          className="shrink-0 px-3 py-3.5 text-zinc-600 active:text-zinc-300
                     transition-colors border-l border-zinc-800 rounded-r-xl"
          title="Edit profile"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
            <path d="m15 5 4 4"/>
          </svg>
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Home Screen
// ============================================================================

export function HomeScreen() {
  const { sessions, profiles, serverName, setView, discoverProfiles, createSession, editProfile, reorderProfiles } = useAppStore();
  const [reordering, setReordering] = useState(false);

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
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="shrink-0 px-4 pt-[max(12px,var(--sat))] pb-3 border-b border-zinc-800">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">PersaLink</h1>
            <p className="text-xs text-zinc-500">{serverName || 'Connected'}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setReordering(!reordering)}
              className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                reordering
                  ? 'bg-zinc-100 text-zinc-900 font-medium'
                  : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
              }`}
            >
              {reordering ? 'Done' : 'Reorder'}
            </button>
            <button
              onClick={discoverProfiles}
              className="px-4 py-2 text-sm bg-zinc-800 text-zinc-400 rounded-lg
                         active:bg-zinc-700 transition-colors"
              title="Discover projects"
            >
              Scan
            </button>
            <button
              onClick={() => setView('settings')}
              className="px-4 py-2 text-sm bg-zinc-800 text-zinc-400 rounded-lg
                         active:bg-zinc-700 transition-colors"
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {/* Live Sessions — compact pill row */}
        {sessions.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Live ({sessions.length})
            </h2>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {sessions.map((session) => (
                <SessionPill key={session.id} session={session} />
              ))}
            </div>
          </section>
        )}

        {/* Pinned Profiles */}
        {groupedProfiles.pinned.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
              Pinned
            </h2>
            <div className="space-y-2">
              {groupedProfiles.pinned.map((profile) => (
                <ProfileCard key={profile.id} profile={profile} isLive={sessions.some(s => s.profileId === profile.id)}
                  reordering={reordering}
                  onMove={(dir) => reorderProfiles(moveProfile(profiles, profile.id, dir))}
                />
              ))}
            </div>
          </section>
        )}

        {/* Profile Groups */}
        {Array.from(groupedProfiles.groups.entries()).map(([group, profs]) => (
          <section key={group}>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
              {group}
            </h2>
            <div className="space-y-2">
              {profs.map((profile) => (
                <ProfileCard key={profile.id} profile={profile} isLive={sessions.some(s => s.profileId === profile.id)}
                  reordering={reordering}
                  onMove={(dir) => reorderProfiles(moveProfile(profiles, profile.id, dir))}
                />
              ))}
            </div>
          </section>
        ))}

        {/* New Session / New Profile */}
        <section className="space-y-2">
          <button
            onClick={() => createSession()}
            className="w-full py-3 border border-dashed border-zinc-700 rounded-xl
                       text-zinc-500 text-sm active:border-zinc-500 active:text-zinc-400
                       transition-colors"
          >
            + New Session
          </button>
          <button
            onClick={() => editProfile(null)}
            className="w-full py-3 border border-dashed border-zinc-700 rounded-xl
                       text-zinc-500 text-sm active:border-zinc-500 active:text-zinc-400
                       transition-colors"
          >
            + New Profile
          </button>
        </section>
      </div>
    </div>
  );
}
