import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionReadout } from './ui/ConnectionReadout';
import { useAppStore } from '../stores/appStore';
import { usePullToRefresh } from '../lib/usePullToRefresh';
import { useLongPress } from '../lib/useLongPress';
import { orderSessions, useAttentionOrder } from '../lib/sessionOrder';
import { stateKey, sessionTitle, countStates, needsSentence } from '../lib/sessionState';
import { SessionRow } from './ui/SessionRow';
import { StateGlyph } from './ui/StateGlyph';
import { ProfileTile } from './ui/ProfileTile';
import { IconButton } from './ui/IconButton';
import { Pencil, Search, X } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';
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
  const { attachSession, killSession, renameSession } = useAppStore();
  const [confirmKill, setConfirmKill] = useState(false);

  // An armed "Kill?" must not linger — a stale confirm sitting under a later
  // absent-minded tap is how sessions die by accident. Auto-disarm.
  useEffect(() => {
    if (!confirmKill) return;
    const t = setTimeout(() => setConfirmKill(false), 3000);
    return () => clearTimeout(t);
  }, [confirmKill]);
  // Explicit pencil-button rename — mobile had NO way to rename a session
  // (desktop panes use double-click; gestures are undiscoverable anyway).
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

  const commitEdit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== session.name) renameSession(session.id, trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2.5 min-h-(--pl-row-h) px-2.5 rounded-[10px] bg-bg-3">
        <StateGlyph state={stateKey(session)} />
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Session name"
          className="flex-1 min-w-0 h-9 px-2.5 bg-bg-1 border border-line-2 rounded-[6px] text-body text-fg-1 outline-none focus:border-line-3"
          autoFocus
        />
      </div>
    );
  }

  return (
    <SessionRow
      session={session}
      detail="auto"
      onOpen={() => attachSession(session.id)}
      trailing={(
        <>
          <IconButton
            label={`Rename ${sessionTitle(session)}`}
            onClick={(e) => { e.stopPropagation(); setEditName(session.name || session.profileName || ''); setEditing(true); }}
          >
            <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconButton>
          {confirmKill ? (
            <button
              type="button"
              onClick={() => { killSession(session.id); setConfirmKill(false); }}
              onBlur={() => setConfirmKill(false)}
              className="h-11 px-3 rounded-[6px] text-meta font-semibold text-danger active:bg-danger-soft"
            >
              Kill?
            </button>
          ) : (
            <IconButton label={`Kill ${sessionTitle(session)}`} onClick={(e) => { e.stopPropagation(); setConfirmKill(true); }}>
              <X className="w-4 h-4" strokeWidth={1.75} />
            </IconButton>
          )}
        </>
      )}
    />
  );
}

// ============================================================================
// Profile Card
// ============================================================================

