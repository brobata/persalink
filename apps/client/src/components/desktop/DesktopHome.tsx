/**
 * @file DesktopHome
 * @description The desktop Home tab: the three-second answer to "what needs
 *   me". It leads with "N agents need you", one line naming the longest
 *   wait, and one solid "Open next waiting" (only when two or more wait;
 *   with one, that card's first answer is the accent). Then the shared
 *   one Active section: the Needs-you card per waiting agent, with its
 *   answers inline (at most three, then "+N more waiting · Show all"), then
 *   every other live session as one line in a stable order. Ended folds to
 *   one line; the profiles as tiles in their categories (click opens its
 *   session or starts one; hold or Shift+click starts a new one) and the
 *   servers. The sidebar steps back to a rail here.
 */

import { useState } from 'react';
import { ArrowRight, ChevronRight, Plus } from 'lucide-react';
import type { Profile } from '@persalink/shared/protocol';
import { useAppStore, type ServerEntry } from '../../stores/appStore';
import { useActiveOrder, waitAge } from '../../lib/sessionOrder';
import { countStates, groupOf, needsSentence, sessionTitle, stateKey, stateWord } from '../../lib/sessionState';
import { groupProfiles, isFlat } from '../../lib/profileGroups';
import { profileGroupFolded } from '../../stores/uiStore';
import { openSession, openSessionToReply, startProfile } from '../../lib/openSession';
import { sentSentence } from '../../lib/statusLine';
import { useUiStore } from '../../stores/uiStore';
import { WaitCard } from '../ui/WaitCard';
import { useLongPress } from '../../lib/useLongPress';
import { readout } from '../../lib/readout';
import { StateGlyph } from '../ui/StateGlyph';
import { ProfileTile } from '../ui/ProfileTile';

const CAP = 3;

function ProfileCard({ p }: { p: Profile }) {
  const sessions = useAppStore((s) => s.sessions);
  const health = useAppStore((s) => s.healthStatuses.find((h) => h.profileId === p.id));
  const live = sessions.filter((s) => s.profileId === p.id);
  const lead = live[0];
  const down = health && !health.healthy;
  const open = (e?: React.MouseEvent) => {
    if (lead && !(e && (e.shiftKey || e.altKey))) openSession(lead.id, null);
    else startProfile(p.id);
  };
  const press = useLongPress(() => startProfile(p.id), (e: React.MouseEvent) => open(e));
  return (
    <button
      type="button"
      {...press}
      title={`${p.name}${p.cwd ? ` · ${p.cwd}` : ''}\nClick: ${lead ? 'open its session' : 'start a session'}. Hold or Shift+click: a new one.`}
      className="pl-home-card h-14 flex items-center gap-3 px-3 text-left hover:border-line-3 transition-colors"
    >
      <ProfileTile name={p.name} color={p.color} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold text-fg-1">{p.name}</span>
        <span className={`flex items-center gap-1.5 text-meta ${down ? 'text-danger' : 'text-fg-3'}`}>
          {down ? 'Health check failing'
            : lead ? (<><StateGlyph state={stateKey(lead)} size={10} />{live.length} live</>)
            : 'Start a session'}
        </span>
      </span>
    </button>
  );
}

function ServerLine({ e }: { e: ServerEntry }) {
  const activeServerId = useAppStore((s) => s.activeServerId);
  const state = useAppStore((s) => s.connectionState);
  const rttMs = useAppStore((s) => s.rttMs);
  const active = e.id === activeServerId;
  const r = readout(state, rttMs);
  return (
    <button
      type="button"
      onClick={() => (active ? useAppStore.getState().openServers() : useAppStore.getState().selectServer(e.id))}
      className="w-full h-10 flex items-center gap-3 px-4 text-left hover:bg-bg-2 first:rounded-t-[14px] last:rounded-b-[14px]"
    >
      <i aria-hidden className={`w-1.5 h-1.5 rounded-full ${active && r.kind === 'ok' ? 'bg-accent' : 'shadow-[inset_0_0_0_1.25px_var(--color-fg-3)]'}`} />
      <span className="font-mono text-meta text-fg-1">{e.serverName || e.label}</span>
      <span className="ml-auto text-micro font-mono tnum text-fg-3">{active ? r.text : 'Switch to it'}</span>
    </button>
  );
}

