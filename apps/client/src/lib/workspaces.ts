/**
 * @file Desktop workspaces and pane layouts
 * @description Pure rules behind the desktop pane grid (stores/layoutStore):
 *   how many panes a layout shows, how panes are kept aside (stashed) when a
 *   layout shrinks so growing it again brings them back, and what a
 *   workspace tab is called when nobody named it. No DOM, no store: testable under node --test.
 */

export type Layout = 'single' | 'split-h' | 'split-v' | '2x2';

export interface PaneSlot {
  id: string;
  sessionId: string | null;
  /** Which server the session lives on. null = legacy assignment from before
   *  multi-server; consumers treat it as "the active server". */
  serverId: string | null;
}

/** One named arrangement of panes (a title-bar tab). */
export interface Workspace {
  id: string;
  /** A name the user typed; null = named after what it shows. */
  name: string | null;
  layout: Layout;
  panes: PaneSlot[];
  focusedPaneId: string;
  /** Panes a smaller layout put aside, restored when it grows again. */
  stash: PaneSlot[];
}

export function paneCountFor(layout: Layout): number {
  if (layout === 'single') return 1;
  if (layout === '2x2') return 4;
  return 2;
}

/**
 * Panes for `layout`: the visible ones first (current panes, then stashed
 * ones), new empty panes when there are not enough, and the assigned panes
 * that do not fit go to the stash. Empty panes that do not fit are dropped.
 */
export function reshape(layout: Layout, panes: readonly PaneSlot[], stash: readonly PaneSlot[] = []): { panes: PaneSlot[]; stash: PaneSlot[] } {
  const count = paneCountFor(layout);
  const pool = [...panes, ...stash];
  const shown = pool.slice(0, count);
  const used = new Set(shown.map((p) => p.id));
  for (let i = 0; shown.length < count; i++) {
    const id = `pane-${i}`;
    if (used.has(id)) continue;
    used.add(id);
    shown.push({ id, sessionId: null, serverId: null });
  }
  const kept = pool.slice(count).filter((p) => p.sessionId && !used.has(p.id));
  return { panes: shown, stash: kept };
}

/** Clear panes holding a session the matcher calls dead. Returns the same
 *  array when nothing changed (so a store update can be skipped). */
export function clearWhere(panes: PaneSlot[], dead: (p: PaneSlot) => boolean): PaneSlot[] {
  if (!panes.some(dead)) return panes;
  return panes.map((p) => (dead(p) ? { ...p, sessionId: null } : p));
}

/** Drop stashed panes the matcher calls dead (a stash holds only assigned panes). */
export function dropWhere(stash: PaneSlot[], dead: (p: PaneSlot) => boolean): PaneSlot[] {
  return stash.some(dead) ? stash.filter((p) => !dead(p)) : stash;
}

/**
 * The tab label: the typed name, else the names of what its panes show
 * ("Ops Suite · Olive"), else "Empty".
 */
export function workspaceLabel(ws: Pick<Workspace, 'name' | 'panes' | 'layout'>, titleOf: (sessionId: string) => string | null): string {
  if (ws.name && ws.name.trim()) return ws.name.trim();
  const names = ws.panes.slice(0, paneCountFor(ws.layout))
    .map((p) => (p.sessionId ? titleOf(p.sessionId) ?? p.sessionId : null))
    .filter((n): n is string => !!n);
  if (names.length === 0) return 'Empty';
  return names.length > 2 ? `${names[0]} · ${names[1]} +${names.length - 2}` : names.join(' · ');
}

/** A fresh workspace id that is not in `taken`. */
export function newWorkspaceId(taken: readonly string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`ws-${n}`)) n++;
  return `ws-${n}`;
}

/** Remove duplicate (server, session) pairs across panes: keep the first. */
export function dedupePanes(panes: PaneSlot[]): PaneSlot[] {
  const seen = new Set<string>();
  return panes.map((p) => {
    const slot = { ...p, serverId: p.serverId ?? null };
    if (!slot.sessionId) return slot;
    const key = `${slot.serverId ?? ''}:${slot.sessionId}`;
    if (seen.has(key)) return { ...slot, sessionId: null };
    seen.add(key);
    return slot;
  });
}
