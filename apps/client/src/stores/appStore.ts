/**
 * @file App Store
 * @description Zustand store for PersaLink client state. Manages connection,
 *   auth, sessions, profiles, and terminal state.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  SessionInfo, Profile, HealthStatus, ServerMessage, TmuxWindowInfo, Snippet,
} from '@persalink/shared/protocol';
import { WSClient, type ConnectionState } from '../lib/ws';
import { subscribeToPush, unsubscribeFromPush } from '../lib/push';
import {
  isBiometricAvailable, verifyBiometric, saveCredentials,
  getCredentials, clearCredentials,
} from '../lib/biometric';
import { getInitialDims } from '../lib/terminalDims';
import { useLayoutStore } from './layoutStore';

// ============================================================================
// Types
// ============================================================================

export type View = 'locked' | 'connect' | 'auth' | 'home' | 'terminal' | 'settings' | 'profile-editor';

/** One saved PersaLink server. `useOrigin` entries resolve their host from
 *  window.location at connect time — that's the entry representing "the server
 *  this page was loaded from", which must keep working across all its aliases
 *  (LAN IP, ts.net, mDNS). Manually added entries connect to the typed host. */
export interface ServerEntry {
  id: string;
  label: string;
  host: string;
  useOrigin: boolean;
  authToken: string | null;
  serverName: string | null;
  lastConnectedAt: number | null;
}

export interface SessionTab {
  sessionId: string;
  name: string;
  color?: string;
  icon?: string;
  profileId?: string;
}

interface AppState {
  // Server registry — source of truth. The scalar fields below it are live
  // MIRRORS of the active entry so every pre-registry consumer (panes,
  // uploads, settings) keeps reading the same keys it always did.
  servers: ServerEntry[];
  activeServerId: string | null;

  // Connection (mirrors of the active ServerEntry + live socket state)
  serverUrl: string;
  connectionState: ConnectionState;
  serverName: string | null;
  setupMode: boolean;
  authToken: string | null;
  authError: string | null;

  // Biometric
  biometricAvailable: boolean;
  biometricLocked: boolean;
  deviceName: string;

  // Navigation
  view: View;

  // Sessions & Profiles
  sessions: SessionInfo[];
  profiles: Profile[];
  healthStatuses: HealthStatus[];
  discoveredProfiles: Profile[];

  // Profile editor
  editingProfile: Profile | null;

  // Terminal
  attachedSession: SessionInfo | null;
  initialScrollback: string | null;
  windows: TmuxWindowInfo[];

  // Last-attached session id, persisted across reloads so the PWA / tab
  // re-opens directly into the session you were on. pendingAutoAttach is
  // the transient handshake: set on auth, consumed once sessions.list
  // confirms the session still exists.
  lastActiveSessionId: string | null;
  pendingAutoAttach: string | null;

  // Session tabs (derived from live sessions when in terminal view)
  activeTabId: string | null;
  switchingToId: string | null;  // guards against rapid tab switches
  showTabPicker: boolean;

  // Quick action results
  actionResult: { actionId: string; profileId?: string; output: string; exitCode: number; timedOut?: boolean; truncated?: boolean; spawnError?: boolean } | null;

  // Harvested links — non-null opens the link sheet (set when the server's
  // session.links response arrives, cleared on close/detach).
  sessionLinks: string[] | null;

  // True when the server is serving a newer client bundle than the one
  // running — drives the "Update ready" pill. A plain reload picks it up
  // (the SW is network-first on the shell).
  updateAvailable: boolean;

  // Server-side session logs (per-profile opt-in). List for the Settings
  // section; logView non-null opens the viewer overlay.
  sessionLogs: Array<{ name: string; size: number; mtime: number }> | null;
  logView: { name: string; data: string; truncated: boolean } | null;

  // Shell history (suggestion bar) + global snippet library — both fetched
  // after auth and kept fresh via broadcasts.
  shellHistory: string[];
  snippets: Snippet[];
  // Detached exec results keyed by client-chosen tag (snippet runs).
  execResults: Record<string, { output: string; exitCode: number; timedOut?: boolean; spawnError?: boolean }>;

  // Toast notifications — server-side errors and other transient messages.
  // Without this, a 'window.create' or 'profile.save' failure on the server
  // produces no visible signal on the client.
  notifications: { id: string; kind: 'error' | 'info'; message: string; op?: string; createdAt: number }[];

