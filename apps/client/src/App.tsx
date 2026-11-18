import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppStore } from './stores/appStore';
import { LockScreen } from './components/LockScreen';
import { ConnectScreen } from './components/ConnectScreen';
import { AuthScreen } from './components/AuthScreen';
import { HomeScreen } from './components/HomeScreen';
import { TerminalScreen } from './components/TerminalScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { ProfileEditor } from './components/ProfileEditor';
import { FilesScreen } from './components/files/FilesScreen';
import { Sidebar } from './components/Sidebar';
import { GridLayout } from './components/GridLayout';
import { ToastStack } from './components/Toast';
import { UpdatePill } from './components/UpdatePill';
import { PublicChip } from './components/ui/ConnectionReadout';
import { useLayoutStore } from './stores/layoutStore';
import { stashShare } from './lib/shareTarget';
import { isPublicDoor } from './lib/door';
import { DESKTOP_MQ } from './lib/platform';

// ============================================================================
// Desktop breakpoint hook
// ============================================================================

const mqList = typeof window !== 'undefined' ? window.matchMedia(DESKTOP_MQ) : null;

function subscribeDesktop(cb: () => void) {
  mqList?.addEventListener('change', cb);
  return () => mqList?.removeEventListener('change', cb);
}

function getDesktop() {
  return mqList?.matches ?? false;
}

function useIsDesktop() {
  return useSyncExternalStore(subscribeDesktop, getDesktop, () => false);
}

// ============================================================================
// App
// ============================================================================

