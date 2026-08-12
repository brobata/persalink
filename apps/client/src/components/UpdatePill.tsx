/**
 * @file UpdatePill
 * @description "Update ready" pill shown when the server is serving a newer
 *   client bundle than the one running (see checkForUpdate in appStore).
 *   Tapping reloads — the SW is network-first on the shell, so one reload
 *   lands the new build. Replaces the old "force-close the PWA twice" ritual.
 */

import { useAppStore } from '../stores/appStore';

export function UpdatePill() {
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  if (!updateAvailable) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[60] flex items-center rounded-full
                 bg-emerald-600 text-white shadow-lg shadow-black/40"
      style={{ top: 'calc(env(safe-area-inset-top) + 8px)' }}
    >
      <button
        onClick={() => window.location.reload()}
        className="flex items-center gap-1.5 pl-3.5 pr-2 py-2 text-xs font-medium active:opacity-80"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Update ready — tap to reload
      </button>
      <button
        onClick={() => useAppStore.setState({ updateAvailable: false })}
        className="pr-3 pl-1 py-2 text-emerald-200 active:text-white text-xs"
        aria-label="Dismiss update notice"
      >
        &times;
      </button>
    </div>
  );
}
