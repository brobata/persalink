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
import { ReconnectLine, ReconnectBanner } from './components/ui/Reconnect';
import { useLayoutStore } from './stores/layoutStore';
import { stashShare } from './lib/shareTarget';
import { isPublicDoor } from './lib/door';
import { DESKTOP_MQ } from './lib/platform';
import { CommandPalette } from './components/CommandPalette';
import { QuickActionResult } from './components/QuickActionResult';
import { KeyboardShortcutsSheet, useGlobalShortcuts } from './components/ShortcutsPanel';
import { useUiStore } from './stores/uiStore';

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
  const initBiometric = useAppStore((s) => s.initBiometric);
  const isDesktop = useIsDesktop();
  const signedIn = view !== 'locked' && view !== 'connect' && view !== 'auth';
  // Window-level keys. Desktop: everywhere once signed in. Phone: only with a
  // hardware keyboard; the terminal mounts its own (it detects the keyboard
  // live), every other phone screen goes by the remembered detection.
  useGlobalShortcuts({ variant: 'desktop', enabled: isDesktop && signedIn });
  useGlobalShortcuts({ variant: 'phone', enabled: !isDesktop && signedIn && view !== 'terminal' && hardwareKeyboardSeen() });

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
      // System back closes the palette or the shortcuts list first.
      const ui = useUiStore.getState();
      if (ui.paletteOpen || ui.shortcutsOpen) {
        if (ui.paletteOpen) ui.closePalette();
        else ui.closeShortcuts();
      } else if (currentView === 'profile-editor' || currentView === 'settings' || currentView === 'files' || currentView === 'terminal') {
        useAppStore.getState().goBack();
      }
      pushState();
    };

    pushState();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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
        <ReconnectLine />
        <ReconnectBanner />
        <WindowSurfaces />
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
      {/* A dropped link reconnects in place: a line, "reconnecting" in the
          title, and a banner only after 8s (docked inside the terminal). */}
      <ReconnectLine />
      {view !== 'terminal' && <ReconnectBanner />}
      <WindowSurfaces />
      <ToastStack />
      <UpdatePill />
      <PublicBadge />
    </div>
  );
}

/** A phone keyboard was seen on this device before (TerminalScreen records
 *  the first physical keypress). */
function hardwareKeyboardSeen(): boolean {
  try { return localStorage.getItem('persalink-hw-keyboard') === 'true'; } catch { return false; }
}

/** Surfaces any screen can open, mounted once: the command palette, the
 *  Keyboard shortcuts sheet and a palette-run quick action's result. */
function WindowSurfaces() {
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);
  const closeShortcuts = useUiStore((s) => s.closeShortcuts);
  return (
    <>
      <CommandPalette />
      {shortcutsOpen && <KeyboardShortcutsSheet onClose={closeShortcuts} />}
      <QuickActionResult />
    </>
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