  // Web Push — VAPID key arrives after auth; enabled flag is persisted so the
  // UI reflects the saved preference.
  vapidPublicKey: string | null;
  notificationsEnabled: boolean;

  // Actions
  addServer: (label: string, host: string) => void;
  removeServer: (id: string) => void;
  selectServer: (id: string) => void;
  openServers: () => void;
  connect: () => void;
  disconnect: () => void;
  authenticate: (password: string, tokenName?: string) => void;
  authenticateWithToken: () => void;
  createSession: (profileId?: string, cols?: number, rows?: number) => void;
  attachSession: (sessionId: string, cols?: number, rows?: number) => void;
  detachSession: () => void;
  killSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  sendInput: (data: string) => void;
  exitScroll: () => void;
  enableNotifications: () => Promise<boolean>;
  disableNotifications: () => Promise<void>;
  testNotification: () => void;
  resize: (cols: number, rows: number) => void;
  selectWindow: (index: number) => void;
  createWindow: (name?: string) => void;
  killWindow: (windowIndex: number) => void;
  renameWindow: (windowIndex: number, name: string) => void;
  runAction: (profileId: string, actionId: string) => void;
  saveProfile: (profile: Profile) => void;
  deleteProfile: (profileId: string) => void;
  discoverProfiles: () => void;
  refresh: () => Promise<void>;
  acceptDiscoveredProfile: (profile: Profile) => void;
  editProfile: (profile: Profile | null) => void;
  reorderProfiles: (profileIds: string[]) => void;
  goBack: () => void;
  requestScrollback: (lines?: number) => void;
  requestLinks: () => void;
  clearSessionLinks: () => void;
  requestLogs: () => void;
  readLog: (name: string) => void;
  closeLogView: () => void;
  saveSnippet: (snippet: Snippet) => void;
  deleteSnippet: (id: string) => void;
  execCommand: (command: string, tag: string) => void;
  clearExecResult: (tag: string) => void;
  clearActionResult: () => void;
  initBiometric: () => Promise<void>;
  unlockWithBiometric: () => Promise<boolean>;
  switchTab: (sessionId: string) => void;
  closeTab: (sessionId: string) => void;
  setShowTabPicker: (show: boolean) => void;
  getTabs: () => SessionTab[];
  pushNotification: (kind: 'error' | 'info', message: string, op?: string) => void;
  dismissNotification: (id: string) => void;

  // Intent-named view transitions — replace direct setView mutation so
  // components express what they want, not how the state changes. Each
  // validates that the transition is sensible from the current view.
  // (editProfile() and goBack() are pre-existing intent transitions.)
  openSettings: () => void;
  closeOverlay: () => void;
}

// ============================================================================
// Store
// ============================================================================

let wsClient: WSClient | null = null;
let switchDebounce: ReturnType<typeof setTimeout> | null = null;

// Connection generation — bumped on every connect/switch. Callbacks from a
// superseded socket check their generation and drop themselves, so a late
// sessions.list from server A can never land after we've switched to server B.
let wsGeneration = 0;

// Ask the server which client build it's serving; flag when it's newer than
// the one running. Fired after every auth.ok — reconnects happen right after a
// deploy (the server restart drops the socket), so the pill appears within
// seconds of an update landing without any polling. Any failure (dev server
// has no version.json, offline, old server) just means no pill.
async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = await res.json() as { build?: string };
    if (build && typeof __BUILD_ID__ !== 'undefined' && build !== __BUILD_ID__) {
      useAppStore.setState({ updateAvailable: true });
    }
  } catch { /* offline or dev — check again on next auth */ }
}

// Read-only debug handle for automated tests / console triage. Same-origin
// scripts only (strict CSP) — the page already runs with full store access.
declare global { interface Window { __plStore?: typeof useAppStore } }

// Sessions the user just killed locally. The server snapshots tmux per WS
// message and its handlers interleave (ws.on('message') is async, not awaited
// between messages), so an older sessions.list snapshot — taken before a kill
// completed — can arrive AFTER we've optimistically dropped the session. That
// stale broadcast would otherwise resurrect the dead session in the Live list
// and, worse, the desktop pane router (App.tsx) would treat the ghost id as
// "newly created" and drop it into the pane meant for a different session
// ("killed X, opened Y, X reappeared on top"). Suppress these ids from incoming
// lists for a short window; an explicit re-attach (session.attached) clears the
// guard so an intentional recreate of the same id shows immediately.
const recentlyKilled = new Map<string, number>();
const KILL_GUARD_MS = 4000;

