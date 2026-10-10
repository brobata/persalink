/**
 * @file Install-as-app
 * @description Captures Chrome/Edge's `beforeinstallprompt` so the shortcuts
 *   panel can offer "Install as an app". Installed, PersaLink runs in its own
 *   window with its own taskbar icon, and browser-tab shortcuts (Ctrl+Tab,
 *   Ctrl+PageUp/Down…) are no longer the browser's to take. The event fires
 *   once, early — this module must be imported at startup (main.tsx).
 */

import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it for our button instead of the mini-infobar
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export function isInstalledApp(): boolean {
  return typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
     window.matchMedia('(display-mode: window-controls-overlay)').matches);
}

/** True while the browser is offering installation. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => deferred !== null,
  );
}

export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  notify();
  await e.prompt();
}
