/**
 * @file UpdatePill
 * @description "Update ready" pill shown when the server is serving a newer
 *   client bundle than the one running (see checkForUpdate in appStore).
 *   Tapping reloads — the SW is network-first on the shell, so one reload
 *   lands the new build. Replaces the old "force-close the PWA twice" ritual.
 *   Loud on purpose (owner 11-21): a solid accent banner over the session
 *   with a pulsing glow, so an update is never missed.
 */

import { RefreshCw, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

/** One loud banner over the session: a new client is waiting. `inline` is
 *  kept for callers but renders nothing; the banner covers every layout. */
export function UpdatePill({ inline = false }: { inline?: boolean }) {
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  if (!updateAvailable || inline) return null;
  return (
    <div className="pl-update" role="alert">
      <RefreshCw className="w-5 h-5 flex-none" strokeWidth={2.25} aria-hidden />
      <span className="flex-1 min-w-0">
        <b className="block text-[15px] leading-5 font-semibold">New version ready</b>
        <span className="block text-[12.5px] leading-4 opacity-80">Reload to get the update</span>
      </span>
      <button type="button" className="go" onClick={() => window.location.reload()}>Update now</button>
      <button
        type="button"
        className="x"
        onClick={() => useAppStore.setState({ updateAvailable: false })}
        aria-label="Dismiss update notice"
        title="Dismiss"
      >
        <X className="w-4 h-4" strokeWidth={2} />
      </button>
    </div>
  );
}
