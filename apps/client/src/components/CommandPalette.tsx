/**
 * @file CommandPalette
 * @description One field over everything: sessions on every saved server,
 *   profiles ("New Ops Suite session"), quick actions, snippets, Files,
 *   Settings and the terminal's own tools. Results sit in three fixed
 *   sections (Needs you, Sessions, Actions); inside each, a match at the
 *   start of the label or of a word ranks first (lib/paletteRank). The agent
 *   that Ctrl+Alt+J would open is the first Needs you row. Quick actions run
 *   through runAction and report in QuickActionResult.
 *   Opened by Ctrl+Shift+K (Ctrl+K outside the terminal) on desktop, Alt+K
 *   on a phone keyboard, or the search buttons. Mounted once, in App.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpCircle, Braces, ClipboardCopy, Columns2, FolderOpen, House, Keyboard, LayoutGrid, Link2,
  MessageSquare, Play, Rows2, Search, Server, Settings, SlidersHorizontal, Square, TextSearch, Upload, X,
} from 'lucide-react';
import type { Profile, SessionInfo } from '@persalink/shared/protocol';
import { useAppStore, type ServerEntry } from '../stores/appStore';
import { useLayoutStore, type Layout } from '../stores/layoutStore';
import { useUiStore } from '../stores/uiStore';
import { rankPalette, type PaletteSection, type Rankable } from '../lib/paletteRank';
import { needsYou, nextWaiting, orderSessions } from '../lib/sessionOrder';
import { sessionTitle, stateKey, stateWord } from '../lib/sessionState';
import { currentTerminal, PHONE_TERMINAL, sendPaneCommand } from '../lib/paneCommands';
import { DESKTOP_CHORD } from '../lib/keymap';
import { deviceKind } from '../lib/device';
import { getInitialDims } from '../lib/terminalDims';
import { remoteSnapshot } from '../lib/remoteServer';
import { StateGlyph } from './ui/StateGlyph';
import { ProfileTile } from './ui/ProfileTile';
import { IconButton } from './ui/IconButton';
import { Kbd } from './ui/Kbd';

const EXIT_MS = 105;
const ICON = 'w-4 h-4';
const SNIPPET_VAR_RX = /\{\{[a-zA-Z0-9_ -]+\}\}/;

interface PaletteItem extends Rankable {
  id: string;
  icon: ReactNode;
  /** Desktop chord shown on the right. */
  keys?: string;
  /** Short tag on the right ("mac-mini", "Here"). */
  tag?: string;
  /** Needs a second Enter or tap (quick actions marked "confirm"). */
  confirm?: boolean;
  run: () => void;
}

// ---------------------------------------------------------------- remote
// Sessions on the other saved servers, fetched over a throwaway socket when
// the palette opens (lib/remoteServer). Kept for a short while so opening
// the palette twice in a row does not knock on every server twice.
type RemoteState = { status: 'loading' } | { status: 'ok'; sessions: SessionInfo[]; profiles: Profile[]; at: number } | { status: 'error' };
const REMOTE_TTL_MS = 20_000;
const remoteCache = new Map<string, RemoteState>();

function useRemoteSessions(open: boolean, servers: ServerEntry[], activeServerId: string | null): [Map<string, RemoteState>, number] {
  const [version, bump] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const entry of servers) {
      if (entry.id === activeServerId || !entry.authToken) continue;
      const cached = remoteCache.get(entry.id);
      if (cached && (cached.status === 'loading' || (cached.status === 'ok' && Date.now() - cached.at < REMOTE_TTL_MS))) continue;
      remoteCache.set(entry.id, { status: 'loading' });
      remoteSnapshot(entry)
        .then((snap) => { remoteCache.set(entry.id, { status: 'ok', ...snap, at: Date.now() }); })
        .catch(() => { remoteCache.set(entry.id, { status: 'error' }); })
        .finally(() => { if (alive) bump((n) => n + 1); });
    }
    bump((n) => n + 1);
    return () => { alive = false; };
  }, [open, servers, activeServerId]);
  return [remoteCache, version];
}

