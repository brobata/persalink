/**
 * @file SessionRow
 * @description The one session row, for every list (phone switcher, home,
 *   desktop sidebar, pane picker). One line: state glyph, name, a server chip
 *   only when the session is not on the main box, "Here" for the session on
 *   screen, and an age. A second line (the waiting question or what it is
 *   doing) appears only when asked for: `detail="selected"` (the default)
 *   shows it on the selected row; `detail="auto"` shows it for Needs you and
 *   Working rows. Amber appears once per waiting agent: the glyph. Paths,
 *   profile names and the full preview live in the tooltip.
 */

import type { ReactNode } from 'react';
import type { SessionInfo } from '@persalink/shared/protocol';
import { SessionIcon } from './ProfileTile';
import { useLongPress } from '../../lib/useLongPress';
import { groupOf, previewLine, rowAge, sessionTitle, stateKey, stateWord, type StateKey } from '../../lib/sessionState';

export interface SessionRowProps {
  session: SessionInfo;
  onOpen: () => void;
  /** The session on screen (drawn selected, "Here", its working arc turns). */
  current?: boolean;
  /** Selected in a list (keyboard or hover selection); shows the detail line. */
  selected?: boolean;
  detail?: 'selected' | 'auto' | 'never';
  /** Server name, passed only when the session is NOT on the main box. */
  server?: string | null;
  /** A client-side state the protocol does not carry (a tombstone). */
  state?: StateKey;
  /** 'touch' = 52px phone row (44 on the square phone); 'compact' = 32px desktop row. */
  density?: 'touch' | 'compact';
  /** Trailing controls (rename, kill), outside the open button. */
  trailing?: ReactNode;
  /** Extra text for the tooltip. */
  hint?: string;
  /** Hold the row: the same menu its trailing button opens. */
  onLongPress?: () => void;
}

const noop = () => {};

export function SessionRow({
  session, onOpen, current, selected, detail = 'selected', server, state, density = 'touch', trailing, hint, onLongPress,
}: SessionRowProps) {
  const press = useLongPress(onLongPress ?? noop, onOpen);
  const k = state ?? stateKey(session);
  const g = groupOf(k);
  const age = rowAge(session, k);
  const showDetail = detail === 'never' ? false
    : detail === 'auto' ? (g === 'needs' || g === 'working' || k === 'done')
    : !!selected;
  const sub = showDetail ? (k === 'done' ? `New output · ${previewLine(session, k)}` : previewLine(session, k)) : '';
  const touch = density === 'touch';
  const name = sessionTitle(session);
  const tip = [name, session.profileName && session.profileName !== name ? session.profileName : '', server ?? '', stateWord(session, k), hint ?? '']
    .filter(Boolean).join(' · ');

  return (
    <div
      className={`group flex items-stretch rounded-[10px] transition-colors duration-(--d-press) ${
        current || selected ? 'bg-bg-3' : 'hover:bg-bg-3/60 active:bg-bg-3'
      } ${k === 'exited' ? 'opacity-70' : ''}`}
      data-st={k}
    >
      <button
        type="button"
        {...(onLongPress ? press : { onClick: onOpen })}
        title={tip}
        aria-current={current ? 'true' : undefined}
        className={`flex-1 min-w-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 text-left ${
          touch ? 'min-h-(--pl-row-h) px-2.5 py-2' : 'min-h-8 px-2 py-1'
        }`}
      >
        <span className={`flex items-center gap-1.5 min-w-0 ${touch ? 'text-[14px] leading-5 font-medium' : 'text-body font-medium'} text-fg-1`}>
          <SessionIcon session={session} size={touch ? 20 : 18} />
          <span className="truncate">{name}</span>
          {server && (
            <span className="shrink-0 px-1 rounded-[4px] border border-line-2 text-micro font-mono text-fg-3">{server}</span>
          )}
          {current && touch && <span className="shrink-0 text-micro font-medium text-accent-hi">Here</span>}
        </span>
        <span className="text-micro font-mono tnum text-fg-3 whitespace-nowrap">{age}</span>
        {sub && (
          <span className={`col-start-1 col-end-3 truncate font-sans ${touch ? 'text-[12.5px] leading-[17px]' : 'text-meta'} ${
            g === 'needs' ? 'text-fg-2' : 'text-fg-3'
          }`}>
            {sub}
          </span>
        )}
      </button>
      {trailing && (
        // On touch the trailing button gets the row's full height and a
        // thumb-wide column, not just its 44px icon square.
        <div className={touch ? 'flex items-stretch shrink-0 [&_.pl-ib]:h-auto [&_.pl-ib]:w-12' : 'flex items-center shrink-0 pr-1'}>
          {trailing}
        </div>
      )}
    </div>
  );
}