export function DesktopHome() {
  const sessions = useAppStore((s) => s.sessions);
  const profiles = useAppStore((s) => s.profiles);
  const servers = useAppStore((s) => s.servers);
  const openNextWaiting = useAppStore((s) => s.openNextWaiting);
  const ordered = useActiveOrder(sessions);
  const profileFolds = useUiStore((s) => s.profileFolds);
  const [all, setAll] = useState(false);
  const [unfold, setUnfold] = useState<Record<string, boolean>>({});

  const needs = ordered.filter((s) => groupOf(stateKey(s)) === 'needs');
  const rest = ordered.filter((s) => { const g = groupOf(stateKey(s)); return g !== 'needs' && g !== 'ended'; });
  const ended = ordered.filter((s) => groupOf(stateKey(s)) === 'ended');
  const profileGroups = groupProfiles(profiles);
  const flatProfiles = isFlat(profileGroups);
  const c = countStates(sessions);
  const first = needs[0];
  const shownNeeds = all ? needs : needs.slice(0, CAP);
  const more = needs.length - shownNeeds.length;

  const lead = first
    ? `${sessionTitle(first)} has waited longest, ${waitAge(first)}`
    : sessions.length ? 'Every agent is working or quiet' : 'No sessions yet. Start one from a profile below.';
  const tail = c.working ? ` · ${c.working} working` : '';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-8 pt-10 pb-16">
        <header className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <h1 className="text-display font-semibold text-fg-1">{needsSentence(needs.length)}</h1>
            <p className="mt-1 text-body text-fg-2">
              {first ? <><span className="text-st-waiting font-medium">{sessionTitle(first)}</span>{lead.slice(sessionTitle(first).length)}</> : lead}{tail}
            </p>
          </div>
          {needs.length >= 2 && (
            <button type="button" className="pl-btn pri shrink-0 mt-1" onClick={() => openNextWaiting()} title="Ctrl+Alt+J">
              Open next waiting<ArrowRight className="w-4 h-4" strokeWidth={2} />
            </button>
          )}
        </header>

        {needs.length + rest.length > 0 && (
          <section className="mt-8" aria-label="Active sessions, waiting first">
            <h2 className="flex items-baseline gap-2 text-title font-semibold text-fg-1">Active<span className="text-meta font-medium text-fg-3 tnum">{needs.length + rest.length}</span></h2>
            {needs.length > 0 && (
              <div className="mt-2.5 space-y-2.5">
                {shownNeeds.map((s) => (
                  <WaitCard
                    key={s.id}
                    session={s}
                    variant="desktop"
                    accent={needs.length === 1}
                    onOpen={(x) => openSession(x.id, null)}
                    onReply={(x) => openSessionToReply(x.id)}
                    onSent={(x, label) => useUiStore.getState().say(sentSentence(label, sessionTitle(x)))}
                    onNotSent={(x, why) => why === 'changed'
                      ? useUiStore.getState().say(`${sessionTitle(x)} is no longer asking that. Nothing was typed.`)
                      : useAppStore.getState().pushNotification('error', `Could not reach ${sessionTitle(x)}. Nothing was typed; open it to answer.`)}
                  />
                ))}
                {more > 0 && (
                  <button type="button" className="pl-more" onClick={() => setAll(true)}>
                    <StateGlyph state="waiting" size={10} /><span>+{more} more waiting</span><span className="sa">Show all</span>
                  </button>
                )}
              </div>
            )}
            {rest.length > 0 && (
              <div className="mt-2.5 pl-home-card divide-y divide-line overflow-hidden">
                {rest.map((s) => (
                  <button key={s.id} type="button" onClick={() => openSession(s.id, null)} className="w-full h-10 flex items-center gap-2.5 px-4 text-left hover:bg-bg-2">
                    <StateGlyph state={stateKey(s)} size={12} />
                    <span className="min-w-0 truncate text-body font-medium text-fg-1">{sessionTitle(s)}</span>
                    <span className="ml-auto shrink-0 text-micro font-mono tnum text-fg-3">{stateWord(s)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {ended.length > 0 && (
          <section className="mt-6">
            <button
              type="button"
              aria-expanded={!!unfold.ended}
              onClick={() => setUnfold((u) => ({ ...u, ended: !u.ended }))}
              className="h-8 flex items-center gap-2 text-left"
            >
              <ChevronRight className={`w-3.5 h-3.5 text-fg-4 transition-transform duration-(--d-pop) ${unfold.ended ? 'rotate-90' : ''}`} strokeWidth={1.75} />
              <span className="text-body font-semibold text-fg-1">Ended</span>
              <span className="text-meta text-fg-3 tnum">{ended.length}</span>
            </button>
            <div className={`pl-fold${unfold.ended ? '' : ' shut'}`}>
              <div inert={!unfold.ended}>
                <div className="pl-home-card divide-y divide-line overflow-hidden mt-1 mb-2">
                  {ended.map((s) => (
                    <button key={s.id} type="button" onClick={() => openSession(s.id, null)} className="w-full h-10 flex items-center gap-2.5 px-4 text-left hover:bg-bg-2">
                      <StateGlyph state={stateKey(s)} size={12} />
                      <span className="text-body text-fg-1">{sessionTitle(s)}</span>
                      <span className="ml-auto text-micro font-mono tnum text-fg-3">{stateWord(s)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="mt-9">
          <div className="flex items-center gap-2">
            <h2 className="flex items-baseline gap-2 text-title font-semibold text-fg-1">Profiles<span className="text-meta font-medium text-fg-3 tnum">{profiles.length}</span></h2>
            <button type="button" className="pl-btn sm ghost ml-auto" onClick={() => useAppStore.getState().editProfile(null)}>
              <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />New profile
            </button>
          </div>
          {flatProfiles ? (
            <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
              {profileGroups.flatMap((g) => g.items).map((p) => <ProfileCard key={p.id} p={p} />)}
            </div>
          ) : profileGroups.map((g) => {
            const shut = profileGroupFolded(profileFolds, g.key, g.label);
            return (
              <div key={g.key} className="mt-3">
                <button
                  type="button"
                  aria-expanded={!shut}
                  onClick={() => useUiStore.getState().toggleProfileGroup(g.key, g.label)}
                  className="h-7 flex items-center gap-1.5 text-left text-meta font-semibold text-fg-2 hover:text-fg-1"
                >
                  <ChevronRight className={`w-3.5 h-3.5 text-fg-4 transition-transform duration-(--d-pop) ${shut ? '' : 'rotate-90'}`} strokeWidth={1.75} />
                  {g.label}<span className="font-medium text-fg-3 tnum">{g.items.length}</span>
                </button>
                <div className={`pl-fold${shut ? ' shut' : ''}`}>
                  <div inert={shut}>
                    <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                      {g.items.map((p) => <ProfileCard key={p.id} p={p} />)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        {servers.length > 0 && (
          <section className="mt-9">
            <h2 className="flex items-baseline gap-2 text-title font-semibold text-fg-1">Servers<span className="text-meta font-medium text-fg-3 tnum">{servers.length}</span></h2>
            <div className="mt-2.5 pl-home-card divide-y divide-line">
              {servers.map((e) => <ServerLine key={e.id} e={e} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
