/**
 * @file Dock
 * @description The one phone bottom dock: equal columns, an icon in a 48px
 *   pill over an 11px label. At most one item is `primary` (the soft accent:
 *   the screen's one obvious next action); `on` marks a toggle that is open;
 *   `badge` is a count in amber (only ever "agents waiting"). Taps keep the
 *   terminal's focus. `hidden` folds the dock to zero height (the soft
 *   keyboard is up and the key row stands in for it).
 */

import type { ReactNode } from 'react';

export interface DockItem {
  id: string;
  icon: ReactNode;
  label: string;
  onPress: () => void;
  primary?: boolean;
  on?: boolean;
  /** Something is running right now (the mic): solid fill and a breathing glow. */
  live?: boolean;
  badge?: number;
  /** Spoken name when the label alone is not enough. */
  aria?: string;
}

export function Dock({ items, hidden = false }: { items: readonly DockItem[]; hidden?: boolean }) {
  return (
    <nav
      className={`pl-dock${hidden ? ' hide' : ''}`}
      aria-label="Actions"
      aria-hidden={hidden || undefined}
      inert={hidden}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`pl-dk${it.primary ? ' pri' : ''}${it.on ? ' on' : ''}${it.live ? ' live' : ''}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={it.onPress}
          aria-pressed={it.on === undefined ? undefined : it.on}
          aria-label={it.aria ?? (it.badge ? `${it.label}, ${it.badge} waiting` : it.label)}
        >
          <span className="pill" aria-hidden>{it.icon}</span>
          <span className="lb" aria-hidden>{it.label}</span>
          {!!it.badge && <span className="bdg tnum" aria-hidden>{it.badge}</span>}
        </button>
      ))}
    </nav>
  );
}