function ProfileCard({ profile, isLive, reordering, onMove }: {
  profile: Profile; isLive: boolean; reordering: boolean;
  onMove?: (direction: 'up' | 'down') => void;
}) {
  const { createSession, attachSession, sessions, healthStatuses, editProfile } = useAppStore();

  const health = healthStatuses.find(h => h.profileId === profile.id);
  const liveSessions = sessions.filter(s => s.profileId === profile.id);
  const liveCount = liveSessions.length;
  // The most urgent live instance's state, so a card says something wants
  // you without opening the list. Static glyph; nothing loops.
  const lead = orderSessions(liveSessions)[0];

  // Same gesture contract as the desktop sidebar: tap opens the existing
  // session (or starts one if none is live); long-press always starts a new
  // instance. Desktop additionally accepts shift/alt-click for the latter.
  const handleTap = useCallback(() => {
    const existing = liveSessions[0];
    if (existing) attachSession(existing.id);
    else createSession(profile.id);
  }, [liveSessions, attachSession, createSession, profile.id]);
  const handleNewInstance = useCallback(() => {
    createSession(profile.id);
  }, [createSession, profile.id]);
  const press = useLongPress(handleNewInstance, handleTap);

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
        {...press}
        title={liveCount > 0 ? 'Tap to open. Hold for a new instance.' : profile.name}
        className={`flex items-center gap-3 flex-1 min-w-0 px-4 py-3.5 select-none
                   active:bg-zinc-800 transition-colors text-left ${reordering ? '' : 'rounded-l-xl'}`}
        style={{ WebkitTouchCallout: 'none' }}
      >
        <ProfileTile name={profile.name} color={profile.color} size={28} />
        <span className="flex-1 text-sm font-medium truncate">{profile.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          {health && !health.healthy && (
            <span className="text-micro font-medium text-danger" title="Health check failing">Unhealthy</span>
          )}
          {lead && (
            <span className="flex items-center gap-1.5 text-micro text-fg-3 tnum" title={`${liveCount} live`}>
              <StateGlyph state={stateKey(lead)} />
              {liveCount > 1 ? `${liveCount} live` : 'Live'}
            </span>
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
  const { sessions, profiles, openSettings, openServers, openFiles, discoverProfiles, createSession, editProfile, reorderProfiles, refresh } = useAppStore();
  const filesDisabled = useAppStore((s) => s.filesDisabled);

  // Attention order (waiting first, longest wait on top), held still while a
  // finger is down and briefly after: a live re-sort once moved a row under
  // a mid-tap kill confirm and a different session ate the tap.
  const orderedSessions = useAttentionOrder(sessions);
  const [reordering, setReordering] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const onRefresh = useCallback(() => refresh(), [refresh]);
  const { pullDistance, phase, triggerDistance } = usePullToRefresh(scrollRef, onRefresh);

  const pullProgress = Math.min(1, pullDistance / triggerDistance);
  const indicatorActive = phase === 'refreshing' || pullDistance >= triggerDistance;
  const animatePull = phase !== 'pulling';

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
      <header className="shrink-0 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-zinc-800">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">PersaLink</h1>
            {/* Server chip — tap to open the Servers screen and switch machines */}
            <button
              onClick={openServers}
              className="flex items-center gap-1.5 text-xs text-zinc-500 active:text-zinc-300 transition-colors"
              title="Switch server"
            >
              {/* Server + round trip; says "reconnecting" while the link is down. */}
              <ConnectionReadout server />
              <svg className="w-3 h-3 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <IconButton label="Search sessions and commands" onClick={() => useUiStore.getState().openPalette()}>
              <Search className="w-[18px] h-[18px]" strokeWidth={1.75} />
            </IconButton>
            <button
              onClick={() => setReordering(!reordering)}
              className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                reordering
                  ? 'bg-bg-4 text-fg-1 font-medium'
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
              onClick={openFiles}
              hidden={filesDisabled}
              className="px-3 py-2 text-sm bg-zinc-800 text-zinc-400 rounded-lg
                         active:bg-zinc-700 transition-colors"
              title="Browse this server's files"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
            </button>
            <button
              onClick={openSettings}
              className="px-4 py-2 text-sm bg-zinc-800 text-zinc-400 rounded-lg
                         active:bg-zinc-700 transition-colors"
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto relative"
        style={{ overscrollBehaviorY: 'contain', touchAction: 'pan-y' }}
      >
        {/* Pull-to-refresh indicator — sits in the gap revealed by the
            translated content below. Hidden at rest. */}
        <div
          className="absolute left-0 right-0 top-0 flex items-center justify-center pointer-events-none"
          style={{
            height: pullDistance,
            opacity: pullDistance > 8 ? 1 : 0,
            transition: animatePull ? 'height 200ms ease-out, opacity 150ms' : 'none',
          }}
        >
          <div
            className={`w-5 h-5 rounded-full border-2 border-zinc-700 ${
              phase === 'refreshing' ? 'border-t-zinc-200 animate-spin' : ''
            }`}
            style={{
              transform: phase === 'refreshing' ? undefined : `rotate(${pullProgress * 270}deg)`,
              borderTopColor: phase !== 'refreshing' && indicatorActive ? '#e4e4e7' : undefined,
            }}
          />
        </div>

        <div
          className="px-4 py-4 space-y-6"
          style={{
            transform: `translateY(${pullDistance}px)`,
            transition: animatePull ? 'transform 200ms ease-out' : 'none',
          }}
        >
        {/* Live Sessions — full-width rows matching profile card size */}
        {sessions.length > 0 && (
          <section>
            <h2 className="text-meta font-semibold text-fg-2 mb-1.5 px-1 flex items-baseline gap-2">
              Sessions
              <span className="font-medium text-fg-3 tnum">{needsSentence(countStates(sessions).waiting)} · {sessions.length} live</span>
            </h2>
            <div className="space-y-0.5 -mx-1">
              {orderedSessions.map((session) => (
                <SessionPill key={session.id} session={session} />
              ))}
            </div>
          </section>
        )}

        {/* Pinned Profiles */}
        {groupedProfiles.pinned.length > 0 && (
          <section>
            <h2 className="text-meta font-semibold text-fg-2 mb-3">
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
            <h2 className="text-meta font-semibold text-fg-2 mb-3">
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
    </div>
  );
}
