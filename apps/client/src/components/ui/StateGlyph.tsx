/**
 * @file StateGlyph
 * @description The one glyph per session state, drawn the same on every
 *   surface. Static by default: a working arc turns only when `live` (the
 *   session in focus), and a waiting ring breathes only when `breathe` (the
 *   wait pill), so a list of sessions never looks restless. Done is a ring
 *   with the new-output dot inside it. Colours come from the --st-* tokens;
 *   reduced motion stops both loops (styles/index.css).
 */

import type { ReactNode } from 'react';
import type { StateKey } from '../../lib/sessionState';
import { STATE_LABEL } from '../../lib/sessionState';

const C: Record<StateKey, string> = {
  waiting: 'var(--color-st-waiting)',
  working: 'var(--color-st-working)',
  done: 'var(--color-st-idle)',
  idle: 'var(--color-st-idle)',
  error: 'var(--color-st-error)',
  exited: 'var(--color-st-exited)',
  disconnected: 'var(--color-st-disconnected)',
};

export function StateGlyph({ state, size = 12, live = false, breathe = false, label, className = '' }: {
  state: StateKey;
  size?: number;
  /** Spin the working arc (only the session you are looking at). */
  live?: boolean;
  /** Breathe the waiting ring (only the screen's one wait pill). */
  breathe?: boolean;
  /** Spoken label; omit when the text next to the glyph already says it. */
  label?: string;
  className?: string;
}) {
  const c = C[state];
  let body: ReactNode;
  switch (state) {
    case 'waiting':
      body = (
        <>
          <circle className="g-ring" cx="8" cy="8" r="6.5" fill="none" stroke={c} strokeWidth="1.5" />
          <circle cx="8" cy="8" r="3.75" fill={c} />
        </>
      );
      break;
    case 'working':
      body = (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke={c} strokeOpacity=".24" strokeWidth="1.75" />
          <circle className="g-spin" cx="8" cy="8" r="5.5" fill="none" stroke={c} strokeWidth="1.75" strokeLinecap="round" strokeDasharray="11.5 34.6" />
        </>
      );
      break;
    case 'done':
      body = (
        <>
          <circle cx="8" cy="8" r="5.75" fill="none" stroke={c} strokeWidth="1.5" />
          <circle cx="8" cy="8" r="2.5" fill="var(--color-accent)" />
        </>
      );
      break;
    case 'idle':
      body = <circle cx="8" cy="8" r="4.25" fill="none" stroke={c} strokeWidth="1.5" opacity=".6" />;
      break;
    case 'error':
      body = <rect x="4" y="4" width="8" height="8" rx="2" fill={c} />;
      break;
    case 'exited':
      body = <line x1="4.5" y1="8" x2="11.5" y2="8" stroke={c} strokeWidth="2" strokeLinecap="round" />;
      break;
    case 'disconnected':
      body = <circle className="g-spin-slow" cx="8" cy="8" r="5.25" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2.4 2.4" />;
      break;
  }
  return (
    <svg
      className={`pl-g g-${state}${live ? ' live' : ''}${breathe ? ' breathe' : ''} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
    >
      {label ? <title>{label}</title> : null}
      {body}
    </svg>
  );
}

/** The spoken name of a state, for labels next to a bare glyph. */
export function stateName(k: StateKey): string {
  return STATE_LABEL[k];
}
