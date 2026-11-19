/**
 * @file ProfileRail
 * @description Profiles on phone Home and the Titan: one horizontal rail of
 *   chips (monogram, name, one fact). Tap opens the profile's live session,
 *   or starts one when none runs; with two or more live it lists them. Hold
 *   starts a new instance, and says so: the chip fills along its bottom edge
 *   while held, and a one-line hint stays under the rail until the first
 *   hold (or "Got it"). Manage opens the full list (edit, reorder, quick
 *   actions, new profile, scan). Profiles follow their categories
 *   (lib/profileGroups): pinned first, a quiet label where each category
 *   starts, Archive left off the rail (it is in Manage, folded).
 *   Also exports ProfileSheet (one profile: its sessions, New instance,
 *   quick actions, Edit) and ProfilesSheet (manage all).
 */

import { useCallback, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Pencil, Play, Plus, ScanSearch } from 'lucide-react';
import type { Profile } from '@persalink/shared/protocol';
import { useAppStore } from '../../stores/appStore';
import { useUiStore } from '../../stores/uiStore';
import { useLongPress } from '../../lib/useLongPress';
import { orderSessions } from '../../lib/sessionOrder';
import { stateKey } from '../../lib/sessionState';
import { groupProfiles, isArchiveGroup, isFlat, type ProfileGroup } from '../../lib/profileGroups';
import { profileGroupFolded } from '../../stores/uiStore';
import { openSession, startProfile } from '../../lib/openSession';
import { ProfileTile } from './ProfileTile';
import { StateGlyph } from './StateGlyph';
import { SessionRow } from './SessionRow';
import { Sheet, useSheetClose } from './Sheet';
import { IconButton } from './IconButton';

const HINT_KEY = 'persalink-hold-hint-seen';

function hintSeen(): boolean {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}
function markHintSeen(): void {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* per-viewer nicety only */ }
}

/** The rail's categories: Archive stays off the rail. */
function railGroups(profiles: readonly Profile[]): ProfileGroup[] {
  return groupProfiles(profiles).filter((g) => !isArchiveGroup(g.label));
}

/** One fact under a profile's name: health when it is failing, else live count, else "Start". */
function ProfileFact({ p }: { p: Profile }) {
  const sessions = useAppStore((s) => s.sessions);
  const health = useAppStore((s) => s.healthStatuses.find((h) => h.profileId === p.id));
  const live = sessions.filter((s) => s.profileId === p.id);
  if (health && !health.healthy) {
    return <span className="fact bad"><i aria-hidden className="bd" />Health failing</span>;
  }
  if (live.length) {
    const lead = orderSessions(live)[0];
    return <span className="fact"><StateGlyph state={stateKey(lead)} size={10} />{live.length} live</span>;
  }
  return <span className="fact">Start</span>;
}

function RailChip({ p, onMany, onHeld }: { p: Profile; onMany: (p: Profile) => void; onHeld: () => void }) {
  const sessions = useAppStore((s) => s.sessions);
  const [pressing, setPressing] = useState(false);
  const live = orderSessions(sessions.filter((s) => s.profileId === p.id));

  const tap = useCallback(() => {
    if (live.length === 0) startProfile(p.id);
    else if (live.length === 1) openSession(live[0].id, null);
    else onMany(p);
  }, [live, p, onMany]);
  const hold = useCallback(() => {
    onHeld();
    startProfile(p.id);
  }, [p.id, onHeld]);
  const press = useLongPress(hold, tap, { onPressChange: setPressing });

  return (
    <button
      type="button"
      {...press}
      className={`pl-pchip${pressing ? ' pressing' : ''}`}
      style={{ WebkitTouchCallout: 'none' }}
      title={`${p.name}${p.cwd ? ` · ${p.cwd}` : ''}\nTap opens${live.length ? ' its session' : ' a session'}. Hold for a new one.`}
      aria-label={`${p.name}. Tap to ${live.length ? 'open' : 'start'}, hold for a new instance.`}
    >
      <ProfileTile name={p.name} icon={p.icon} color={p.color} size={28} />
      <span className="tx">
        <span className="nm">{p.name}</span>
        <ProfileFact p={p} />
      </span>
    </button>
  );
}

