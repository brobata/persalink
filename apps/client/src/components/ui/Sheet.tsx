/**
 * @file Sheet
 * @description The one sheet. On a phone it rises from the bottom edge in
 *   240ms with a drag handle; drag the handle or header down, tap the dim,
 *   press Esc or the close button to dismiss (it leaves in 180ms). On
 *   desktop the same component is a centred dialog. One gutter, one header,
 *   a scroll body that returns to the top when `contentKey` changes. Children
 *   can close it with the same exit motion through useSheetClose().
 *   Mount it while it should show and pass onClose; the exit motion runs
 *   before onClose is called.
 */

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

const EXIT_MS = 180;
const DISMISS_PX = 80;

const SheetCloseContext = createContext<() => void>(() => {});

/** Close the sheet this component sits in, with the exit motion. */
export function useSheetClose(): () => void {
  return useContext(SheetCloseContext);
}

export interface SheetProps {
  onClose: () => void;
  title?: ReactNode;
  /** One meta line under the title. */
  sub?: ReactNode;
  /** Controls placed in the header, before the close button. */
  headExtra?: ReactNode;
  /** Spoken name when the title is not plain text. */
  label?: string;
  /** Fixed 78dvh height (lists that change length while open). */
  tall?: boolean;
  /** Content identity: when it changes, the body scrolls back to the top. */
  contentKey?: string | number;
  /** Draw no header row (the content brings its own). */
  bare?: boolean;
  /** Padding inside the scroll body; defaults to the one sheet gutter. */
  bodyClassName?: string;
  /** Pinned below the scroll body (a composer, a primary action). */
  footer?: ReactNode;
  children?: ReactNode;
}

export function Sheet({
  onClose, title, sub, headExtra, label, tall, contentKey, bare, bodyClassName, footer, children,
}: SheetProps) {
  const [closing, setClosing] = useState(false);
  const sheetRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const el = sheetRef.current;
    if (el && el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur?.();
    window.setTimeout(() => onCloseRef.current(), EXIT_MS);
  }, []);

  // Esc closes; Tab stays inside the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab' || !sheetRef.current) return;
      const f = sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  // Take focus unless the content focused something itself (a composer).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = sheetRef.current;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Scroll reset when the content is swapped for another.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [contentKey]);

  // Drag down from the handle or header to dismiss.
  const drag = useRef<{ y0: number; dy: number; id: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.pl-grab, .pl-sheet-h') || t.closest('button, input, a, select')) return;
    drag.current = { y0: e.clientY, dy: 0, id: e.pointerId };
    sheetRef.current?.classList.add('dragging');
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id || !sheetRef.current) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sheetRef.current.style.transform = `translateY(${d.dy}px)`;
    }
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    const el = sheetRef.current;
    if (!d || !el) return;
    el.classList.remove('dragging');
    if (d.dy > DISMISS_PX) {
      el.style.transform = '';
      close();
    } else {
      el.style.transition = 'transform var(--d-move) var(--ease-out)';
      el.style.transform = '';
      window.setTimeout(() => { if (el) el.style.transition = ''; }, 220);
    }
  };

  const titleText = typeof title === 'string' ? title : undefined;

  return createPortal(
    <SheetCloseContext.Provider value={close}>
      <div className={`pl-scrim${closing ? ' closing' : ''}`} onClick={close} aria-hidden />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? titleText}
        tabIndex={-1}
        className={`pl-sheet${tall ? ' tall' : ''}${closing ? ' closing' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pl-grab" aria-hidden><span /></div>
        {!bare && (
          <div className="pl-sheet-h">
            <div className="flex-1 min-w-0">
              {title != null && <div className="text-title font-semibold text-fg-1 truncate">{title}</div>}
              {sub != null && <div className="text-meta text-fg-3 truncate">{sub}</div>}
            </div>
            {headExtra}
            <IconButton label="Close" onClick={close}>
              <X className="w-[18px] h-[18px]" strokeWidth={1.75} />
            </IconButton>
          </div>
        )}
        <div ref={bodyRef} className={`pl-sheet-b ${bodyClassName ?? ''}`}>
          <div key={contentKey} className="motion-safe:animate-fade">{children}</div>
        </div>
        {footer}
      </section>
    </SheetCloseContext.Provider>,
    document.body,
  );
}