/** A pane's last line without the box frame and caret Claude draws around
 *  its prompts ("│ ❯ 1. Yes │" reads "1. Yes"). */
function cleanPreview(text: string | undefined): string {
  return (text ?? '').replace(/[│┃|╭╮╰╯─━]+/g, ' ').replace(/^[\s❯›>]+/, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- actions
/** Open a session wherever you are: the focused pane on desktop (or the pane
 *  already showing it), the terminal on a phone. Another server's session on
 *  a phone switches to that server, which then opens it. */
function openSession(id: string, serverId: string | null): void {
  const app = useAppStore.getState();
  const onActive = !serverId || serverId === app.activeServerId;
  if (deviceKind() === 'desktop') {
    const layout = useLayoutStore.getState();
    const boundTo = (p: { serverId: string | null }) => p.serverId ?? app.activeServerId;
    const shown = layout.panes.find((p) => p.sessionId === id && boundTo(p) === (serverId ?? app.activeServerId));
    if (shown) layout.setFocusedPane(shown.id);
    else layout.assignSession(layout.focusedPaneId, id, serverId ?? app.activeServerId);
    app.closeOverlay();
    return;
  }
  if (onActive) {
    app.attachSession(id);
    return;
  }
  app.selectServer(serverId!);
  // The cold open after sign-in lands on the last session when it is recent.
  useAppStore.setState({ lastActiveSessionId: id, lastActiveAt: Date.now() });
}

function startProfile(profileId: string): void {
  const app = useAppStore.getState();
  if (deviceKind() === 'desktop') {
    const layout = useLayoutStore.getState();
    layout.markPendingAssign(layout.focusedPaneId);
    app.createSession(profileId);
    app.closeOverlay();
    return;
  }
  const { cols, rows } = getInitialDims();
  app.createSession(profileId, cols, rows);
}

const LAYOUTS: Array<{ id: Layout; label: string; icon: ReactNode }> = [
  { id: 'single', label: 'One pane', icon: <Square className={ICON} /> },
  { id: 'split-h', label: 'Two panes side by side', icon: <Columns2 className={ICON} /> },
  { id: 'split-v', label: 'Two panes stacked', icon: <Rows2 className={ICON} /> },
  { id: '2x2', label: 'Four panes', icon: <LayoutGrid className={ICON} /> },
];

// ---------------------------------------------------------------- items
function useItems(open: boolean): { items: PaletteItem[]; checking: string[] } {
  const sessions = useAppStore((s) => s.sessions);
  const profiles = useAppStore((s) => s.profiles);
  const snippets = useAppStore((s) => s.snippets);
  const servers = useAppStore((s) => s.servers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const view = useAppStore((s) => s.view);
  const attachedSession = useAppStore((s) => s.attachedSession);
  const endedSession = useAppStore((s) => s.endedSession);
  const filesDisabled = useAppStore((s) => s.filesDisabled);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const panes = useLayoutStore((s) => s.panes);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const layout = useLayoutStore((s) => s.layout);
  const [remote, remoteVersion] = useRemoteSessions(open, servers, activeServerId);

  return useMemo(() => {
    const desktop = deviceKind() === 'desktop';
    const focused = panes.find((p) => p.id === focusedPaneId);
    const focusedOnActive = !focused?.serverId || focused.serverId === activeServerId;
    const currentId = desktop ? (focusedOnActive ? focused?.sessionId ?? null : null) : attachedSession?.id ?? null;
    const overlay = view === 'settings' || view === 'files' || view === 'profile-editor';
    // Is there a terminal to send terminal actions to?
    const terminal = desktop
      ? !overlay && !!focused?.sessionId
      : view === 'terminal' && !!attachedSession && !endedSession;
    const target = terminal ? currentTerminal() : null;
    const chord = (k: keyof typeof DESKTOP_CHORD) => (desktop ? DESKTOP_CHORD[k] : undefined);
    const next = nextWaiting(sessions, currentId);
    const serverLabel = (e: ServerEntry) => e.serverName || e.label;

    const items: PaletteItem[] = [];

    // Sessions: this server first, then every other saved server.
    const sessionItem = (s: SessionInfo, serverId: string | null, server?: string): PaletteItem => {
      const waiting = needsYou(s);
      const here = !server && s.id === currentId;
      const k = stateKey(s);
      const word = stateWord(s, k);
      const profile = s.profileName && s.profileName !== sessionTitle(s) ? ` · ${s.profileName}` : '';
      return {
        id: `s:${serverId ?? ''}:${s.id}`,
        section: waiting ? 'Needs you' : 'Sessions',
        label: sessionTitle(s),
        sub: waiting && cleanPreview(s.preview) ? `${word} · ${cleanPreview(s.preview)}` : `${word}${profile}`,
        alias: `${s.name} ${s.profileName ?? ''} ${server ?? ''}`,
        icon: <StateGlyph state={k} size={12} />,
        tag: server ?? (here ? 'Here' : undefined),
        keys: !server && next && s.id === next.id ? chord('next-waiting') : undefined,
        run: () => { if (!here) openSession(s.id, serverId); },
      };
    };
    // The next-waiting agent leads Needs you (it is what Ctrl+Alt+J opens).
    const local = orderSessions(sessions);
    if (next) local.sort((a, b) => (a.id === next.id ? -1 : 0) - (b.id === next.id ? -1 : 0));
    for (const s of local) items.push(sessionItem(s, activeServerId, undefined));
    const checking: string[] = [];
    for (const entry of servers) {
      if (entry.id === activeServerId) continue;
      const r = remote.get(entry.id);
      if (r?.status === 'loading') checking.push(serverLabel(entry));
      if (r?.status !== 'ok') continue;
      for (const s of orderSessions(r.sessions)) items.push(sessionItem(s, entry.id, serverLabel(entry)));
    }

    const A = (id: string, label: string, icon: ReactNode, run: () => void, extra: Partial<PaletteItem> = {}) =>
      items.push({ id, section: 'Actions' as PaletteSection, label, icon, run, ...extra });

    if (!desktop && view !== 'home') A('home', 'Home', <House className={ICON} />, () => useAppStore.getState().goBack());
    if (target) {
      A('composer', 'Write a message', <MessageSquare className={ICON} />, () => sendPaneCommand(target, 'composer'), { keys: chord('composer'), alias: 'composer dictate voice reply' });
      A('claude', 'Copy from Claude', <ClipboardCopy className={ICON} />, () => sendPaneCommand(target, 'claude'), { keys: chord('copy-claude'), alias: 'reply code' });
      A('links', 'Links in this session', <Link2 className={ICON} />, () => sendPaneCommand(target, 'links'), { keys: chord('links'), alias: 'url' });
      if (!filesDisabled) A('upload', 'Upload a file', <Upload className={ICON} />, () => sendPaneCommand(target, 'upload'), { sub: 'into this session' });
      if (target === PHONE_TERMINAL) {
        A('find', 'Find in output', <TextSearch className={ICON} />, () => sendPaneCommand(target, 'find'), { alias: 'search scrollback' });
        A('snippets', 'Snippets', <Braces className={ICON} />, () => sendPaneCommand(target, 'snippets'), { alias: 'commands library' });
        A('tsettings', 'Terminal settings', <SlidersHorizontal className={ICON} />, () => sendPaneCommand(target, 'terminal-settings'), { alias: 'theme font size appearance' });
      }
    }
    if (!filesDisabled) A('files', 'Files', <FolderOpen className={ICON} />, () => useAppStore.getState().openFiles(), { keys: chord('files'), alias: 'browse upload' });
    A('settings', 'Settings', <Settings className={ICON} />, () => useAppStore.getState().openSettings(), { keys: chord('settings'), alias: 'preferences notifications' });
    A('shortcuts', 'Keyboard shortcuts', <Keyboard className={ICON} />, () => useUiStore.getState().openShortcuts(), { keys: chord('shortcuts'), alias: 'keys help' });
    if (updateAvailable) A('update', 'Update ready', <ArrowUpCircle className={ICON} />, () => window.location.reload(), { sub: 'Reload to use the new version' });
    if (desktop) {
      for (const l of LAYOUTS) {
        if (l.id === layout) continue;
        A(`layout:${l.id}`, l.label, l.icon, () => useLayoutStore.getState().setLayout(l.id), { alias: 'layout split grid panes', searchOnly: true });
      }
    }
    if (servers.length > 1) {
      for (const e of servers) {
        if (e.id === activeServerId) continue;
        A(`server:${e.id}`, `Switch to ${serverLabel(e)}`, <Server className={ICON} />, () => useAppStore.getState().selectServer(e.id), { alias: 'server machine', searchOnly: true });
      }
      A('servers', 'Servers', <Server className={ICON} />, () => useAppStore.getState().openServers(), { alias: 'switch machine add', searchOnly: true });
    }
    // Long lists: only once something is typed.
    for (const p of profiles) {
      A(`new:${p.id}`, `New ${p.name} session`, <ProfileTile name={p.name} color={p.color} size={20} />, () => startProfile(p.id), {
        sub: p.cwd, alias: `new start profile ${p.name} ${p.group ?? ''}`, searchOnly: true,
      });
    }
    for (const p of profiles) {
      for (const a of p.actions ?? []) {
        A(`qa:${p.id}:${a.id}`, `${p.name}: ${a.name}`, <Play className={ICON} />, () => {
          useUiStore.getState().setQuickRun({ profileId: p.id, actionId: a.id, title: `${p.name}: ${a.name}`, command: a.command, confirm: !!a.confirm, startedAt: Date.now() });
          useAppStore.getState().runAction(p.id, a.id);
        }, { sub: a.command, alias: `quick action run ${a.name}`, searchOnly: true, confirm: !!a.confirm });
      }
    }
    if (target) {
      for (const sn of snippets) {
        const hasVars = SNIPPET_VAR_RX.test(sn.command);
        // Desktop panes have no snippet sheet to fill fields in, so only
        // ready-to-type snippets are offered there.
        if (hasVars && target !== PHONE_TERMINAL) continue;
        A(`snip:${sn.id}`, sn.name, <Braces className={ICON} />, () => {
          if (hasVars) sendPaneCommand(target, 'snippets');
          else sendPaneCommand(target, 'insert', sn.command);
        }, { sub: hasVars ? `${sn.command} · fill in fields` : `${sn.command} · types it, you press Enter`, alias: 'snippet command', searchOnly: true });
      }
    }
    return { items, checking };
  }, [sessions, profiles, snippets, servers, activeServerId, view, attachedSession, endedSession, filesDisabled,
    updateAvailable, panes, focusedPaneId, layout, remote, remoteVersion]);
}

// ---------------------------------------------------------------- view
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); setClosing(false); return; }
    if (!mounted) return;
    setClosing(true);
    const t = window.setTimeout(() => { setMounted(false); setClosing(false); }, EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open, mounted]);
  if (!mounted) return null;
  return <PaletteDialog closing={closing} />;
}

