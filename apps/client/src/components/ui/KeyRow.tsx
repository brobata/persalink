/**
 * @file KeyRow
 * @description The one terminal key row for touch phones: the keys a soft
 *   keyboard lacks. Esc, Tab, a sticky Ctrl and the arrows are pinned on the
 *   left; the shell's suggestions for what you are typing come first in the
 *   scrolling part (soft accent, the typed prefix in white), then the space
 *   trackpad, Snippets and the rarer keys. 44px tall, neutral keys, Ctrl
 *   armed shows as the soft accent. With `keys` off the same row carries the
 *   suggestions alone. Every key keeps terminal focus (pointerdown
 *   preventDefault), so the soft keyboard stays up between taps.
 */

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Braces, ChevronDown } from 'lucide-react';

export const PINNED: Array<{ label: string; seq: string; aria: string }> = [
  { label: 'Esc', seq: '\x1b', aria: 'Escape' },
  { label: 'Tab', seq: '\t', aria: 'Tab' },
];

export const ARROWS: Array<{ seq: string; aria: string; icon: ReactNode }> = [
  { seq: '\x1b[A', aria: 'Up', icon: <ArrowUp className="w-4 h-4" strokeWidth={1.75} /> },
  { seq: '\x1b[B', aria: 'Down', icon: <ArrowDown className="w-4 h-4" strokeWidth={1.75} /> },
  { seq: '\x1b[D', aria: 'Left', icon: <ArrowLeft className="w-4 h-4" strokeWidth={1.75} /> },
  { seq: '\x1b[C', aria: 'Right', icon: <ArrowRight className="w-4 h-4" strokeWidth={1.75} /> },
];

export const MORE_KEYS: Array<{ label: string; seq: string; aria: string }> = [
  { label: '⇧Tab', seq: '\x1b[Z', aria: 'Shift Tab' },
  { label: '^C', seq: '\x03', aria: 'Control C' },
  { label: '^D', seq: '\x04', aria: 'Control D' },
  { label: '^L', seq: '\x0c', aria: 'Control L' },
  { label: '^R', seq: '\x12', aria: 'Control R' },
  { label: 'PgUp', seq: '\x1b[5~', aria: 'Page up' },
  { label: 'PgDn', seq: '\x1b[6~', aria: 'Page down' },
  { label: 'Home', seq: '\x1b[H', aria: 'Home' },
  { label: 'End', seq: '\x1b[F', aria: 'End' },
];

export const KEY = 'shrink-0 h-9 rounded-[6px] bg-bg-3 text-fg-1 font-mono text-[13px] grid place-items-center select-none transition-colors duration-(--d-press) active:bg-bg-4';

function hold(e: ReactPointerEvent) {
  // Keep terminal focus so the soft keyboard stays up between taps.
  e.preventDefault();
}

// Space that doubles as a trackpad: tap = space, hold and slide = arrow keys
// (Termius's alternative cursor control). One arrow per 14px of travel.
// touch-action none + pointer capture keep the slide from scrolling the row.
function SpaceTrackpadKey({ sendInput }: { sendInput: (data: string) => void }) {
  const STEP_PX = 14;
  const st = useRef({ active: false, moved: false, lastX: 0, lastY: 0 });
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        st.current = { active: true, moved: false, lastX: e.clientX, lastY: e.clientY };
      }}
      onPointerMove={(e) => {
        const s = st.current;
        if (!s.active) return;
        const dx = e.clientX - s.lastX;
        const dy = e.clientY - s.lastY;
        if (Math.abs(dx) >= Math.abs(dy)) {
          const steps = Math.trunc(dx / STEP_PX);
          if (steps !== 0) {
            s.lastX += steps * STEP_PX;
            s.lastY = e.clientY;
            s.moved = true;
            sendInput((steps > 0 ? '\x1b[C' : '\x1b[D').repeat(Math.abs(steps)));
          }
        } else {
          const steps = Math.trunc(dy / STEP_PX);
          if (steps !== 0) {
            s.lastY += steps * STEP_PX;
            s.lastX = e.clientX;
            s.moved = true;
            sendInput((steps > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(steps)));
          }
        }
      }}
      onPointerUp={() => {
        const s = st.current;
        if (s.active && !s.moved) sendInput(' ');
        s.active = false;
      }}
      onPointerCancel={() => { st.current.active = false; }}
      className={`${KEY} min-w-[72px] px-4 text-fg-3`}
      style={{ touchAction: 'none' }}
      title="Space. Hold and slide for arrow keys."
      aria-label="Space. Hold and slide for arrow keys."
    >
      ␣
    </button>
  );
}

