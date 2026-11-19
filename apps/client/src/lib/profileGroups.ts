/**
 * @file Profile groups
 * @description One grouping rule for every profile list (desktop sidebar,
 *   desktop Home, phone rail and Manage sheet, command palette): pinned
 *   profiles first, then one group per `profile.group` in the order the
 *   groups first appear in the saved profile order, then profiles with no
 *   group under "Other", and an Archive group always last and folded by
 *   default. Inside a group the saved order is kept.
 */

import type { Profile } from '@persalink/shared/protocol';

export interface ProfileGroup<T extends Profile = Profile> {
  /** Stable key for fold state ("#pinned", "#other", "g:<name>"). */
  key: string;
  label: string;
  items: T[];
}

const ARCHIVE_RX = /^archived?$/i;

/** True for the group that starts folded (Archive / Archived). */
export function isArchiveGroup(label: string): boolean {
  return ARCHIVE_RX.test(label.trim());
}

/** Profiles grouped for display; empty groups are left out. */
export function groupProfiles<T extends Profile>(profiles: readonly T[]): ProfileGroup<T>[] {
  const pinned: T[] = [];
  const named = new Map<string, T[]>();
  const other: T[] = [];
  for (const p of profiles) {
    if (p.pinned) { pinned.push(p); continue; }
    const g = p.group?.trim();
    if (!g) { other.push(p); continue; }
    const list = named.get(g);
    if (list) list.push(p);
    else named.set(g, [p]);
  }
  const out: ProfileGroup<T>[] = [];
  if (pinned.length) out.push({ key: '#pinned', label: 'Pinned', items: pinned });
  const archive: ProfileGroup<T>[] = [];
  for (const [label, items] of named) {
    (isArchiveGroup(label) ? archive : out).push({ key: `g:${label}`, label, items });
  }
  if (other.length) out.push({ key: '#other', label: 'Other', items: other });
  return [...out, ...archive];
}

/** True when grouping adds nothing (one unnamed bucket): show a flat list. */
export function isFlat(groups: readonly ProfileGroup[]): boolean {
  return groups.length <= 1 && (groups[0]?.key === '#other' || groups[0]?.key === '#pinned' || groups.length === 0);
}
