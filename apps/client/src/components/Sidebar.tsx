/**
 * @file Sidebar
 * @description The desktop sidebar: a calm inbox, left of the panes. One
 *   Active section holds every live session (waiting first, then the rest
 *   newest-started first, so rows stay put while agents flip between working
 *   and quiet), one line per row with its state glyph and age; only the
 *   selected row (the focused pane's session) says its question. Then Ended
 *   (folded), Profiles in their categories (pinned first, Archive folded,
 *   fold state remembered) and Servers. A folded section still shows the
 *   selected row. No answer chips here: the focused pane strip is the one
 *   answer surface. The footer's Files and Settings toggle their left panel.
 *   Ctrl+Alt+B folds the sidebar to a 52px rail of glyphs and monograms. On
 *   the desktop Home tab it is always the rail, holding Home, Files and
 *   Settings only (Home already lists everything).
 */

import { useMemo, useState } from 'react';
import {
  Check, ChevronRight, FolderOpen, House, Pencil, Play, Plus, ScanSearch, Server, Settings, X,
} from 'lucide-react';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';
import { useAppStore, type ServerEntry } from '../stores/appStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useUiStore, type SidebarGroup } from '../stores/uiStore';
import { useActiveOrder } from '../lib/sessionOrder';
import { groupOf, sessionTitle, stateKey, stateWord } from '../lib/sessionState';
import { groupProfiles, isFlat } from '../lib/profileGroups';
import { profileGroupFolded } from '../stores/uiStore';
import { openSession, startProfile } from '../lib/openSession';
import { readout } from '../lib/readout';
import { SessionRow } from './ui/SessionRow';
import { ProfileTile } from './ui/ProfileTile';
import { StateGlyph } from './ui/StateGlyph';
import { IconButton } from './ui/IconButton';

const ICON = 'w-4 h-4';

/** The session in the focused pane, when that pane is on the active server. */
function useSelectedId(): string | null {
  const activeServerId = useAppStore((s) => s.activeServerId);
  return useLayoutStore((s) => {
    const p = s.panes.find((x) => x.id === s.focusedPaneId);
    if (!p || (p.serverId && p.serverId !== activeServerId)) return null;
    return p.sessionId;
  });
}

function useInView(): Set<string> {
  const panes = useLayoutStore((s) => s.panes);
  return useMemo(() => new Set(panes.map((p) => p.sessionId).filter((x): x is string => !!x)), [panes]);
}

/** Files and Settings open where they are clicked, and a second click
 *  closes them (clicking the other one swaps). */
export function togglePanel(which: 'files' | 'settings'): void {
  const app = useAppStore.getState();
  if (app.view === which) app.closeOverlay();
  else if (which === 'files') app.openFiles();
  else app.openSettings();
}

// ============================================================================
// Rows
// ============================================================================