export function App() {
  const view = useAppStore((s) => s.view);
  const connectionState = useAppStore((s) => s.connectionState);
  const initBiometric = useAppStore((s) => s.initBiometric);
  const isDesktop = useIsDesktop();

  // Auto-connect on app open if we have saved credentials
  useEffect(() => {
    initBiometric();
    // Notification tap on a fully-closed app opens '/?session=<id>'. Seed it as
    // the auto-attach target (the post-auth handshake will attach once the
    // session is confirmed live), then strip it from the URL.
    try {
      const params = new URLSearchParams(window.location.search);
      const target = params.get('session');
      if (target) {
        // Stamped as just-focused so the cold-open rule (opensFirst) honours
        // the tapped notification over any other waiting agent.
        useAppStore.setState({ lastActiveSessionId: target, lastActiveAt: Date.now() });
        window.history.replaceState({}, '', window.location.pathname);
      }
      // PWA shortcut deep link: long-press app icon → pinned profile.
      const profile = params.get('profile');
      if (profile) {
        useAppStore.setState({ pendingProfileLaunch: profile });
        window.history.replaceState({}, '', window.location.pathname);
      }
      // Android share sheet (manifest share_target): stash the payload —
      // attaching a session surfaces a tap-to-insert toast for it.
      const sharedText = params.get('text');
      const sharedUrl = params.get('url');
      if (sharedText || sharedUrl) {
        stashShare([sharedText, sharedUrl].filter(Boolean).join(' '));
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch { /* no-op */ }
    // Ask Android not to evict this origin's storage (saved server + auth
    // token live in localStorage) under storage pressure. Fire-and-forget;
    // installed PWAs are usually granted silently.
    try { void navigator.storage?.persist?.(); } catch { /* unsupported */ }
    const { serverUrl, authToken, connectionState: cs } = useAppStore.getState();
    if (serverUrl && authToken && cs === 'disconnected') {
      useAppStore.getState().connect();
    }
  }, []);

  // Notification tap while the app is open/backgrounded: the service worker
  // postMessages the session to focus. Attach to it.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'persalink:open-session' && e.data.sessionId) {
        useAppStore.getState().attachSession(e.data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // Remember when the session on screen was last looked at, so a cold open
  // within ten minutes returns to it (opensFirst). Stamped as the page hides —
  // the moment the user leaves it.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      const { view, attachedSession, endedSession } = useAppStore.getState();
      if (view === 'terminal' && attachedSession && !endedSession) {
        useAppStore.setState({ lastActiveAt: Date.now() });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Route newly-created sessions into the pane that asked for them
  useEffect(() => {
    let known = new Set<string>(useAppStore.getState().sessions.map(s => s.id));
    const unsub = useAppStore.subscribe((state) => {
      const ids = state.sessions.map(s => s.id);
      const newIds = ids.filter(id => !known.has(id));
      known = new Set(ids);
      const { pendingAssignPaneId, assignSession, clearPendingAssign } = useLayoutStore.getState();
      if (pendingAssignPaneId && newIds.length > 0) {
        assignSession(pendingAssignPaneId, newIds[newIds.length - 1], useAppStore.getState().activeServerId);
        clearPendingAssign();
      }
    });
    return unsub;
  }, []);

  // Intercept browser back gesture / back button
  useEffect(() => {
    const pushState = () => {
      window.history.pushState({ persalink: true }, '');
    };

    const onPopState = () => {
      const currentView = useAppStore.getState().view;
      if (currentView === 'profile-editor' || currentView === 'settings' || currentView === 'files' || currentView === 'terminal') {
        useAppStore.getState().goBack();
      }
      pushState();
    };

    pushState();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Reconnecting overlay — shown on top of current view
  const isReconnecting = connectionState === 'reconnecting';

  // Pre-auth views are always full-screen
  if (view === 'locked') return <><LockScreen /><PublicBadge /></>;
  if (view === 'connect') return <><ConnectScreen /><PublicBadge /></>;
  if (view === 'auth') return <><AuthScreen /><PublicBadge /></>;
  // Toast lives at the root so it overlays whatever view is rendered.
  // (Pre-auth views above don't need it — server isn't accepting messages yet.)

  // Desktop: sidebar always visible + main panel (GridLayout replaces the
  // single-session TerminalScreen here — a 1-pane grid is single-session mode).
  if (isDesktop) {
    const overlaying = view === 'settings' || view === 'profile-editor' || view === 'files';
    return (
      <div className="flex h-screen bg-zinc-950 relative">
        <Sidebar />
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          {overlaying ? (
            <>
              {view === 'settings' && <SettingsScreen />}
              {view === 'profile-editor' && <ProfileEditor />}
              {view === 'files' && <FilesScreen />}
            </>
          ) : (
            <GridLayout />
          )}
        </div>
        {isReconnecting && <ReconnectingOverlay />}
        <ToastStack />
        <UpdatePill />
        <PublicBadge />
      </div>
    );
  }

  // Mobile: full-screen view switching (existing behavior)
  return (
    <div className="relative h-[100dvh]">
      {view === 'home' && <HomeScreen />}
      {view === 'terminal' && <TerminalScreen />}
      {view === 'settings' && <SettingsScreen />}
      {view === 'profile-editor' && <ProfileEditor />}
      {view === 'files' && <FilesScreen />}
      {isReconnecting && <ReconnectingOverlay />}
      <ToastStack />
      <UpdatePill />
      <PublicBadge />
    </div>
  );
}

/** Always-visible marker when this page came in through the public door, so
 *  it's never ambiguous which connection a session is on. */
function PublicBadge() {
  const signOut = useAppStore((s) => s.signOut);
  const [leaving, setLeaving] = useState(false);
  if (!isPublicDoor) return null;
  const onSignOut = () => {
    if (leaving || !window.confirm('Sign out of PersaLink on this computer?')) return;
    setLeaving(true);
    void signOut();
  };
  return (
    <div
      className="fixed top-0 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1 select-none
                 h-6 pl-0.5 pr-0.5 rounded-b-[6px] bg-bg-1/95 border border-t-0 border-line-2"
      style={{ top: 'env(safe-area-inset-top)' }}
    >
      <PublicChip className="border-0" />
      <span className="w-px h-3 bg-line-2" aria-hidden />
      <button
        type="button"
        onClick={onSignOut}
        disabled={leaving}
        className="h-5 px-1.5 rounded-[4px] text-micro font-medium text-fg-2 hover:text-fg-1 active:bg-bg-3 disabled:text-fg-4"
      >
        {leaving ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}

function ReconnectingOverlay() {
  // A warm reconnect lands in <1s. If we're still spinning after this long,
  // the server almost certainly isn't reachable — on this deployment that
  // means the Tailscale tunnel is down (phone VPN killed in the background,
  // desktop fresh-boot before tailscaled is up). Say so instead of letting
  // the user force-close the app to "fix" it.
  const HINT_AFTER_MS = 8_000;
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowHint(true), HINT_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 text-zinc-400 px-8 text-center">
        <div className="h-5 w-5 border-2 border-zinc-500 border-t-zinc-200 rounded-full animate-spin" />
        <span className="text-sm">Reconnecting...</span>
        {showHint && !isPublicDoor && (
          <span className="text-xs text-fg-2 max-w-xs">
            Still trying — the app retries automatically. If this device reaches the
            server through Tailscale (or another VPN), check that it&apos;s connected;
            after a reboot it can take a moment to come up.
          </span>
        )}
        {showHint && isPublicDoor && (
          <>
            <span className="text-xs text-fg-2 max-w-xs">
              Still trying. Your Cloudflare sign-in may have expired (it lasts 12 hours),
              or this network may be blocking the connection.
            </span>
            {/* Full navigation re-runs Cloudflare Access; a socket retry can't. */}
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-accent text-accent-ink active:bg-accent-lo"
            >
              Sign in again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
