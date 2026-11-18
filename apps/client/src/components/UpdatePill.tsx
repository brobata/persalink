/**
 * @file UpdatePill
 * @description "Update ready" pill shown when the server is serving a newer
 *   client bundle than the one running (see checkForUpdate in appStore).
 *   Tapping reloads — the SW is network-first on the shell, so one reload
 *   lands the new build. Replaces the old "force-close the PWA twice" ritual.
 *   Quiet: a raised neutral pill with an accent icon, never a solid fill.
 */

import { RefreshCw, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

export function UpdatePill() {
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  if (!updateAvailable) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[60] flex items-center rounded-full
                 bg-bg-2 border border-line-2 text-fg-1 shadow-(--e-2-shadow) motion-safe:animate-pop"
      style={{ top: 'calc(env(safe-area-inset-top) + 8px)' }}
      role="status"
    >
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="flex items-center gap-2 pl-3.5 pr-2 h-9 text-meta font-medium"
      >
        <RefreshCw className="w-3.5 h-3.5 text-accent-hi" strokeWidth={1.75} />
        Update ready
        <span className="text-accent-hi">Reload</span>
      </button>
      <button
        type="button"
        onClick={() => useAppStore.setState({ updateAvailable: false })}
        className="grid place-items-center w-9 h-9 text-fg-3 hover:text-fg-1"
        aria-label="Dismiss update notice"
        title="Dismiss"
      >
        <X className="w-3.5 h-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}
