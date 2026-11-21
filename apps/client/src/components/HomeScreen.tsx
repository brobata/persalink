/**
 * @file HomeScreen
 * @description Phone Home, the agent inbox (the Titan runs the same screen,
 *   tightened by html.pl-square). First glance answers "what needs me":
 *   "N agents need you" and who waited longest, then one Active section
 *   with every live session: a card per waiting agent with its answers
 *   inline (at most three, then "+N more waiting"), then every other session
 *   as a one-line row in a stable order (newest started first, so rows do
 *   not jump when an agent flips between working and quiet). Ended folds
 *   to a summary line,
 *   profiles as a chip rail (tap opens, hold starts a new one), and the
 *   servers last and quiet. On the Titan the headline moves into the header
 *   ("2 need you · 2 working") so both waiting cards fit above the dock.
 *   The shared phone header, dock, sheets and rows come from components/ui.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Ellipsis, FolderOpen, Pencil, Plus, Rows3, Settings, SquareTerminal, X } from 'lucide-react';
import type { SessionInfo } from '@persalink/shared/protocol';
import { useAppStore, type ServerEntry } from '../stores/appStore';
import { useUiStore } from '../stores/uiStore';
import { usePullToRefresh } from '../lib/usePullToRefresh';
import { useActiveOrder, waitAge } from '../lib/sessionOrder';
import { countStates, groupOf, needsSentence, sessionTitle, stateKey } from '../lib/sessionState';
import { openSession, openSessionToReply } from '../lib/openSession';
import { readout } from '../lib/readout';
import { sentSentence } from '../lib/statusLine';
import { PhoneHeader, HeaderFlash } from './ui/PhoneHeader';
import { ConnectionReadout } from './ui/ConnectionReadout';
import { Dock, type DockItem } from './ui/Dock';
import { WaitCard } from './ui/WaitCard';
import { SessionRow } from './ui/SessionRow';
import { StateGlyph } from './ui/StateGlyph';
import { IconButton } from './ui/IconButton';
import { ProfileRail } from './ui/ProfileRail';
import { SessionSwitcher, NewSessionSheet } from './ui/SessionSwitcher';
import { MoreSheet } from './ui/MoreSheet';
import { Sheet, useSheetClose } from './ui/Sheet';

const CAP = 3;
const FOLD_KEY = 'persalink-home-fold';

function readFold(): Record<'ended', boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(FOLD_KEY) || 'null') as Partial<Record<'ended', boolean>> | null;
    return { ended: v?.ended ?? true };
  } catch {
    return { ended: true };
  }
}

function useSquare(): boolean {
  const [sq, setSq] = useState(() => document.documentElement.classList.contains('pl-square'));
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => setSq(el.classList.contains('pl-square')));
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return sq;
}

/**
 * Rows that change group move there instead of jumping (FLIP, 200ms), and a
 * row that arrives glows once. Reads [data-flip] positions inside `root`
 * after every render; reduced motion skips it.
 */
function useFlip(root: React.RefObject<HTMLElement | null>, dep: unknown) {
  const last = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const base = el.getBoundingClientRect().top;
    const next = new Map<string, number>();
    el.querySelectorAll<HTMLElement>('[data-flip]').forEach((n) => {
      const id = n.dataset.flip!;
      const top = n.getBoundingClientRect().top - base;
      next.set(id, top);
      const was = last.current.get(id);
      if (reduce || last.current.size === 0) return;
      if (was === undefined) {
        n.classList.remove('pl-arrived');
        void n.offsetWidth;
        n.classList.add('pl-arrived');
      } else if (Math.abs(was - top) > 1) {
        n.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    });
    last.current = next;
  }, [root, dep]);
}

