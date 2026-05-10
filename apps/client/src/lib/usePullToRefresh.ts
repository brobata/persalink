import { useEffect, useRef, useState, type RefObject } from 'react';

const TRIGGER_DISTANCE = 70;
const MAX_PULL = 120;
const RESISTANCE = 0.5;

export type PullPhase = 'idle' | 'pulling' | 'refreshing';

export interface PullToRefreshDebug {
  attached: boolean;
  starts: number;
  moves: number;
  ends: number;
  scrollTop: number;
  lastDy: number;
  lastCancelable: boolean | null;
}

export interface PullToRefreshState {
  pullDistance: number;
  phase: PullPhase;
  triggerDistance: number;
  debug: PullToRefreshDebug;
}

/**
 * Custom pull-to-refresh that coexists with an inner scroll container.
 *
 * Only claims the gesture when the element is already scrolled to top and the
 * finger drags downward. Otherwise the touch falls through to native scrolling.
 */
export function usePullToRefresh(
  scrollRef: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void> | void,
): PullToRefreshState {
  const [pullDistance, setPullDistance] = useState(0);
  const [phase, setPhase] = useState<PullPhase>('idle');
  const [debug, setDebug] = useState<PullToRefreshDebug>({
    attached: false,
    starts: 0,
    moves: 0,
    ends: 0,
    scrollTop: 0,
    lastDy: 0,
    lastCancelable: null,
  });

  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      setDebug((d) => ({ ...d, attached: false }));
      return;
    }
    setDebug((d) => ({ ...d, attached: true }));

    let startY: number | null = null;
    let tracking = false;
    let currentDistance = 0;
    let isRefreshing = false;

    const setPull = (v: number) => {
      currentDistance = v;
      setPullDistance(v);
    };

    const onStart = (e: TouchEvent) => {
      setDebug((d) => ({ ...d, starts: d.starts + 1, scrollTop: el.scrollTop }));
      if (isRefreshing) return;
      // Only arm if the scroll container is already at the top.
      if (el.scrollTop > 0) {
        startY = null;
        return;
      }
      startY = e.touches[0].clientY;
      tracking = false;
    };

    const onMove = (e: TouchEvent) => {
      if (isRefreshing || startY == null) return;
      const dy = e.touches[0].clientY - startY;
      setDebug((d) => ({ ...d, moves: d.moves + 1, lastDy: dy, lastCancelable: e.cancelable }));
      if (dy <= 0) {
        // User reversed direction before triggering — release the gesture.
        if (tracking) {
          tracking = false;
          setPhase('idle');
          setPull(0);
        }
        return;
      }
      // Claim the gesture so the browser doesn't try to scroll/refresh itself.
      if (e.cancelable) e.preventDefault();
      if (!tracking) {
        tracking = true;
        setPhase('pulling');
      }
      setPull(Math.min(MAX_PULL, dy * RESISTANCE));
    };

    const onEnd = () => {
      setDebug((d) => ({ ...d, ends: d.ends + 1 }));
      const distance = currentDistance;
      const wasTracking = tracking;
      startY = null;
      tracking = false;

      if (!wasTracking) {
        return;
      }

      if (distance >= TRIGGER_DISTANCE) {
        isRefreshing = true;
        setPhase('refreshing');
        setPull(TRIGGER_DISTANCE);
        Promise.resolve()
          .then(() => onRefreshRef.current())
          .finally(() => {
            isRefreshing = false;
            setPhase('idle');
            setPull(0);
          });
      } else {
        setPhase('idle');
        setPull(0);
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [scrollRef]);

  return { pullDistance, phase, triggerDistance: TRIGGER_DISTANCE, debug };
}
