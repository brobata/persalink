/**
 * @file ProfileTile
 * @description A profile drawn as a monogram tile: one or two letters on a
 *   14% tint of the profile colour with a 2px colour bar on its left edge.
 *   Profile colours are user data and appear only here, never as state.
 *   Replaces every emoji profile icon.
 */

import { monogram, tileColor } from '../../lib/monogram';

export function ProfileTile({ name, color, size = 22, className = '' }: {
  name: string | null | undefined;
  color?: string | null;
  size?: number;
  className?: string;
}) {
  const c = tileColor(color);
  return (
    <span
      aria-hidden
      className={`inline-grid place-items-center shrink-0 rounded-[6px] font-semibold select-none ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.46)),
        lineHeight: 1,
        letterSpacing: '0.02em',
        background: c ? `color-mix(in srgb, ${c} 14%, transparent)` : 'var(--color-bg-3)',
        color: c ?? 'var(--color-fg-2)',
        boxShadow: c ? `inset 2px 0 0 ${c}` : undefined,
      }}
    >
      {monogram(name)}
    </span>
  );
}
