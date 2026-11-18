/**
 * @file PhoneHeader
 * @description The one phone title bar (the Titan runs it too, tightened by
 *   html.pl-square): back to Home, a two-line title, the next-waiting pill
 *   and search. Line 1 is the name with its own state glyph; line 2 is the
 *   state, the time and the round trip, and is also the one slot where a
 *   short confirmation flashes ("Answered: Yes · Stop"). Tapping the title
 *   opens the session switcher; the title can also be dragged sideways (the
 *   caller attaches the swipe through the forwarded ref, and moves the
 *   .pl-ph-t inside it). Line 2 may carry its own button (Stop), so the
 *   title's tap target is a full-size button under the text, not a wrapper.
 */

import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, Search } from 'lucide-react';
import type { SessionInfo } from '@persalink/shared/protocol';
import { IconButton } from './IconButton';
import { WaitPill } from './WaitPill';

export interface PhoneHeaderProps {
  onBack?: () => void;
  backLabel?: string;
  /** Glyph before the name (the session's own state). */
  glyph?: ReactNode;
  name: string;
  /** Line 2: state · time · ms, or a confirmation. */
  line2?: ReactNode;
  /** Tap the title (opens the switcher). */
  onTitle?: () => void;
  titleLabel?: string;
  /** Remounts the title on change, so it slides in (session switches). */
  titleKey?: string;
  /** Slide direction for the title: 1 from the right, -1 from the left, 0 fade. */
  slide?: number;
  /** The next-waiting pill reads these. */
  sessions?: readonly SessionInfo[];
  currentId?: string | null;
  onJumpWaiting?: (s: SessionInfo) => void;
  onSearch?: () => void;
}

export const PhoneHeader = forwardRef<HTMLDivElement, PhoneHeaderProps>(function PhoneHeader({
  onBack, backLabel = 'Home', glyph, name, line2, onTitle, titleLabel, titleKey, slide = 0,
  sessions, currentId = null, onJumpWaiting, onSearch,
}, titleRef) {
  const slideStyle = { '--pl-dx': `${slide * 12}px` } as CSSProperties;
  return (
    <header className="pl-ph">
      {onBack
        ? (
          <IconButton label={backLabel} onPointerDown={(e) => e.preventDefault()} onClick={onBack}>
            <ChevronLeft className="w-[18px] h-[18px]" strokeWidth={1.75} />
          </IconButton>
        )
        : <span className="w-2 shrink-0" />}
      <div ref={titleRef} className="pl-ph-c">
        <button
          type="button"
          className="pl-ph-hit"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onTitle}
          aria-label={titleLabel ?? name}
          disabled={!onTitle}
        />
        <span key={titleKey} className={`pl-ph-t${slide ? ' slide' : ''}`} style={slideStyle}>
          <span className="r1">
            {glyph}
            <span className="nm">{name}</span>
            {onTitle && <ChevronDown className="w-3.5 h-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />}
          </span>
          <span className="r2">{line2}</span>
        </span>
      </div>
      {sessions && onJumpWaiting && (
        <WaitPill variant="phone" sessions={sessions} currentId={currentId} onJump={onJumpWaiting} />
      )}
      {onSearch && (
        <IconButton label="Search sessions and commands" onPointerDown={(e) => e.preventDefault()} onClick={onSearch}>
          <Search className="w-[18px] h-[18px]" strokeWidth={1.75} />
        </IconButton>
      )}
    </header>
  );
});

/** A confirmation in line 2 for a moment ("Answered: Yes", "Sent to Olive"). */
export function HeaderFlash({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <span className="pl-flash" role="status">
      <span className="truncate">{children}</span>
      {action}
    </span>
  );
}