function guardKilled(sessionId: string): void {
  recentlyKilled.set(sessionId, Date.now() + KILL_GUARD_MS);
}

function filterKilled<T extends { id: string }>(sessions: T[]): T[] {
  if (recentlyKilled.size === 0) return sessions;
  const now = Date.now();
  for (const [id, expiry] of recentlyKilled) {
    if (expiry <= now) recentlyKilled.delete(id);
  }
  if (recentlyKilled.size === 0) return sessions;
  return sessions.filter((s) => !recentlyKilled.has(s.id));
}

// When the client is served by the server itself (plain browser, not
// Capacitor/Electron and not the Vite dev server on a different port),
// default to the current origin's host so users don't have to re-enter it.
function inferDefaultServerUrl(): string {
  if (typeof window === 'undefined') return '';
  const { protocol, host } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) return '';
  return host;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Initial state
      servers: [],
      activeServerId: null,
      serverUrl: inferDefaultServerUrl(),
      connectionState: 'disconnected',
      serverName: null,
      setupMode: false,
      authToken: null,
      authError: null,
      biometricAvailable: false,
      biometricLocked: false,
      deviceName: '',
      view: 'connect',
      sessions: [],
      profiles: [],
      healthStatuses: [],
      discoveredProfiles: [],
      editingProfile: null,
      attachedSession: null,
      initialScrollback: null,
      windows: [],
      activeTabId: null,
      switchingToId: null,
      showTabPicker: false,
      actionResult: null,
      sessionLinks: null,
      updateAvailable: false,
      sessionLogs: null,
      logView: null,
      shellHistory: [],
      snippets: [],
      execResults: {},
      notifications: [],
      lastActiveSessionId: null,
      pendingAutoAttach: null,
      vapidPublicKey: null,
      notificationsEnabled: false,

      pushNotification: (kind, message, op) => set((s) => ({
        notifications: [
          ...s.notifications.slice(-4), // cap at 5 visible
          { id: crypto.randomUUID(), kind, message, op, createdAt: Date.now() },
        ],
      })),
      dismissNotification: (id) => set((s) => ({
        notifications: s.notifications.filter((n) => n.id !== id),
      })),

      addServer: (label, host) => {
        const cleaned = host.trim().replace(/^(wss?|https?):\/\//i, '').replace(/\/+$/, '');
        if (!cleaned) return;
        const pageHost = typeof window !== 'undefined' ? window.location.host : '';
        const entry: ServerEntry = {
          id: crypto.randomUUID(),
          label: label.trim() || cleaned,
          host: cleaned,
          useOrigin: !!pageHost && cleaned === pageHost,
          authToken: null,
          serverName: null,
          lastConnectedAt: null,
        };
        set((s) => ({ servers: [...s.servers, entry] }));
        get().selectServer(entry.id);
      },

      removeServer: (id) => {
        const wasActive = get().activeServerId === id;
        set((s) => ({ servers: s.servers.filter((e) => e.id !== id) }));
        if (wasActive) {
          wsClient?.disconnect();
          wsClient = null;
          wsGeneration++;
          set({
            activeServerId: null, serverUrl: '', authToken: null, serverName: null,
            connectionState: 'disconnected', view: 'connect',
            sessions: [], profiles: [], healthStatuses: [], discoveredProfiles: [],
            attachedSession: null, windows: [], activeTabId: null, switchingToId: null,
            lastActiveSessionId: null, pendingAutoAttach: null, sessionLinks: null,
          });
        }
      },

      selectServer: (id) => {
        const { servers, activeServerId, connectionState } = get();
        const entry = servers.find((e) => e.id === id);
        if (!entry) return;
        // Already live on this server — just leave the servers screen.
        if (id === activeServerId && connectionState === 'authenticated') {
          set({ view: 'home' });
          return;
        }
        wsClient?.disconnect();
        wsClient = null;
        wsGeneration++; // invalidate in-flight callbacks from the old socket
        const pageHost = typeof window !== 'undefined' ? window.location.host : '';
        set({
          activeServerId: id,
          serverUrl: entry.useOrigin && pageHost ? pageHost : entry.host,
          authToken: entry.authToken,
          serverName: entry.serverName,
          // Everything below is per-server state from the previous server.
          sessions: [], profiles: [], healthStatuses: [], discoveredProfiles: [],
          attachedSession: null, windows: [], activeTabId: null, switchingToId: null,
          lastActiveSessionId: null, pendingAutoAttach: null, sessionLinks: null,
          authError: null, view: 'connect',
        });
        get().connect();
      },

      openServers: () => {
        const v = get().view;
        if (v === 'locked' || v === 'auth') return;
        set({ view: 'connect' });
      },

      connect: () => {
        const { servers, activeServerId } = get();
        const entry = servers.find((e) => e.id === activeServerId) ?? servers[0] ?? null;
        if (!entry) return;
        if (entry.id !== activeServerId) set({ activeServerId: entry.id, authToken: entry.authToken });

        // useOrigin entries follow the page host so the SPA keeps working via
        // every alias of its own server (mDNS / Tailscale / LAN IP) and the WS
        // origin check stays happy. Added entries connect to the typed host.
        const pageHost = typeof window !== 'undefined' && window.location?.host
          ? window.location.host
          : '';
        const hostOnly = entry.useOrigin && pageHost
          ? pageHost
          : entry.host.trim().replace(/^(wss?|https?):\/\//i, '');
        if (!hostOnly) return;

        const scheme = typeof window !== 'undefined' && window.location.protocol === 'https:'
          ? 'wss://'
          : 'ws://';
        const wsUrl = `${scheme}${hostOnly}`;
        console.log('[PersaLink] connecting to', wsUrl);

        if (wsClient) wsClient.disconnect();
        set({ serverUrl: hostOnly });

        const gen = ++wsGeneration;
        wsClient = new WSClient({
          url: wsUrl,
          onMessage: (msg) => {
            if (gen !== wsGeneration) return; // superseded socket — drop
            handleServerMessage(msg, set, get);
          },
          onStateChange: (state) => {
            if (gen !== wsGeneration) return;
            set({ connectionState: state });
            if (state === 'disconnected') {
              set({ view: 'connect', attachedSession: null });
            }
            // reconnecting — keep current view, just update state
            // the UI will show a reconnecting overlay
          },
        });

        wsClient.connect();
      },

      disconnect: () => {
        // Sign-out semantics for the ACTIVE server: drop the socket and its
        // saved token; other servers' tokens are untouched.
        wsClient?.disconnect();
        wsClient = null;
        wsGeneration++;
        clearCredentials().catch(() => {});
        set((s) => ({
          connectionState: 'disconnected',
          view: 'connect',
          attachedSession: null,
          serverName: null,
          authToken: null,
          servers: s.servers.map((e) => e.id === s.activeServerId ? { ...e, authToken: null } : e),
        }));
      },

      authenticate: (password, tokenName) => {
        set({ authError: null });
        wsClient?.send({ type: 'auth', password, tokenName });
      },

      authenticateWithToken: () => {
        const { authToken } = get();
        if (authToken) {
          wsClient?.send({ type: 'auth.token', token: authToken });
        }
      },

      createSession: (profileId, cols, rows) => {
        wsClient?.send({ type: 'session.create', profileId, cols, rows });
      },

      attachSession: (sessionId, cols, rows) => {
        // Track the in-flight target so the session.attached handler accepts
        // THIS attach's response. Self-healing: a previously stuck switchingToId
        // (e.g. an attach whose response was lost on a dropped socket) is
        // overwritten here, so a tap always opens instead of being filtered out
        // forever — the bug behind "taps highlight but nothing opens".
        set({ switchingToId: sessionId });
        // Always send dimensions — without them the server defaults to 120x40
        // and the first PTY redraw arrives sized for a desktop terminal,
        // wrapping into a ~40-col mobile xterm as visual garbage.
        const fallback = (cols === undefined || rows === undefined) ? getInitialDims() : null;
        wsClient?.send({
          type: 'session.attach',
          sessionId,
          cols: cols ?? fallback!.cols,
          rows: rows ?? fallback!.rows,
        });
      },

      detachSession: () => {
        wsClient?.send({ type: 'session.detach' });
        set({ attachedSession: null, view: 'home', windows: [], initialScrollback: null, activeTabId: null, lastActiveSessionId: null, switchingToId: null, sessionLinks: null });
      },

      killSession: (sessionId) => {
        wsClient?.send({ type: 'session.kill', sessionId });
        // Optimistically vacate the session locally so it never lingers on
        // screen. The server's session.detached can be dropped (e.g. gated by
        // an in-flight switch), and the desktop pane assignment is persisted —
        // both leave the killed session visible without this. A racing/stale
        // sessions.list can also try to resurrect it; guardKilled blocks that.
        guardKilled(sessionId);
        useLayoutStore.getState().clearSession(sessionId, get().activeServerId);
        if (get().attachedSession?.id === sessionId) {
          set({ attachedSession: null, view: 'home', windows: [], activeTabId: null, switchingToId: null });
        }
        set(s => ({
          sessions: s.sessions.filter(x => x.id !== sessionId),
          // Drop a dangling auto-reattach target so a later reconnect doesn't
          // try to re-open the session we just killed.
          lastActiveSessionId: s.lastActiveSessionId === sessionId ? null : s.lastActiveSessionId,
        }));
      },

      renameSession: (sessionId, name) => {
        wsClient?.send({ type: 'session.rename', sessionId, name });
      },

      sendInput: (data) => {
        wsClient?.send({ type: 'session.input', data });
      },

      // Drop the pane out of tmux copy-mode (scrollback) back to the live
      // prompt. Typing already auto-exits server-side; this powers the
      // explicit "jump to live" button.
      exitScroll: () => {
        wsClient?.send({ type: 'session.exitScroll' });
      },

      // Request notification permission, subscribe via the SW PushManager, and
      // register the subscription with the server. Returns whether it stuck.
      enableNotifications: async () => {
        const key = get().vapidPublicKey;
        if (!key) {
          get().pushNotification('error', 'Notifications not ready — reconnect and try again.', 'push');
          return false;
        }
        try {
          const subscription = await subscribeToPush(key);
          if (!subscription) {
            get().pushNotification('error', 'Notification permission denied.', 'push');
            set({ notificationsEnabled: false });
            return false;
          }
          wsClient?.send({ type: 'push.subscribe', subscription });
          set({ notificationsEnabled: true });
          return true;
        } catch (err) {
          get().pushNotification('error', `Could not enable notifications: ${err instanceof Error ? err.message : err}`, 'push');
          return false;
        }
      },

      disableNotifications: async () => {
        try {
          const endpoint = await unsubscribeFromPush();
          if (endpoint) wsClient?.send({ type: 'push.unsubscribe', endpoint });
        } catch { /* best effort — still flip the flag off */ }
        set({ notificationsEnabled: false });
      },

      testNotification: () => {
        wsClient?.send({ type: 'push.test' });
      },

      resize: (cols, rows) => {
        wsClient?.send({ type: 'session.resize', cols, rows });
      },

      selectWindow: (index) => {
        wsClient?.send({ type: 'window.select', windowIndex: index });
      },

      createWindow: (name) => {
        wsClient?.send({ type: 'window.create', name });
      },

      killWindow: (windowIndex) => {
        wsClient?.send({ type: 'window.kill', windowIndex });
      },

      renameWindow: (windowIndex, name) => {
        wsClient?.send({ type: 'window.rename', windowIndex, name });
      },

      runAction: (profileId, actionId) => {
        set({ actionResult: null });
        wsClient?.send({ type: 'action.run', profileId, actionId });
      },

      saveProfile: (profile) => {
        wsClient?.send({ type: 'profile.save', profile });
      },

      deleteProfile: (profileId) => {
        wsClient?.send({ type: 'profile.delete', profileId });
      },

      discoverProfiles: () => {
        wsClient?.send({ type: 'profile.discover' });
      },

      refresh: async () => {
        wsClient?.send({ type: 'sessions.list' });
        wsClient?.send({ type: 'profiles.list' });
        wsClient?.send({ type: 'health.status' });
        wsClient?.send({ type: 'profile.discover' });
        // Hold the spinner long enough that the gesture feels acknowledged
        // even when the server replies in <50ms.
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      },

      acceptDiscoveredProfile: (profile) => {
        wsClient?.send({ type: 'profile.save', profile });
        set(s => ({
          discoveredProfiles: s.discoveredProfiles.filter(p => p.id !== profile.id),
        }));
      },

      editProfile: (profile) => {
        set({ editingProfile: profile, view: 'profile-editor' });
      },

      reorderProfiles: (profileIds) => {
        wsClient?.send({ type: 'profile.reorder', profileIds });
      },

      switchTab: (sessionId) => {
        const { activeTabId } = get();
        if (activeTabId === sessionId) return;
        // Debounce: rapid clicks collapse into one attach for the final target.
        // Only the last click within 150ms fires the actual server message.
        if (switchDebounce) clearTimeout(switchDebounce);
        set({ switchingToId: sessionId, initialScrollback: null });
        switchDebounce = setTimeout(() => {
          switchDebounce = null;
          get().attachSession(sessionId);
        }, 150);
      },

      closeTab: (sessionId) => {
        const { sessions, activeTabId } = get();
        wsClient?.send({ type: 'session.kill', sessionId });
        guardKilled(sessionId);
        useLayoutStore.getState().clearSession(sessionId, get().activeServerId);
        set({ sessions: sessions.filter(x => x.id !== sessionId) });
        if (activeTabId === sessionId) {
          const remaining = sessions.filter(s => s.id !== sessionId);
          if (remaining.length > 0) {
            const switchTo = remaining[remaining.length - 1];
            // Server auto-detaches on attach — no separate detach needed
            get().attachSession(switchTo.id);
            set({ switchingToId: switchTo.id });
          } else {
            wsClient?.send({ type: 'session.detach' });
            set({ attachedSession: null, view: 'home', windows: [], activeTabId: null, switchingToId: null });
          }
        }
      },

      setShowTabPicker: (show) => set({ showTabPicker: show }),

      getTabs: () => {
        const { sessions } = get();
        return sessions.map(s => ({
          sessionId: s.id,
          name: s.profileName || s.name,
          color: s.profileColor,
          icon: s.profileIcon,
          profileId: s.profileId,
        }));
      },

      goBack: () => {
        const { view } = get();
        if (view === 'profile-editor' || view === 'settings') {
          set({ view: 'home' });
        } else if (view === 'terminal') {
          // detach instead of going back
          get().detachSession();
        }
      },

      requestScrollback: (lines) => {
        wsClient?.send({ type: 'session.scrollback', lines });
      },

      requestLinks: () => {
        wsClient?.send({ type: 'session.links' });
      },

      clearSessionLinks: () => set({ sessionLinks: null }),

      requestLogs: () => {
        wsClient?.send({ type: 'logs.list' });
      },

      readLog: (name) => {
        wsClient?.send({ type: 'logs.read', name });
      },

      closeLogView: () => set({ logView: null }),

      saveSnippet: (snippet) => {
        wsClient?.send({ type: 'snippet.save', snippet });
      },

      deleteSnippet: (id) => {
        wsClient?.send({ type: 'snippet.delete', snippetId: id });
      },

      execCommand: (command, tag) => {
        wsClient?.send({ type: 'exec.run', command, tag });
      },

      clearExecResult: (tag) => set((s) => {
        const next = { ...s.execResults };
        delete next[tag];
        return { execResults: next };
      }),

      openSettings: () => {
        // Allowed from any post-auth view (home/terminal/settings — re-entering
        // settings is a no-op). Disallowed during pre-auth (locked/connect/auth).
        const v = get().view;
        if (v === 'locked' || v === 'connect' || v === 'auth') return;
        set({ view: 'settings' });
      },

      closeOverlay: () => {
        const v = get().view;
        if (v === 'settings' || v === 'profile-editor') {
          set({ view: 'home', editingProfile: null });
        }
      },

      clearActionResult: () => set({ actionResult: null }),

      initBiometric: async () => {
        const available = await isBiometricAvailable();
        set({ biometricAvailable: available });
        // If biometrics available and we have a saved token, lock the app
        if (available) {
          const creds = await getCredentials();
          if (creds) {
            set({ biometricLocked: true, view: 'locked', deviceName: creds.deviceName });
          }
        }
      },

      unlockWithBiometric: async () => {
        const verified = await verifyBiometric();
        if (!verified) return false;
        const creds = await getCredentials();
        if (creds) {
          set((s) => ({
            biometricLocked: false,
            authToken: creds.token,
            deviceName: creds.deviceName,
            // Keychain holds the active server's token — sync it back onto
            // the entry so a reconnect after unlock uses it.
            servers: s.servers.map((e) => e.id === s.activeServerId ? { ...e, authToken: creds.token } : e),
          }));
          return true;
        }
        return false;
      },
    }),
    {
      name: 'persalink-storage',
      version: 1,
      // v0 → v1: lift the scalar serverUrl/authToken into the server registry.
      // useOrigin is true whenever a page host exists because that IS the old
      // behavior — connect() always preferred window.location.host, whatever
      // the stored url said. Nobody re-authenticates, nobody gets pointed at
      // a host they weren't already using.
      migrate: (persisted: unknown, version: number) => {
        const p = persisted as Record<string, unknown> & { servers?: ServerEntry[] };
        if (version === 0 && p && !p.servers && (p.serverUrl || p.authToken)) {
          const pageHost = typeof window !== 'undefined' ? window.location.host : '';
          const host = typeof p.serverUrl === 'string' ? p.serverUrl.trim() : '';
          const entry: ServerEntry = {
            id: crypto.randomUUID(),
            label: host || pageHost || 'My server',
            host: host || pageHost,
            useOrigin: !!pageHost,
            authToken: typeof p.authToken === 'string' ? p.authToken : null,
            serverName: null,
            lastConnectedAt: null,
          };
          p.servers = [entry];
          p.activeServerId = entry.id;
        }
        return p;
      },
      partialize: (state) => ({
        servers: state.servers,
        activeServerId: state.activeServerId,
        serverUrl: state.serverUrl,
        authToken: state.authToken,
        deviceName: state.deviceName,
        lastActiveSessionId: state.lastActiveSessionId,
        notificationsEnabled: state.notificationsEnabled,
      }),
    }
  )
);