export function ProfileRail({ profiles }: { profiles: readonly Profile[] }) {
  const [many, setMany] = useState<Profile | null>(null);
  const [manage, setManage] = useState(false);
  const [hint, setHint] = useState(() => !hintSeen());
  const dismissHint = useCallback(() => { markHintSeen(); setHint(false); }, []);
  const groups = railGroups(profiles);
  const labelled = !isFlat(groups);
  const ordered = groups.flatMap((g) => g.items);

  return (
    <section className="pl-hgrp" data-sec="profiles" aria-label="Profiles">
      <h2 className="pl-gh">
        Profiles<span className="cnt tnum">{profiles.length}</span>
        <span className="aside">
          <button type="button" className="pl-btn ghost sm pl-gh-btn" onClick={() => setManage(true)}>Manage</button>
        </span>
      </h2>
      {ordered.length === 0 ? (
        <div className="pl-calm">
          <span className="flex-1 min-w-0">No profiles yet.</span>
          <button type="button" className="pl-btn sm" onClick={() => useAppStore.getState().editProfile(null)}>
            <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />New profile
          </button>
        </div>
      ) : (
        <div className={`pl-rail${labelled ? ' grouped' : ''}`}>
          {groups.map((g) => (
            <div key={g.key} className="pl-rail-grp" role="group" aria-label={labelled ? g.label : 'Profiles'}>
              {labelled && <span className="pl-rail-cat">{g.label}</span>}
              <div className="pl-rail-row" role="list">
                {g.items.map((p) => (
                  <div role="listitem" key={p.id} className="contents">
                    <RailChip p={p} onMany={setMany} onHeld={dismissHint} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {hint && ordered.length > 0 && (
        <p className="pl-hint">
          <span className="flex-1 min-w-0">Tap opens a profile. Hold one to start a new instance.</span>
          <button type="button" onClick={dismissHint}>Got it</button>
        </p>
      )}
      {many && <ProfileSheet profile={many} onClose={() => setMany(null)} />}
      {manage && <ProfilesSheet onClose={() => setManage(false)} />}
    </section>
  );
}

/** One profile: its live sessions, New instance, quick actions, Edit. */
export function ProfileSheet({ profile: p, onClose }: { profile: Profile; onClose: () => void }) {
  const sessions = useAppStore((s) => s.sessions);
  const live = orderSessions(sessions.filter((s) => s.profileId === p.id));
  return (
    <Sheet
      title={<span className="flex items-center gap-2.5 min-w-0"><ProfileTile name={p.name} icon={p.icon} color={p.color} size={24} /><span className="truncate">{p.name}</span></span>}
      label={p.name}
      sub={p.cwd || undefined}
      onClose={onClose}
    >
      <ProfileSheetBody p={p} live={live} />
    </Sheet>
  );
}

function ProfileSheetBody({ p, live }: { p: Profile; live: ReturnType<typeof orderSessions> }) {
  const close = useSheetClose();
  const [arm, setArm] = useState<string | null>(null);
  const run = (aId: string, name: string, command: string, confirm?: boolean) => {
    if (confirm && arm !== aId) { setArm(aId); return; }
    useUiStore.getState().setQuickRun({ profileId: p.id, actionId: aId, title: `${p.name}: ${name}`, command, confirm: !!confirm, startedAt: Date.now() });
    useAppStore.getState().runAction(p.id, aId);
    close();
  };
  return (
    <div className="space-y-4 pb-2">
      {live.length > 0 && (
        <div>
          {live.map((s) => (
            <SessionRow key={s.id} session={s} detail="auto" onOpen={() => { close(); openSession(s.id, null); }} />
          ))}
        </div>
      )}
      <div className="flex gap-2 px-1">
        <button type="button" className="pl-btn pri flex-1" onClick={() => { close(); startProfile(p.id); }}>
          <Plus className="w-4 h-4" strokeWidth={2} />{live.length ? 'New instance' : 'Start a session'}
        </button>
        <button type="button" className="pl-btn" onClick={() => { close(); useAppStore.getState().editProfile(p); }}>
          <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />Edit
        </button>
      </div>
      {(p.actions?.length ?? 0) > 0 && (
        <div className="px-1">
          <h3 className="text-meta font-semibold text-fg-2 mb-2">Quick actions</h3>
          <div className="flex flex-wrap gap-2">
            {p.actions!.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`pl-btn sm${arm === a.id ? ' pri' : ''}`}
                title={a.command}
                onClick={() => run(a.id, a.name, a.command, a.confirm)}
              >
                <Play className="w-3.5 h-3.5" strokeWidth={1.75} />{arm === a.id ? `Run ${a.name}?` : a.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Manage every profile: open one, edit, reorder, add, scan for projects. */
export function ProfilesSheet({ onClose }: { onClose: () => void }) {
  const profiles = useAppStore((s) => s.profiles);
  const [reorder, setReorder] = useState(false);
  const [one, setOne] = useState<Profile | null>(null);
  const move = (id: string, dir: -1 | 1) => {
    const ids = profiles.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    useAppStore.getState().reorderProfiles(ids);
  };
  const profileFolds = useUiStore((s) => s.profileFolds);
  const toggleProfileGroup = useUiStore((s) => s.toggleProfileGroup);
  const manageRow = (p: Profile, i: number) => (
        <div key={p.id} className="flex items-center rounded-[10px] active:bg-bg-3">
          <button type="button" className="flex-1 min-w-0 flex items-center gap-3 min-h-(--pl-row-h) px-2.5 text-left" onClick={() => setOne(p)}>
            <ProfileTile name={p.name} icon={p.icon} color={p.color} size={28} />
            <span className="min-w-0 flex-1 flex flex-col">
              <span className="truncate text-[14px] font-medium text-fg-1">{p.name}</span>
              <span className="pl-mfact"><ProfileFact p={p} /></span>
            </span>
          </button>
          {reorder ? (
            <>
              <IconButton label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(p.id, -1)}>
                <ArrowUp className="w-4 h-4" strokeWidth={1.75} />
              </IconButton>
              <IconButton label={`Move ${p.name} down`} disabled={i === profiles.length - 1} onClick={() => move(p.id, 1)}>
                <ArrowDown className="w-4 h-4" strokeWidth={1.75} />
              </IconButton>
            </>
          ) : (
            <IconButton label={`Edit ${p.name}`} onClick={() => { onClose(); useAppStore.getState().editProfile(p); }}>
              <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
            </IconButton>
          )}
        </div>
      
  );
  if (one) return <ProfileSheet profile={one} onClose={() => setOne(null)} />;
  return (
    <Sheet
      title="Profiles"
      sub={`${profiles.length} saved · by category, pinned first`}
      tall
      onClose={onClose}
      headExtra={(
        <button type="button" className="pl-btn sm" aria-pressed={reorder} onClick={() => setReorder((v) => !v)}>
          {reorder ? 'Done' : 'Reorder'}
        </button>
      )}
      footer={(
        <div className="flex gap-2 px-3 py-2.5 border-t border-line">
          <button type="button" className="pl-btn flex-1" onClick={() => { onClose(); useAppStore.getState().editProfile(null); }}>
            <Plus className="w-4 h-4" strokeWidth={1.75} />New profile
          </button>
          <button type="button" className="pl-btn flex-1" onClick={() => { useAppStore.getState().discoverProfiles(); onClose(); }}>
            <ScanSearch className="w-4 h-4" strokeWidth={1.75} />Scan for projects
          </button>
        </div>
      )}
    >
      {reorder || isFlat(groupProfiles(profiles))
        ? profiles.map((p, i) => manageRow(p, i))
        : groupProfiles(profiles).map((g) => {
          const shut = profileGroupFolded(profileFolds, g.key, g.label);
          return (
            <section key={g.key} className="mt-1.5">
              <button
                type="button"
                aria-expanded={!shut}
                onClick={() => toggleProfileGroup(g.key, g.label)}
                className="w-full h-9 flex items-center gap-1.5 px-2 text-left text-meta font-semibold text-fg-2"
              >
                <ChevronRight className={`w-3.5 h-3.5 text-fg-4 transition-transform duration-(--d-move) ${shut ? '' : 'rotate-90'}`} strokeWidth={1.75} />
                <span>{g.label}</span>
                <span className="font-medium text-fg-3 tnum">{g.items.length}</span>
              </button>
              {!shut && g.items.map((p) => manageRow(p, profiles.indexOf(p)))}
            </section>
          );
        })}
    </Sheet>
  );
}
