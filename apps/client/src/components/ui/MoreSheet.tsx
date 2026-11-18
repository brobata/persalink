/**
 * @file MoreSheet
 * @description The one "More" surface: a Sheet holding one-line menu rows
 *   (icon, label, optional meta on the right). MenuRow is also the row for
 *   any other action list inside a sheet. Screens pass their items; the
 *   phone terminal mounts it from its dock (design step 6).
 */

import type { ReactNode } from 'react';
import { Sheet, useSheetClose } from './Sheet';

export interface MenuItem {
  id: string;
  icon: ReactNode;
  label: string;
  /** Short meta on the right ("Night", "for a phone with keys"). */
  sub?: string;
  /** Accent the meta (an update that is ready). */
  highlight?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  run: () => void;
}

export function MenuRow({ icon, label, sub, highlight, disabled, onClick }: {
  icon: ReactNode;
  label: string;
  sub?: string;
  highlight?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 min-h-12 px-3 rounded-[10px] text-left text-body text-fg-1 transition-colors duration-(--d-press) hover:bg-bg-3 active:bg-bg-3 disabled:text-fg-4 [html.pl-square_&]:min-h-11"
    >
      <span className="shrink-0 text-fg-3 [&_svg]:w-[18px] [&_svg]:h-[18px]">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {sub && <span className={`shrink-0 text-meta ${highlight ? 'text-accent-hi' : 'text-fg-3'}`}>{sub}</span>}
    </button>
  );
}

function Rows({ items }: { items: readonly MenuItem[] }) {
  const close = useSheetClose();
  return (
    <div className="flex flex-col">
      {items.filter((i) => !i.hidden).map((i) => (
        <MenuRow
          key={i.id}
          icon={i.icon}
          label={i.label}
          sub={i.sub}
          highlight={i.highlight}
          disabled={i.disabled}
          onClick={() => { close(); i.run(); }}
        />
      ))}
    </div>
  );
}

export function MoreSheet({ title, sub, header, items, onClose }: {
  title: ReactNode;
  sub?: ReactNode;
  /** A line above the rows (terminal size, connection). */
  header?: ReactNode;
  items: readonly MenuItem[];
  onClose: () => void;
}) {
  return (
    <Sheet title={title} sub={sub} onClose={onClose}>
      {header && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-meta text-fg-3">{header}</div>}
      <Rows items={items} />
    </Sheet>
  );
}