function SidebarSession({ session, selected, inView }: { session: SessionInfo; selected: boolean; inView: boolean }) {
  const killSession = useAppStore((s) => s.killSession);
  const [confirmKill, setConfirmKill] = useState(false);
  return (
    <SessionRow
      session={session}
      density="compact"
      current={selected}
      selected={selected}
      // One line per row; only the selected row says its question.
      detail="selected"
      hint={selected ? 'In the focused pane' : inView ? 'In a pane. Click to focus it.' : 'Open in the focused pane'}
      onOpen={() => openSession(session.id, null)}
      trailing={confirmKill ? (
        <button
          type="button"
          autoFocus
          onClick={() => { killSession(session.id); setConfirmKill(false); }}
          onBlur={() => setConfirmKill(false)}
          className="h-7 px-2 rounded-[6px] text-micro font-semibold text-danger hover:bg-danger-soft"
        >
          End it?
        </button>
      ) : (
        <IconButton
          size="xs"
          label={`End ${sessionTitle(session)}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => { e.stopPropagation(); setConfirmKill(true); }}
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </IconButton>
      )}
    />
  );
}

function ProfileRow({ profile, open, onToggle }: { profile: Profile; open: boolean; onToggle: () => void }) {
  const sessions = useAppStore((s) => s.sessions);
  const health = useAppStore((s) => s.healthStatuses.find((h) => h.profileId === profile.id));
  const editProfile = useAppStore((s) => s.editProfile);
  const [actionsOpen, setActionsOpen] = useState(false);
  const live = sessions.filter((s) => s.profileId === profile.id);
  const actions = profile.actions ?? [];
  const down = health && !health.healthy;
  const tip = [profile.name, profile.cwd, down ? `Health check failing${health?.output ? `: ${health.output}` : ''}` : ''].filter(Boolean).join('\n');

  const runQuick = (actionId: string, name: string, command: string, confirm?: boolean) => {
    if (confirm && !window.confirm(`Run "${name}"?\n\n${command}`)) return;
    useUiStore.getState().setQuickRun({ profileId: profile.id, actionId, title: `${profile.name}: ${name}`, command, confirm: !!confirm, startedAt: Date.now() });
    useAppStore.getState().runAction(profile.id, actionId);
  };

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={tip}
        className={`w-full h-8 flex items-center gap-2.5 px-2 rounded-[10px] text-left transition-colors ${open ? 'bg-bg-3/60' : 'hover:bg-bg-3/60'}`}
      >
        <ProfileTile name={profile.name} color={profile.color} size={20} />
        <span className="flex-1 min-w-0 truncate text-body font-medium text-fg-1">{profile.name}</span>
        {down ? (
          <span className="shrink-0 text-micro font-medium text-danger">Down</span>
        ) : live.length > 0 ? (
          <span className="shrink-0 text-micro font-mono tnum text-fg-3">{live.length} live</span>
        ) : null}
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-fg-4 transition-transform duration-(--d-pop) ${open ? 'rotate-90' : ''}`} strokeWidth={1.75} />
      </button>
      <div className={`pl-fold${open ? '' : ' shut'}`}>
        <div inert={!open}>
          <div className="pl-2 pr-1 pt-1 pb-2 space-y-0.5">
            {live.slice(0, 3).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => openSession(s.id, null)}
                className="w-full h-7 flex items-center gap-2 px-2 rounded-[6px] text-left text-meta text-fg-2 hover:bg-bg-3/60 hover:text-fg-1"
              >
                <StateGlyph state={stateKey(s)} size={11} />
                <span className="flex-1 min-w-0 truncate">{sessionTitle(s)}</span>
                <span className="shrink-0 text-micro text-fg-3">{stateWord(s)}</span>
              </button>
            ))}
            <div className="flex items-center gap-1 pt-1">
              <button type="button" className="pl-btn sm" onClick={() => startProfile(profile.id)}>
                <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />New session
              </button>
              {actions.length > 0 && (
                <button
                  type="button"
                  className="pl-btn sm"
                  aria-expanded={actionsOpen}
                  onClick={() => setActionsOpen((v) => !v)}
                  title="Quick actions"
                >
                  <Play className="w-3.5 h-3.5" strokeWidth={1.75} />Actions
                </button>
              )}
              <IconButton size="xs" label={`Edit ${profile.name}`} className="ml-auto" onClick={() => editProfile(profile)}>
                <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
              </IconButton>
            </div>
            {actionsOpen && actions.length > 0 && (
              <div className="pt-1 space-y-0.5 motion-safe:animate-fade">
                {actions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => runQuick(a.id, a.name, a.command, a.confirm)}
                    title={a.command}
                    className="w-full h-7 flex items-center gap-2 px-2 rounded-[6px] text-left text-meta text-fg-2 hover:bg-bg-3/60 hover:text-fg-1"
                  >
                    <Play className="w-3 h-3 text-fg-3" strokeWidth={1.75} />
                    <span className="truncate">{a.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerRow({ entry }: { entry: ServerEntry }) {
  const activeServerId = useAppStore((s) => s.activeServerId);
  const connectionState = useAppStore((s) => s.connectionState);
  const rttMs = useAppStore((s) => s.rttMs);
  const active = entry.id === activeServerId;
  const r = readout(connectionState, rttMs);
  const name = entry.serverName || entry.label;
  return (
    <button
      type="button"
      onClick={() => (active ? useAppStore.getState().openServers() : useAppStore.getState().selectServer(entry.id))}
      title={active ? `${name} · ${r.text}. Click to manage servers.` : `Switch to ${name}`}
      className="w-full h-8 flex items-center gap-2.5 px-2.5 rounded-[10px] text-left hover:bg-bg-3/60"
    >
      <i
        aria-hidden
        className={`w-1.5 h-1.5 shrink-0 rounded-full ${active && r.kind === 'ok' ? 'bg-accent' : active && r.kind === 'slow' ? 'shadow-[inset_0_0_0_1.5px_var(--color-accent)]' : 'shadow-[inset_0_0_0_1.25px_var(--color-fg-3)]'}`}
      />
      <span className={`flex-1 min-w-0 truncate font-mono text-meta ${active ? 'text-fg-1' : 'text-fg-2'}`}>{name}</span>
      <span className={`shrink-0 text-micro font-mono tnum ${r.kind === 'slow' ? 'text-fg-1' : active && r.kind !== 'ok' ? 'text-st-disconnected' : 'text-fg-3'}`}>
        {active ? r.text : 'switch'}
      </span>
    </button>
  );
}

// ============================================================================
// Group section
// ============================================================================

function Section({ id, label, count, children, extra, pin, tone }: {
  id: SidebarGroup;
  label: string;
  count: number;
  children: React.ReactNode;
  extra?: React.ReactNode;
  /** Kept visible under a folded header (the selected row). */
  pin?: React.ReactNode;
  tone?: 'needs';
}) {
  const folded = useUiStore((s) => s.folded[id]);
  const toggleGroup = useUiStore((s) => s.toggleGroup);
  return (
    <section className="pb-1">
      <div className="pl-sbh">
        <button type="button" className={`gh${tone === 'needs' ? ' needs' : ''}`} aria-expanded={!folded} onClick={() => toggleGroup(id)}>
          <ChevronRight className="chev w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{label}</span>
          <span className="n">{count}</span>
        </button>
        {extra}
      </div>
      {folded && pin}
      <div className={`pl-fold${folded ? ' shut' : ''}`}>
        <div inert={folded}><div className="space-y-px">{children}</div></div>
      </div>
    </section>
  );
}

// ============================================================================
// Rail
// ============================================================================

function Rail({ homeOnly }: { homeOnly: boolean }) {
  const sessions = useAppStore((s) => s.sessions);
  const profiles = useAppStore((s) => s.profiles);
  const view = useAppStore((s) => s.view);
  const filesDisabled = useAppStore((s) => s.filesDisabled);
  const home = useLayoutStore((s) => s.home);
  const ordered = useActiveOrder(sessions);
  const selectedId = useSelectedId();
  // Waiting glyphs, a hairline, then the rest: the Active list, in miniature.
  const needs = ordered.filter((s) => groupOf(stateKey(s)) === 'needs');
  const groups = [{ id: 'needs', items: needs }, { id: 'rest', items: ordered.filter((s) => groupOf(stateKey(s)) !== 'needs') }]
    .filter((g) => g.items.length > 0);
  const pinned = profiles.filter((p) => p.pinned);
  const railProfiles = pinned.length > 0 ? pinned : profiles.slice(0, 6);

  const homeOn = home && view !== 'files' && view !== 'settings' && view !== 'profile-editor';
  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col items-center gap-1 py-2">
        {homeOnly ? (
          <button
            type="button"
            className={`pl-railb${homeOn ? ' on' : ''}`}
            title="Home: who needs you (Ctrl+Alt+H)"
            aria-label="Home"
            aria-current={homeOn ? 'page' : undefined}
            onClick={() => { useAppStore.getState().closeOverlay(); useLayoutStore.getState().showHome(); }}
          >
            <House className={ICON} strokeWidth={1.75} />
          </button>
        ) : (
          <>
            {groups.map((g, gi) => (
              <div key={g.id} className={`flex flex-col items-center gap-0.5 ${gi > 0 ? 'pt-1.5 mt-1 border-t border-line w-9' : ''}`}>
                {g.items.map((s) => {
                  const k = stateKey(s);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`pl-railb${s.id === selectedId ? ' on' : ''}`}
                      title={`${sessionTitle(s)} · ${stateWord(s, k)}${s.preview ? `\n${s.preview}` : ''}`}
                      aria-label={`${sessionTitle(s)}, ${stateWord(s, k)}`}
                      onClick={() => openSession(s.id, null)}
                    >
                      <StateGlyph state={k} size={12} live={s.id === selectedId} />
                    </button>
                  );
                })}
              </div>
            ))}
            {railProfiles.length > 0 && (
              <div className="flex flex-col items-center gap-0.5 pt-1.5 mt-1 border-t border-line w-9">
                {railProfiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="pl-railb"
                    title={`${p.name}: open its session, or start one`}
                    aria-label={`${p.name}: open or start`}
                    onClick={() => {
                      const existing = sessions.find((s) => s.profileId === p.id);
                      if (existing) openSession(existing.id, null);
                      else startProfile(p.id);
                    }}
                  >
                    <ProfileTile name={p.name} color={p.color} size={22} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="shrink-0 flex flex-col items-center gap-1 py-2 border-t border-line">
        {!filesDisabled && (
          <button type="button" className={`pl-railb${view === 'files' ? ' on' : ''}`} title="Files (Ctrl+Alt+F)" aria-label="Files" aria-pressed={view === 'files'} data-panel-toggle onClick={() => togglePanel('files')}>
            <FolderOpen className={ICON} strokeWidth={1.75} />
          </button>
        )}
        <button type="button" className={`pl-railb${view === 'settings' ? ' on' : ''}`} title="Settings (Ctrl+Alt+,)" aria-label="Settings" aria-pressed={view === 'settings'} data-panel-toggle onClick={() => togglePanel('settings')}>
          <Settings className={ICON} strokeWidth={1.75} />
        </button>
      </div>
    </>
  );
}

// ============================================================================
// Sidebar
// ============================================================================

export function Sidebar() {
  const sessions = useAppStore((s) => s.sessions);
  const profiles = useAppStore((s) => s.profiles);
  const servers = useAppStore((s) => s.servers);
  const view = useAppStore((s) => s.view);
  const filesDisabled = useAppStore((s) => s.filesDisabled);
  const mode = useUiStore((s) => s.sidebar);
  const profileFolds = useUiStore((s) => s.profileFolds);
  const toggleProfileGroup = useUiStore((s) => s.toggleProfileGroup);
  const home = useLayoutStore((s) => s.home);
  const ordered = useActiveOrder(sessions);
  const selectedId = useSelectedId();
  const inView = useInView();
  const [openProfile, setOpenProfile] = useState<string | null>(null);

  // On Home the groups are already the page: the sidebar steps back to a rail.
  const onHome = home;
  const rail = mode === 'rail' || onHome;

  const active = useMemo(() => ordered.filter((s) => groupOf(stateKey(s)) !== 'ended'), [ordered]);
  const ended = useMemo(() => ordered.filter((s) => groupOf(stateKey(s)) === 'ended'), [ordered]);
  const waiting = active.filter((s) => groupOf(stateKey(s)) === 'needs').length;
  const profileGroups = useMemo(() => groupProfiles(profiles), [profiles]);
  const flat = isFlat(profileGroups);

  const row = (s: SessionInfo) => (
    <SidebarSession key={s.id} session={s} selected={s.id === selectedId} inView={inView.has(s.id)} />
  );
  const profileRow = (p: Profile) => (
    <ProfileRow key={p.id} profile={p} open={openProfile === p.id} onToggle={() => setOpenProfile((cur) => (cur === p.id ? null : p.id))} />
  );

  return (
    <nav className={`pl-sb${rail ? ' rail' : ''}`} aria-label="Sessions">
      {rail ? <Rail homeOnly={onHome} /> : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pt-2 pb-2">
            {active.length > 0 ? (
              <Section
                id="active"
                label="Active"
                count={active.length}
                extra={waiting > 0 ? <span className="pl-sbwait" title={`${waiting} waiting for you`}><StateGlyph state="waiting" size={9} />{waiting}</span> : undefined}
                pin={(() => { const sel = active.find((s) => s.id === selectedId); return sel ? <div className="pb-1">{row(sel)}</div> : undefined; })()}
              >
                {active.map(row)}
              </Section>
            ) : (
              <section className="pb-1">
                <div className="pl-sbh"><span className="gh calm"><Check className="w-3.5 h-3.5 text-accent" strokeWidth={2} />No live sessions</span></div>
              </section>
            )}

            {ended.length > 0 && (
              <Section id="ended" label="Ended" count={ended.length}>
                {ended.map(row)}
              </Section>
            )}

            <Section
              id="profiles"
              label="Profiles"
              count={profiles.length}
              extra={(
                <>
                  <IconButton size="xs" label="Scan for projects" onClick={() => useAppStore.getState().discoverProfiles()}>
                    <ScanSearch className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </IconButton>
                  <IconButton size="xs" label="New profile" onClick={() => useAppStore.getState().editProfile(null)}>
                    <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </IconButton>
                </>
              )}
            >
              {flat
                ? profileGroups.flatMap((g) => g.items).map(profileRow)
                : profileGroups.map((g) => {
                  const shut = profileGroupFolded(profileFolds, g.key, g.label);
                  return (
                    <div key={g.key} className="pb-0.5">
                      <button
                        type="button"
                        className="pl-sbcat"
                        aria-expanded={!shut}
                        onClick={() => toggleProfileGroup(g.key, g.label)}
                      >
                        <ChevronRight className="chev w-3 h-3 shrink-0" strokeWidth={1.75} />
                        <span className="truncate">{g.label}</span>
                        <span className="n">{g.items.length}</span>
                      </button>
                      <div className={`pl-fold${shut ? ' shut' : ''}`}>
                        <div inert={shut}><div className="space-y-px">{g.items.map(profileRow)}</div></div>
                      </div>
                    </div>
                  );
                })}
              {profiles.length === 0 && (
                <button type="button" className="pl-more" onClick={() => useAppStore.getState().editProfile(null)}>
                  <Plus className="w-3.5 h-3.5" strokeWidth={1.75} /><span>New profile</span>
                </button>
              )}
            </Section>

            {servers.length > 0 && (
              <Section
                id="servers"
                label="Servers"
                count={servers.length}
                extra={(
                  <IconButton size="xs" label="Manage servers" onClick={() => useAppStore.getState().openServers()}>
                    <Server className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </IconButton>
                )}
              >
                {servers.map((e) => <ServerRow key={e.id} entry={e} />)}
              </Section>
            )}
          </div>

          <div className="shrink-0 flex items-center gap-0.5 px-2 py-1.5 border-t border-line">
            {!filesDisabled && (
              <button
                type="button"
                onClick={() => togglePanel('files')}
                aria-pressed={view === 'files'}
                data-panel-toggle
                title="Files (Ctrl+Alt+F)"
                className={`h-8 flex items-center gap-2 px-2.5 rounded-[6px] text-body ${view === 'files' ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:text-fg-1 hover:bg-bg-3/60'}`}
              >
                <FolderOpen className={ICON} strokeWidth={1.75} />Files
              </button>
            )}
            <button
              type="button"
              onClick={() => togglePanel('settings')}
              aria-pressed={view === 'settings'}
              data-panel-toggle
              title="Settings (Ctrl+Alt+,)"
              className={`h-8 flex items-center gap-2 px-2.5 rounded-[6px] text-body ${view === 'settings' ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:text-fg-1 hover:bg-bg-3/60'}`}
            >
              <Settings className={ICON} strokeWidth={1.75} />Settings
            </button>
            <IconButton
              label="New shell session in the focused pane"
              className="ml-auto"
              onClick={() => {
                const layout = useLayoutStore.getState();
                layout.markPendingAssign(layout.focusedPaneId);
                useAppStore.getState().createSession();
                useAppStore.getState().closeOverlay();
              }}
            >
              <Plus className={ICON} strokeWidth={1.75} />
            </IconButton>
          </div>
        </>
      )}
    </nav>
  );
}
