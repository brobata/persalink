import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppStore } from './stores/appStore';
import { LockScreen } from './components/LockScreen';
import { ConnectScreen } from './components/ConnectScreen';
import { AuthScreen } from './components/AuthScreen';
import { HomeScreen } from './components/HomeScreen';
import { TerminalScreen } from './components/TerminalScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { ProfileEditor } from './components/ProfileEditor';
import { Sidebar } from './components/Sidebar';
import { GridLayout } from './components/GridLayout';
import { useLayoutStore } from './stores/layoutStore';

// ============================================================================
// Desktop breakpoint hook
// ============================================================================

const MQ = '(min-width: 768px)';
const mqList = typeof window !== 'undefined' ? window.matchMedia(MQ) : null;

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
    const { serverUrl, authToken, connectionState: cs } = useAppStore.getState();
    if (serverUrl && authToken && cs === 'disconnected') {
      useAppStore.getState().connect();
    }
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
        assignSession(pendingAssignPaneId, newIds[newIds.length - 1]);
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
      if (currentView === 'profile-editor' || currentView === 'settings' || currentView === 'terminal') {
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
  if (view === 'locked') return <LockScreen />;
  if (view === 'connect') return <ConnectScreen />;
  if (view === 'auth') return <AuthScreen />;

  // Desktop: sidebar always visible + main panel (GridLayout replaces the
  // single-session TerminalScreen here — a 1-pane grid is single-session mode).
  if (isDesktop) {
    const overlaying = view === 'settings' || view === 'profile-editor';
    return (
      <div className="flex h-screen bg-zinc-950 relative">
        <Sidebar />
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          {overlaying ? (
            <>
              {view === 'settings' && <SettingsScreen />}
              {view === 'profile-editor' && <ProfileEditor />}
            </>
          ) : (
            <GridLayout />
          )}
        </div>
        {isReconnecting && <ReconnectingOverlay />}
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
      {isReconnecting && <ReconnectingOverlay />}
    </div>
  );
}

function ReconnectingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 text-zinc-400">
        <div className="h-5 w-5 border-2 border-zinc-500 border-t-zinc-200 rounded-full animate-spin" />
        <span className="text-sm">Reconnecting...</span>
      </div>
    </div>
  );
}