function PaletteDialog({ closing }: { closing: boolean }) {
  const initialQuery = useUiStore((s) => s.paletteQuery);
  const closePalette = useUiStore((s) => s.closePalette);
  const { items, checking } = useItems(!closing);
  const [query, setQuery] = useState(initialQuery);
  const [idx, setIdx] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();
  const desktop = deviceKind() === 'desktop';

  const ranked = useMemo(() => rankPalette(items, query), [items, query]);
  // A new query puts the selection on the best match (where Enter goes).
  useEffect(() => { setIdx(ranked.best); setArmed(null); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = Math.min(idx, Math.max(0, ranked.flat.length - 1));

  // Take focus on open; hand it back on cancel.
  useLayoutEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 20);
    return () => window.clearTimeout(t);
  }, []);
  const restoreFocus = useCallback(() => {
    const el = returnFocus.current;
    if (el && el.isConnected && el !== document.body) el.focus({ preventScroll: true });
    else inputRef.current?.blur();
  }, []);
  const cancel = useCallback(() => { restoreFocus(); closePalette(); }, [restoreFocus, closePalette]);

  const run = useCallback((i: number) => {
    const item = ranked.flat[i];
    if (!item) return;
    if (item.confirm && armed !== item.id) { setArmed(item.id); setIdx(i); return; }
    // Focus goes back first, so an action that moves it (a composer, a
    // sheet) wins over the restore.
    restoreFocus();
    closePalette();
    item.run();
  }, [ranked.flat, armed, restoreFocus, closePalette]);

  // Keep the selected row in view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = ranked.flat.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setIdx((sel + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setIdx((sel - 1 + n) % n); }
    else if (e.key === 'PageDown') { e.preventDefault(); if (n) setIdx(Math.min(n - 1, sel + 8)); }
    else if (e.key === 'PageUp') { e.preventDefault(); if (n) setIdx(Math.max(0, sel - 8)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Tab') e.preventDefault();
  };

  let flatIndex = -1;
  const optionId = (i: number) => `${listId}-o${i}`;

  return createPortal(
    <>
      <div className={`pl-scrim pl-pal-scrim${closing ? ' closing' : ''}`} onClick={cancel} aria-hidden />
      <div
        className={`pl-pal${closing ? ' closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        onKeyDown={onKeyDown}
      >
        <div className="pl-pal-in">
          <Search className="w-[18px] h-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={desktop ? 'Jump to a session, start a profile, run a command' : 'Sessions, actions, snippets, profiles'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={ranked.flat.length ? optionId(sel) : undefined}
          />
          {!desktop && (
            <IconButton label="Close" onClick={cancel}>
              <X className="w-[18px] h-[18px]" strokeWidth={1.75} />
            </IconButton>
          )}
        </div>
        <div ref={listRef} id={listId} className="pl-pal-l" role="listbox" aria-label="Results">
          {ranked.flat.length === 0 && (
            <div className="pl-pal-empty">Nothing matches. Try a session, profile or command name.</div>
          )}
          {ranked.sections.map((sec) => (
            <div key={sec.section} role="group" aria-label={sec.section}>
              <div className="pl-pal-g">
                <span>{sec.section}</span>
                {sec.section === 'Sessions' && checking.length > 0 && <span className="more">Checking {checking.join(', ')}</span>}
                {sec.more > 0 && <span className="more">{sec.more} more as you type</span>}
              </div>
              {sec.items.map((item) => {
                flatIndex += 1;
                const i = flatIndex;
                const on = i === sel;
                const isArmed = armed === item.id;
                return (
                  <button
                    key={item.id}
                    id={optionId(i)}
                    type="button"
                    role="option"
                    aria-selected={on}
                    tabIndex={-1}
                    className={`pl-pal-i${on ? ' on' : ''}`}
                    onMouseMove={() => { if (!on) setIdx(i); }}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => run(i)}
                  >
                    <span className="ic">{item.icon}</span>
                    <span className="tx">
                      <span className="l">{item.label}</span>
                      {isArmed
                        ? <span className="s warn">{desktop ? 'Press Enter again to run' : 'Tap again to run'}</span>
                        : item.sub && <span className="s">{item.sub}</span>}
                    </span>
                    {item.tag && <span className="tag">{item.tag}</span>}
                    {desktop && item.keys && <Kbd keys={item.keys} className="k" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {desktop && (
          <div className="pl-pal-f">
            <span><Kbd keys="↑" /> <Kbd keys="↓" /> move</span>
            <span><Kbd keys="Enter" /> open</span>
            <span className="r"><Kbd keys="Esc" /> close</span>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