export interface KeySuggestions {
  /** What is typed so far. */
  prefix: string;
  /** Whole commands that start with it. */
  items: readonly string[];
}

export function KeyRow({ sendInput, ctrlArmed, onToggleCtrl, onOpenSnippets, suggestions, onSuggest, keys = true, onHide }: {
  sendInput: (data: string) => void;
  /** Sticky Ctrl: arm it, then type a letter on the soft keyboard. */
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onOpenSnippets: () => void;
  /** Shell history matches for the command being typed. */
  suggestions?: KeySuggestions;
  /** A suggestion was tapped (the caller types the rest of it). */
  onSuggest?: (command: string) => void;
  /** Draw the keys; off leaves the suggestions alone in the row. */
  keys?: boolean;
  /** Put the soft keyboard away (a button at the right end). */
  onHide?: () => void;
}) {
  const sugg = suggestions && suggestions.items.length > 0 ? suggestions : null;
  const chips = sugg && onSuggest
    ? sugg.items.map((cmd) => (
      <button
        key={cmd}
        type="button"
        onPointerDown={(e) => { hold(e); onSuggest(cmd); }}
        className="pl-sug"
        title={cmd}
        aria-label={`Complete: ${cmd}`}
      >
        <b>{sugg.prefix}</b>{cmd.slice(sugg.prefix.length)}
      </button>
    ))
    : null;
  return (
    <div className="pl-keyrow" role="toolbar" aria-label="Terminal keys">
      {keys && (
        <div className="shrink-0 h-11 flex items-center gap-[3px] px-[5px] border-r border-line">
          {PINNED.map((k) => (
            <button key={k.label} type="button" onPointerDown={(e) => { hold(e); sendInput(k.seq); }} className={`${KEY} w-[38px] h-10`} aria-label={k.aria}>
              {k.label}
            </button>
          ))}
          {/* Soft keyboards have no Ctrl key, and a fixed ^X list can never
              cover every combo. Disarms after one use. */}
          <button
            type="button"
            onPointerDown={(e) => { hold(e); onToggleCtrl(); }}
            aria-pressed={ctrlArmed}
            aria-label="Control, applies to the next key"
            className={`${KEY} w-[38px] h-10 ${ctrlArmed ? '!bg-accent-soft !text-accent-hi shadow-[inset_0_0_0_1px_rgba(61,220,151,0.4)]' : ''}`}
          >
            Ctrl
          </button>
          {ARROWS.map((k) => (
            <button key={k.aria} type="button" onPointerDown={(e) => { hold(e); sendInput(k.seq); }} className={`${KEY} w-[31px] h-10`} aria-label={k.aria}>
              {k.icon}
            </button>
          ))}
        </div>
      )}
      <div
        className="flex-1 min-w-0 h-11 flex items-center gap-1 pl-1.5 pr-[18px] overflow-x-auto"
        style={{
          scrollbarWidth: 'none',
          WebkitMaskImage: 'linear-gradient(90deg,#000 calc(100% - 18px),transparent)',
          maskImage: 'linear-gradient(90deg,#000 calc(100% - 18px),transparent)',
        }}
      >
        {chips}
        {chips && keys && <span className="shrink-0 w-px h-5 mx-1 bg-line-2" aria-hidden />}
        {keys && (
          <>
            <SpaceTrackpadKey sendInput={sendInput} />
            <button
              type="button"
              onPointerDown={(e) => { hold(e); onOpenSnippets(); }}
              className={`${KEY} min-w-10 px-2.5 text-fg-2`}
              title="Snippets: saved commands"
              aria-label="Snippets"
            >
              <Braces className="w-4 h-4" strokeWidth={1.75} />
            </button>
            {MORE_KEYS.map((k) => (
              <button key={k.label} type="button" onPointerDown={(e) => { hold(e); sendInput(k.seq); }} className={`${KEY} min-w-10 px-2.5`} aria-label={k.aria}>
                {k.label}
              </button>
            ))}
          </>
        )}
      </div>
      {onHide && (
        <button
          type="button"
          onPointerDown={(e) => { hold(e); onHide(); }}
          className="shrink-0 w-11 h-11 grid place-items-center text-fg-2 border-l border-line active:bg-bg-3"
          aria-label="Hide the keyboard"
          title="Hide the keyboard"
        >
          <ChevronDown className="w-4 h-4" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