if (typeof window !== 'undefined') window.__plStore = useAppStore;

// ============================================================================
// Message Handler
// ============================================================================

function handleServerMessage(
  msg: ServerMessage,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  switch (msg.type) {
    case 'auth.required':
      set({ setupMode: msg.setupMode });
      // Try token auth first
      const { authToken } = get();
      if (authToken) {
        wsClient?.send({ type: 'auth.token', token: authToken });
      } else {
        set({ view: 'auth' });
      }
      break;

    case 'auth.ok': {
      // On a RECONNECT the user is already past auth (in a terminal or on home)
      // — forcing view:'home' yanked them out of their session every time the
      // socket blipped. Only land on home from a pre-auth view (first login).
      const preAuthViews = ['connect', 'auth', 'locked'];
      const currentView = get().view;
      set((s) => ({
        connectionState: 'authenticated',
        serverName: msg.serverName,
        view: preAuthViews.includes(currentView) ? 'home' : currentView,
        authError: null,
        // Arm the auto-reattach handshake. If the persisted session still
        // exists in the upcoming sessions.list, we'll attach to it.
        pendingAutoAttach: s.lastActiveSessionId,
        // Reflect the successful auth onto the active registry entry.
        servers: s.servers.map((e) => e.id === s.activeServerId
          ? { ...e, serverName: msg.serverName, lastConnectedAt: Date.now(), ...(msg.token ? { authToken: msg.token } : {}) }
          : e),
      }));
      void checkForUpdate();
      // Suggestion-bar history + snippet library — cheap one-shots per auth.
      wsClient?.send({ type: 'history.list' });
      wsClient?.send({ type: 'snippets.list' });
      if (msg.token) {
        set({ authToken: msg.token });
        // Save token to device keychain for biometric unlock
        const { deviceName, biometricAvailable } = get();
        if (biometricAvailable) {
          saveCredentials(msg.token, deviceName).catch(() => {});
        }
      }
      break;
    }

    case 'auth.failed':
      // This server's token is bad — clear it here AND on its registry entry
      // (other servers keep theirs).
      set((s) => ({
        authError: msg.message, authToken: null, view: 'auth',
        servers: s.servers.map((e) => e.id === s.activeServerId ? { ...e, authToken: null } : e),
      }));
      break;

    case 'sessions.list': {
      // Drop sessions the user just killed — a stale snapshot from an
      // interleaved server handler can still list them (see recentlyKilled).
      const live = filterKilled(msg.sessions);
      set({ sessions: live });
      // Authoritative reconcile: drop any persisted desktop pane assignment
      // whose session is no longer live. Without this, killed sessions (or a
      // name-reused successor after reopen) keep showing in a pane.
      useLayoutStore.getState().reconcile(live.map((s) => s.id), get().activeServerId);
      // Consume the auto-reattach handshake if it's armed and the target
      // session is still alive. One-shot: clear pendingAutoAttach so we
      // never re-attach on subsequent broadcasts.
      const { pendingAutoAttach } = get();
      if (pendingAutoAttach) {
        const stillAlive = live.some((s) => s.id === pendingAutoAttach);
        set({ pendingAutoAttach: null });
        if (stillAlive) get().attachSession(pendingAutoAttach);
      }
      // Dead-session reconciliation (mobile has no pane-reconcile to lean on
      // like desktop does). If we're still showing a session that has vanished
      // from the live list — it exited or was killed elsewhere during an
      // outage, or a session.ended got dropped — transition out instead of
      // wedging on the dead session's last frame with keystrokes going nowhere.
      // Skip while a switch is in flight (switchingToId): the target may not be
      // in this snapshot yet, and session.attached will resolve it.
      const { attachedSession: att, switchingToId } = get();
      if (att && !switchingToId && !live.some((s) => s.id === att.id)) {
        if (live.length > 0) {
          const switchTo = live[live.length - 1];
          get().attachSession(switchTo.id);
          set({ activeTabId: switchTo.id });
        } else {
          set({ attachedSession: null, view: 'home', windows: [], activeTabId: null });
        }
      }
      break;
    }

    case 'profiles.list':
      set({ profiles: msg.profiles });
      break;

    case 'profiles.discovered':
      set({ discoveredProfiles: msg.profiles });
      break;

    case 'health.status':
      set({ healthStatuses: msg.statuses });
      break;

    case 'push.key':
      set({ vapidPublicKey: msg.publicKey });
      break;

    case 'session.attached': {
      const { switchingToId } = get();
      // Stale attach response from a session we've already moved past — ignore it.
      // Don't send detach here; the next attach auto-detaches on the server side.
      if (switchingToId && msg.session.id !== switchingToId) break;
      // We explicitly opened this session — it's unambiguously alive and wanted,
      // so lift any kill-guard (e.g. a quick recreate of the same id).
      recentlyKilled.delete(msg.session.id);
      set({
        attachedSession: msg.session,
        initialScrollback: msg.scrollback || null,
        view: 'terminal',
        windows: msg.session.windows,
        activeTabId: msg.session.id,
        switchingToId: null,  // switch complete
        showTabPicker: false,
        lastActiveSessionId: msg.session.id,
      });
      break;
    }

    case 'session.output':
      // Handled by terminal component via event (tagged with sessionId for routing)
      window.dispatchEvent(new CustomEvent('persalink:output', {
        detail: { data: msg.data, sessionId: msg.sessionId },
      }));
      break;

    case 'session.ended': {
      const { sessions: currentSessions } = get();
      const remaining = currentSessions.filter(s => s.id !== msg.sessionId);
      if (get().attachedSession?.id === msg.sessionId) {
        if (remaining.length > 0) {
          const switchTo = remaining[remaining.length - 1];
          get().attachSession(switchTo.id);
          set({ activeTabId: switchTo.id });
        } else {
          set({ attachedSession: null, view: 'home', windows: [], activeTabId: null });
        }
      }
      wsClient?.send({ type: 'sessions.list' });
      break;
    }

    case 'session.detached':
      // If we're mid-switch, ignore — the upcoming session.attached will take over
      if (get().switchingToId) break;
      // Not switching — go home
      set({ attachedSession: null, view: 'home', windows: [], activeTabId: null });
      break;

    case 'session.scrollback':
      window.dispatchEvent(new CustomEvent('persalink:scrollback', { detail: msg.data }));
      break;

    case 'session.links':
      set({ sessionLinks: msg.links });
      break;

    case 'logs.list':
      set({ sessionLogs: msg.logs });
      break;

    case 'logs.read':
      set({ logView: { name: msg.name, data: msg.data, truncated: msg.truncated } });
      break;

    case 'history.list':
      set({ shellHistory: msg.commands });
      break;

    case 'snippets.list':
      set({ snippets: msg.snippets });
      break;

    case 'exec.result':
      set((s) => ({
        execResults: {
          ...s.execResults,
          [msg.tag]: { output: msg.output, exitCode: msg.exitCode, timedOut: msg.timedOut, spawnError: msg.spawnError },
        },
      }));
      break;

    case 'windows.list':
      set({ windows: msg.windows });
      break;

    case 'action.result':
      set({
        actionResult: {
          actionId: msg.actionId,
          profileId: msg.profileId,
          output: msg.output,
          exitCode: msg.exitCode,
          timedOut: msg.timedOut,
          truncated: msg.truncated,
          spawnError: msg.spawnError,
        },
      });
      break;

    case 'error':
      console.warn('[PersaLink]', msg.op ? `[${msg.op}]` : '', msg.message);
      useAppStore.getState().pushNotification('error', msg.message, msg.op);
      break;

    case 'pong':
      break;
  }
}
