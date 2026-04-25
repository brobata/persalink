/**
 * @file App Store
 * @description Zustand store for PersaLink client state. Manages connection,
 *   auth, sessions, profiles, and terminal state.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  SessionInfo, Profile, HealthStatus, ServerMessage, TmuxWindowInfo,
} from '@persalink/shared/protocol';
import { WSClient, type ConnectionState } from '../lib/ws';
import {
  isBiometricAvailable, verifyBiometric, saveCredentials,
  getCredentials, clearCredentials,
} from '../lib/biometric';

// ============================================================================
// Types
// ============================================================================

export type View = 'locked' | 'connect' | 'auth' | 'home' | 'terminal' | 'settings' | 'profile-editor';

export interface SessionTab {
  sessionId: string;
  name: string;
  color?: string;
  icon?: string;
  profileId?: string;
}

interface AppState {
  // Connection
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

  // Session tabs (derived from live sessions when in terminal view)
  activeTabId: string | null;
  switchingToId: string | null;  // guards against rapid tab switches
  showTabPicker: boolean;

  // Quick action results
  actionResult: { actionId: string; profileId?: string; output: string; exitCode: number; timedOut?: boolean; truncated?: boolean; spawnError?: boolean } | null;

  // Toast notifications — server-side errors and other transient messages.
  // Without this, a 'window.create' or 'profile.save' failure on the server
  // produces no visible signal on the client.
  notifications: { id: string; kind: 'error' | 'info'; message: string; op?: string; createdAt: number }[];

  // Actions
  setServerUrl: (url: string) => void;
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
  resize: (cols: number, rows: number) => void;
  selectWindow: (index: number) => void;
  createWindow: (name?: string) => void;
  killWindow: (windowIndex: number) => void;
  renameWindow: (windowIndex: number, name: string) => void;
  runAction: (profileId: string, actionId: string) => void;
  saveProfile: (profile: Profile) => void;
  deleteProfile: (profileId: string) => void;
  discoverProfiles: () => void;
  acceptDiscoveredProfile: (profile: Profile) => void;
  editProfile: (profile: Profile | null) => void;
  reorderProfiles: (profileIds: string[]) => void;
  goBack: () => void;
  requestScrollback: (lines?: number) => void;
  setView: (view: View) => void;
  clearActionResult: () => void;
  initBiometric: () => Promise<void>;
  unlockWithBiometric: () => Promise<boolean>;
  switchTab: (sessionId: string) => void;
  closeTab: (sessionId: string) => void;
  setShowTabPicker: (show: boolean) => void;
  getTabs: () => SessionTab[];
  pushNotification: (kind: 'error' | 'info', message: string, op?: string) => void;
  dismissNotification: (id: string) => void;
}

// ============================================================================
// Store
// ============================================================================

let wsClient: WSClient | null = null;
let switchDebounce: ReturnType<typeof setTimeout> | null = null;

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
      notifications: [],

      pushNotification: (kind, message, op) => set((s) => ({
        notifications: [
          ...s.notifications.slice(-4), // cap at 5 visible
          { id: crypto.randomUUID(), kind, message, op, createdAt: Date.now() },
        ],
      })),
      dismissNotification: (id) => set((s) => ({
        notifications: s.notifications.filter((n) => n.id !== id),
      })),

      setServerUrl: (url) => set({
        serverUrl: url.trim().replace(/^(wss?|https?):\/\//i, ''),
      }),

      connect: () => {
        const { serverUrl } = get();
        if (!serverUrl) return;

        // Always strip any scheme from stored serverUrl and rebuild from the
        // current page protocol — avoids stale ws:// / http:// prefixes from
        // past entries breaking the connection.
        const hostOnly = serverUrl.trim().replace(/^(wss?|https?):\/\//i, '');
        const scheme = typeof window !== 'undefined' && window.location.protocol === 'https:'
          ? 'wss://'
          : 'ws://';
        const wsUrl = `${scheme}${hostOnly}`;
        console.log('[PersaLink] connecting to', wsUrl);

        if (wsClient) wsClient.disconnect();

        wsClient = new WSClient({
          url: wsUrl,
          onMessage: (msg) => handleServerMessage(msg, set, get),
          onStateChange: (state) => {
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
        wsClient?.disconnect();
        wsClient = null;
        clearCredentials().catch(() => {});
        set({
          connectionState: 'disconnected',
          view: 'connect',
          attachedSession: null,
          serverName: null,
          authToken: null,
        });
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
        wsClient?.send({ type: 'session.attach', sessionId, cols, rows });
      },

      detachSession: () => {
        wsClient?.send({ type: 'session.detach' });
        set({ attachedSession: null, view: 'home', windows: [], initialScrollback: null, activeTabId: null });
      },

      killSession: (sessionId) => {
        wsClient?.send({ type: 'session.kill', sessionId });
      },

      renameSession: (sessionId, name) => {
        wsClient?.send({ type: 'session.rename', sessionId, name });
      },

      sendInput: (data) => {
        wsClient?.send({ type: 'session.input', data });
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
          wsClient?.send({ type: 'session.attach', sessionId });
        }, 150);
      },

      closeTab: (sessionId) => {
        const { sessions, activeTabId } = get();
        wsClient?.send({ type: 'session.kill', sessionId });
        if (activeTabId === sessionId) {
          const remaining = sessions.filter(s => s.id !== sessionId);
          if (remaining.length > 0) {
            const switchTo = remaining[remaining.length - 1];
            // Server auto-detaches on attach — no separate detach needed
            wsClient?.send({ type: 'session.attach', sessionId: switchTo.id });
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

      setView: (view) => set({ view }),

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
          set({
            biometricLocked: false,
            authToken: creds.token,
            deviceName: creds.deviceName,
          });
          return true;
        }
        return false;
      },
    }),
    {
      name: 'persalink-storage',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        authToken: state.authToken,
        deviceName: state.deviceName,
      }),
    }
  )
);

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

    case 'auth.ok':
      set({
        connectionState: 'authenticated' as ConnectionState,
        serverName: msg.serverName,
        view: 'home',
        authError: null,
      });
      if (msg.token) {
        set({ authToken: msg.token });
        // Save token to device keychain for biometric unlock
        const { deviceName, biometricAvailable } = get();
        if (biometricAvailable) {
          saveCredentials(msg.token, deviceName).catch(() => {});
        }
      }
      break;

    case 'auth.failed':
      set({ authError: msg.message, authToken: null, view: 'auth' });
      break;

    case 'sessions.list':
      set({ sessions: msg.sessions });
      break;

    case 'profiles.list':
      set({ profiles: msg.profiles });
      break;

    case 'profiles.discovered':
      set({ discoveredProfiles: msg.profiles });
      break;

    case 'health.status':
      set({ healthStatuses: msg.statuses });
      break;

    case 'session.attached': {
      const { switchingToId } = get();
      // Stale attach response from a session we've already moved past — ignore it.
      // Don't send detach here; the next attach auto-detaches on the server side.
      if (switchingToId && msg.session.id !== switchingToId) break;
      set({
        attachedSession: msg.session,
        initialScrollback: msg.scrollback || null,
        view: 'terminal',
        windows: msg.session.windows,
        activeTabId: msg.session.id,
        switchingToId: null,  // switch complete
        showTabPicker: false,
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
          wsClient?.send({ type: 'session.attach', sessionId: switchTo.id });
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