function ServerButton({ e }: { e: ServerEntry }) {
  const activeServerId = useAppStore((s) => s.activeServerId);
  const state = useAppStore((s) => s.connectionState);
  const rttMs = useAppStore((s) => s.rttMs);
  const active = e.id === activeServerId;
  const r = readout(state, rttMs);
  return (
    <button
      type="button"
      className={`pl-srv${active && r.kind === 'slow' ? ' slow' : ''}${active ? '' : ' off'}`}
      onClick={() => (active ? useAppStore.getState().openServers() : useAppStore.getState().selectServer(e.id))}
      title={active ? 'Servers' : `Switch to ${e.serverName || e.label}`}
    >
      <i className="dot" aria-hidden />
      <b>{e.serverName || e.label}</b>
      <span className="ms tnum">{active ? r.text : 'Switch'}</span>
    </button>
  );
}

function RenameSheet({ s, onClose }: { s: SessionInfo; onClose: () => void }) {
  const [name, setName] = useState(s.name || s.profileName || '');
  return (
    <Sheet title="Rename session" sub={s.id} onClose={onClose}>
      <RenameBody s={s} name={name} setName={setName} />
    </Sheet>
  );
}

function RenameBody({ s, name, setName }: { s: SessionInfo; name: string; setName: (v: string) => void }) {
  const close = useSheetClose();
  const save = () => {
    const t = name.trim();
    if (t && t !== s.name) useAppStore.getState().renameSession(s.id, t);
    close();
  };
  return (
    <form className="px-2 pb-2 space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Session name"
        autoFocus
        className="w-full h-11 px-3 bg-bg-1 border border-line-2 rounded-[8px] text-[16px] text-fg-1 outline-none focus:border-line-3"
      />
      <button type="submit" className="pl-btn pri w-full">Save</button>
    </form>
  );
}

function KillSheet({ s, onClose }: { s: SessionInfo; onClose: () => void }) {
  return (
    <Sheet title={`Kill ${sessionTitle(s)}?`} sub="Stops the tmux session and everything running in it." onClose={onClose}>
      <KillBody s={s} />
    </Sheet>
  );
}

function KillBody({ s }: { s: SessionInfo }) {
  const close = useSheetClose();
  return (
    <div className="flex gap-2 px-2 pb-2">
      <button type="button" className="pl-btn flex-1" onClick={close}>Keep it</button>
      <button type="button" className="pl-btn flex-1 !text-danger !border-[rgba(242,85,90,0.35)]" onClick={() => { useAppStore.getState().killSession(s.id); close(); }}>
        <X className="w-4 h-4" strokeWidth={1.75} />Kill session
      </button>
    </div>
  );
}

