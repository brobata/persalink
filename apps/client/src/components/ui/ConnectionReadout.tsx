/**
 * @file ConnectionReadout
 * @description The one connection readout: where you are and how fast it
 *   is. Connected = accent dot + "18 ms" in meta text; slow (over 250ms) =
 *   hollow accent dot + the ms in primary text + "slow"; reconnecting or
 *   offline = the disconnected blue-grey, never amber (amber means only
 *   "waiting for you"). The public door shows as a quiet outlined chip.
 */

import { Globe } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { isPublicDoor } from '../../lib/door';
import { readout } from '../../lib/readout';

export function ConnectionReadout({ server, dot = true, className = '' }: {
  /** Also name the server ("x570d4u · 18 ms"). */
  server?: boolean;
  /** Draw the dot; off where a state glyph beside it already says it. */
  dot?: boolean;
  className?: string;
}) {
  const state = useAppStore((s) => s.connectionState);
  const rttMs = useAppStore((s) => s.rttMs);
  const serverName = useAppStore((s) => s.serverName);
  const r = readout(state, rttMs);
  const showDot = dot;
  const dotClass = r.kind === 'ok'
    ? 'bg-accent'
    : r.kind === 'slow'
      ? 'shadow-[inset_0_0_0_1.5px_var(--color-accent)]'
      : 'shadow-[inset_0_0_0_1.25px_var(--color-st-disconnected)]';
  const tone = r.kind === 'ok' ? 'text-fg-3' : r.kind === 'slow' ? 'text-fg-1' : 'text-st-disconnected';
  return (
    <span
      className={`inline-flex items-center gap-1.5 min-w-0 whitespace-nowrap text-micro font-mono tnum ${tone} ${className}`}
      title={[serverName, r.text, isPublicDoor ? 'through the public door' : ''].filter(Boolean).join(' · ')}
    >
      {showDot && <i className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotClass}`} aria-hidden />}
      {server && serverName && <span className="truncate text-fg-2">{serverName}</span>}
      {server && serverName && <span className="text-fg-4" aria-hidden>·</span>}
      <span>{r.text}</span>
    </span>
  );
}

/** The public-door marker: outlined, quiet, with a globe. */
export function PublicChip({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-[4px] border border-line-3 text-micro font-medium text-fg-2 ${className}`}
      title="Connected through the public internet entrance"
    >
      <Globe className="w-3 h-3" strokeWidth={1.75} aria-hidden />
      Public
    </span>
  );
}
