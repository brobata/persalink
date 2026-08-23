/**
 * @file useLongPress
 * @description Pointer-based long-press detector shared by profile rows/cards.
 * Returns handlers to spread on a button: a hold of `delay` ms fires `onLongPress`
 * (with a light haptic where supported) and swallows the following click; a
 * short tap falls through to `onClick`. Movement beyond `moveTolerance` px
 * cancels (scrolling must never trigger it).
 */
import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';

interface Options {
  delay?: number;
  moveTolerance?: number;
}

export function useLongPress(
  onLongPress: () => void,
  onClick: (e: ReactMouseEvent) => void,
  { delay = 450, moveTolerance = 10 }: Options = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    origin.current = null;
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    fired.current = false;
    origin.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      fired.current = true;
      try { navigator.vibrate?.(30); } catch { /* unsupported */ }
      onLongPress();
    }, delay);
  }, [onLongPress, delay]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!origin.current) return;
    const dx = e.clientX - origin.current.x;
    const dy = e.clientY - origin.current.y;
    if (dx * dx + dy * dy > moveTolerance * moveTolerance) clear();
  }, [clear, moveTolerance]);

  const handleClick = useCallback((e: ReactMouseEvent) => {
    if (fired.current) {
      // The hold already acted — don't also run the tap action.
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClick(e);
  }, [onClick]);

  // Long-press on mobile browsers also opens the native context menu
  // (text-select / link sheet); suppress it so the hold is ours alone.
  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu,
    onClick: handleClick,
  };
}
