/**
 * @file Initial terminal dimensions for session.attach
 * @description Persists the last-known fit dimensions per device. On attach,
 *   the client sends these so the server spawns the PTY at roughly the right
 *   size — otherwise the server defaults to 120x40 and the first redraw is
 *   sized for desktop, wrapping into the actual (~40-col) mobile terminal
 *   as visual garbage.
 *
 *   First-ever attach has no stored value; we estimate from the viewport.
 *   After xterm + fitAddon settles, persist the real dims so the next
 *   cold-start attach is correct.
 */

const STORAGE_KEY = 'persalink_term_dims';

// Rough cell metrics at the default 14px monospaced font. Used only as a
// last-resort estimate; the persisted value supersedes these once any
// session has been opened on this device.
const CELL_WIDTH_PX = 9;
const CELL_HEIGHT_PX = 18;
// Vertical chrome above the terminal: top bar (~46px) + status indicators +
// safe-area inset. Subtracting it gives a closer first guess.
const VERTICAL_CHROME_PX = 100;

export type TermDims = { cols: number; rows: number };

export function getLastKnownDims(): TermDims | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TermDims>;
    if (typeof parsed.cols !== 'number' || typeof parsed.rows !== 'number') return null;
    if (parsed.cols < 10 || parsed.rows < 2) return null;
    return { cols: parsed.cols, rows: parsed.rows };
  } catch {
    return null;
  }
}

export function saveDims(cols: number, rows: number): void {
  if (typeof window === 'undefined') return;
  if (cols < 10 || rows < 2) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cols, rows }));
  } catch {
    /* private mode or storage full — fall back to estimate next time */
  }
}

export function estimateDimsFromViewport(): TermDims {
  if (typeof window === 'undefined') return { cols: 80, rows: 24 };
  const w = window.innerWidth || 360;
  const rawH = window.visualViewport?.height ?? window.innerHeight ?? 640;
  const usableH = Math.max(200, rawH - VERTICAL_CHROME_PX);
  const cols = Math.max(20, Math.floor(w / CELL_WIDTH_PX));
  const rows = Math.max(10, Math.floor(usableH / CELL_HEIGHT_PX));
  return { cols, rows };
}

/**
 * Best-effort dimensions to send on a fresh attach. Returns localStorage's
 * last-known value when available (most accurate), otherwise estimates from
 * the current viewport. Either is dramatically better than the server's
 * 120x40 fallback for a mobile client.
 */
export function getInitialDims(): TermDims {
  return getLastKnownDims() ?? estimateDimsFromViewport();
}
