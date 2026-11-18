/**
 * @file Kbd
 * @description A key chord drawn as keycaps ("Ctrl+Shift+K" becomes three
 *   caps; Ctrl reads Cmd on macOS). Used only where keys are listed: the
 *   Keyboard shortcuts sheet, and beside palette actions on desktop. Never
 *   on a phone's working surfaces.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Kbd({ keys, className = '' }: { keys: string; className?: string }) {
  const parts = keys.replace(/Ctrl/g, isMac ? 'Cmd' : 'Ctrl').split('+');
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {parts.map((p, i) => <kbd key={i} className="pl-kbd">{p}</kbd>)}
    </span>
  );
}
