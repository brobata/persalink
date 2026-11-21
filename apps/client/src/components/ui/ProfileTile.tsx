/**
 * @file ProfileTile
 * @description A profile's tile: its own icon (the owner's chosen emoji) or,
 *   when it has none, a one- or two-letter monogram, on a 14% tint of the
 *   profile colour (no edge bar: the owner asked for it gone, 2026-11-20). Profile icons and
 *   colours are user data and appear only here, never as state.
 */

import type { SessionInfo } from '@persalink/shared/protocol';
import { monogram, tileColor } from '../../lib/monogram';
import { useAppStore } from '../../stores/appStore';

export function ProfileTile({ name, icon, color, size = 22, className = '' }: {
  name: string | null | undefined;
  icon?: string | null;
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
        fontSize: icon ? Math.round(size * 0.62) : Math.max(10, Math.round(size * 0.46)),
        lineHeight: 1,
        letterSpacing: '0.02em',
        background: c ? `color-mix(in srgb, ${c} 14%, transparent)` : 'var(--color-bg-3)',
        color: c ?? 'var(--color-fg-2)',
      }}
    >
      {icon || monogram(name)}
    </span>
  );
}

/** The tile of the profile a session was started from; nothing for a bare session. */
export function SessionIcon({ session, size = 18 }: { session: Pick<SessionInfo, 'profileId'>; size?: number }) {
  const profile = useAppStore((s) => (session.profileId ? s.profiles.find((p) => p.id === session.profileId) : undefined));
  return profile ? <ProfileTile name={profile.name} icon={profile.icon} color={profile.color} size={size} /> : null;
}