export function HomeScreen() {
  const sessions = useAppStore((s) => s.sessions);
  const profiles = useAppStore((s) => s.profiles);
  const servers = useAppStore((s) => s.servers);
  const filesDisabled = useAppStore((s) => s.filesDisabled);
  const refresh = useAppStore((s) => s.refresh);
  const ordered = useActiveOrder(sessions);
  const square = useSquare();

  const [showAll, setShowAll] = useState(false);
  const [fold, setFold] = useState(readFold);
  const [sheet, setSheet] = useState<null | 'switcher' | 'new'>(null);
  const [menu, setMenu] = useState<SessionInfo | null>(null);
  const [rename, setRename] = useState<SessionInfo | null>(null);
  const [kill, setKill] = useState<SessionInfo | null>(null);
  const [flash, setFlash] = useState<{ text: string; id: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const say = useCallback((text: string) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash({ text, id: Date.now() });
    flashTimer.current = setTimeout(() => setFlash(null), 2400);
  }, []);

  const toggleFold = (g: 'ended') => setFold((f) => {
    const next = { ...f, [g]: !f[g] };
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* per-viewer nicety only */ }
    return next;
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onRefresh = useCallback(() => refresh(), [refresh]);
  const { pullDistance, phase, triggerDistance } = usePullToRefresh(scrollRef, onRefresh);
  const pullProgress = Math.min(1, pullDistance / triggerDistance);
  const animatePull = phase !== 'pulling';

  const needs = ordered.filter((s) => groupOf(stateKey(s)) === 'needs');
  const rest = ordered.filter((s) => { const g = groupOf(stateKey(s)); return g !== 'needs' && g !== 'ended'; });
  const ended = ordered.filter((s) => groupOf(stateKey(s)) === 'ended');
  const live = needs.length + rest.length;
  const c = countStates(sessions);
  const shownNeeds = showAll ? needs : needs.slice(0, CAP);
  const more = needs.length - shownNeeds.length;
  useFlip(listRef, ordered.map((s) => `${s.id}:${stateKey(s)}`).join('|'));

  const first = needs[0];
  const headline = needs.length === 1 ? `${sessionTitle(first)} needs you` : needsSentence(needs.length);
  const lead = first
    ? <><b>{sessionTitle(first)}</b> has waited longest, <span className="tnum">{waitAge(first)}</span>{c.working ? ` · ${c.working} working` : ''}</>
    : c.working ? `${c.working} working · the rest is quiet`
    : sessions.length ? 'Everything is quiet.'
    : 'Nothing is running. Start something from a profile.';

  let line2;
  if (flash) line2 = <HeaderFlash key={flash.id}>{flash.text}</HeaderFlash>;
  else if (square && needs.length) {
    line2 = (
      <span className="truncate">
        <span className="text-st-waiting font-medium">{needs.length} need{needs.length === 1 ? 's' : ''} you</span>
        {c.working ? ` · ${c.working} working` : ''}
      </span>
    );
  } else {
    line2 = (
      <>
        <span className="tnum">{sessions.length} live</span>
        <span className="sep" aria-hidden>·</span>
        <ConnectionReadout server />
      </>
    );
  }

  const onSent = useCallback((s: SessionInfo, label: string) => say(sentSentence(label, sessionTitle(s))), [say]);
  const onNotSent = useCallback((s: SessionInfo, why: 'changed' | 'failed') => {
    useAppStore.getState().pushNotification(
      why === 'changed' ? 'info' : 'error',
      why === 'changed'
        ? `${sessionTitle(s)} is no longer asking that. Nothing was typed.`
        : `Could not reach ${sessionTitle(s)}. Nothing was typed; open it to answer.`,
    );
  }, []);

  const rowMenu = (s: SessionInfo) => (
    <IconButton label={`Actions for ${sessionTitle(s)}`} onClick={(e) => { e.stopPropagation(); setMenu(s); }}>
      <Ellipsis className="w-4 h-4" strokeWidth={1.75} />
    </IconButton>
  );

  const folded = (id: 'ended', label: string, items: SessionInfo[]) => {
    if (!items.length) return null;
    const shut = fold[id];
    const sum = `${items.length} ended or offline`;
    return (
      <section className="pl-hgrp quietish" data-sec={id}>
        <button type="button" className="pl-gh fold" aria-expanded={!shut} onClick={() => toggleFold(id)}>
          <ChevronRight className="chev w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
          <span>{label}</span>
          <span className="cnt tnum">{items.length}</span>
          <span className="sum">{sum}</span>
        </button>
        <div className={`pl-fold${shut ? ' shut' : ''}`}>
          <div inert={shut}>
            <div className="pl-rows">
              {items.map((s) => (
                <div key={s.id} data-flip={s.id}>
                  <SessionRow session={s} detail="auto" onOpen={() => openSession(s.id, null)} onLongPress={() => setMenu(s)} trailing={rowMenu(s)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    );
  };

  const dockItems: DockItem[] = [
    { id: 'sessions', icon: <Rows3 />, label: 'Sessions', onPress: () => setSheet('switcher') },
    // One accent per screen: with someone waiting, the first card has it.
    { id: 'new', icon: <Plus />, label: 'New', primary: needs.length === 0, onPress: () => setSheet('new') },
    ...(filesDisabled ? [] : [{ id: 'files', icon: <FolderOpen />, label: 'Files', onPress: () => useAppStore.getState().openFiles() }]),
    { id: 'settings', icon: <Settings />, label: 'Settings', onPress: () => useAppStore.getState().openSettings() },
  ];

  return (
    <div className="flex flex-col h-full min-w-0 bg-bg-0">
      <PhoneHeader name="Home" line2={line2} onSearch={() => useUiStore.getState().openPalette()} />

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto relative"
        style={{ overscrollBehaviorY: 'contain', touchAction: 'pan-y' }}
      >
        {/* Pull to refresh: a ring in the gap the content leaves. */}
        <div
          className="absolute left-0 right-0 top-0 flex items-center justify-center pointer-events-none"
          style={{
            height: pullDistance,
            opacity: pullDistance > 8 ? 1 : 0,
            transition: animatePull ? 'height 200ms ease-out, opacity 150ms' : 'none',
          }}
        >
          <div
            className={`w-5 h-5 rounded-full border-2 border-line-3 ${phase === 'refreshing' ? 'border-t-fg-1 motion-safe:animate-spin' : ''}`}
            style={{ transform: phase === 'refreshing' ? undefined : `rotate(${pullProgress * 270}deg)` }}
          />
        </div>

        <div
          ref={listRef}
          className="pl-home"
          style={{ transform: pullDistance ? `translateY(${pullDistance}px)` : undefined, transition: animatePull ? 'transform 200ms ease-out' : 'none' }}
        >
          <header className="pl-hhead">
            <h1>{headline}</h1>
            <p>{lead}</p>
          </header>

          {live > 0 && (
            <section className="pl-hgrp" data-sec="active" aria-label="Active sessions, waiting first">
              <h2 className="pl-gh">Active<span className="cnt tnum">{live}</span></h2>
              {needs.length > 0 && (
                <div className="pl-wlist">
                  {shownNeeds.map((s, i) => (
                    <WaitCard
                      key={s.id}
                      session={s}
                      variant="touch"
                      accent={i === 0}
                      onOpen={(x) => openSession(x.id, null)}
                      onReply={(x) => openSessionToReply(x.id)}
                      onSent={onSent}
                      onNotSent={onNotSent}
                    />
                  ))}
                </div>
              )}
              {more > 0 && (
                <button type="button" className="pl-morewait" onClick={() => setShowAll(true)}>
                  <StateGlyph state="waiting" size={10} />
                  <span>+{more} more waiting</span>
                  <span className="sa">Show all</span>
                </button>
              )}
              {rest.length > 0 && (
                <div className={`pl-rows${needs.length ? ' mt-2' : ''}`}>
                  {rest.map((s) => (
                    <div key={s.id} data-flip={s.id}>
                      <SessionRow session={s} detail="never" onOpen={() => openSession(s.id, null)} onLongPress={() => setMenu(s)} trailing={rowMenu(s)} />
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {folded('ended', 'Ended', ended)}

          {sessions.length === 0 && (
            <div className="pl-calm">
              <SquareTerminal className="w-4 h-4 text-accent" strokeWidth={1.75} aria-hidden />
              <span className="flex-1 min-w-0">No sessions yet.</span>
              <button type="button" className="pl-btn sm" onClick={() => setSheet('new')}>New session</button>
            </div>
          )}

          <ProfileRail profiles={profiles} />

          {servers.length > 0 && (
            <section className="pl-hgrp servers" data-sec="servers">
              <h2 className="pl-gh">Servers<span className="cnt tnum">{servers.length}</span></h2>
              <div className="pl-srvline">
                {servers.map((e) => <ServerButton key={e.id} e={e} />)}
              </div>
            </section>
          )}
        </div>
      </div>

      <Dock items={dockItems} />

      {sheet === 'switcher' && (
        <SessionSwitcher
          sessions={sessions}
          currentId={null}
          onPick={(id) => openSession(id, null)}
          onNew={() => setSheet('new')}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'new' && <NewSessionSheet onClose={() => setSheet(null)} />}
      {menu && (
        <MoreSheet
          title={sessionTitle(menu)}
          sub={menu.id}
          onClose={() => setMenu(null)}
          items={[
            { id: 'open', icon: <SquareTerminal />, label: 'Open', run: () => openSession(menu.id, null) },
            { id: 'rename', icon: <Pencil />, label: 'Rename', run: () => setRename(menu) },
            { id: 'kill', icon: <X />, label: 'Kill session', run: () => setKill(menu) },
          ]}
        />
      )}
      {rename && <RenameSheet s={rename} onClose={() => setRename(null)} />}
      {kill && <KillSheet s={kill} onClose={() => setKill(null)} />}
    </div>
  );
}
