/**
 * @file Palette ranking
 * @description The pure rules behind the command palette: how well a query
 *   matches a label, and how results fall into the fixed sections (Needs
 *   you, Sessions, Actions). A match at the start wins, then a match at the
 *   start of a word, then any contiguous match, then (short queries only)
 *   the letters in order, so "stok" finds Stoked before Ops Suite. Sections
 *   never move; ranking happens inside each one. No DOM.
 */

export type PaletteSection = 'Needs you' | 'Sessions' | 'Actions';

export const PALETTE_SECTIONS: readonly PaletteSection[] = ['Needs you', 'Sessions', 'Actions'];

/** Characters that start a new word inside a label or path. */
const WORD_BREAK = /[\s\-_/.:(@·]/;

/** 0 = no match; higher is better. `loose` allows the letters-in-order
 *  match; second lines and aliases pass false so they never add noise. */
export function matchScore(query: string, text: string | undefined | null, loose = true): number {
  const q = query.toLowerCase().trim();
  const t = String(text ?? '').toLowerCase();
  if (!q) return 1;
  if (!t) return 0;
  if (t.startsWith(q)) return 100 - t.length / 100;
  // Earliest word-start match, then any contiguous match.
  const firstAny = t.indexOf(q);
  for (let i = firstAny; i > 0; i = t.indexOf(q, i + 1)) {
    if (WORD_BREAK.test(t.charAt(i - 1))) return 80 - i / 100;
  }
  if (firstAny > 0) return 60 - firstAny / 100;
  // Letters in order: only for short queries, where it helps ("oss" → Ops Suite)
  // without letting long queries match noise.
  if (!loose || q.length > 3) return 0;
  let j = 0;
  for (let k = 0; k < t.length && j < q.length; k++) if (t[k] === q[j]) j++;
  return j === q.length ? 20 : 0;
}

export interface Rankable {
  section: PaletteSection;
  label: string;
  /** Second line; matches count for less. */
  sub?: string;
  /** Extra words that should find this row ("snippet", "files"). */
  alias?: string;
  /** Shown only once something is typed (long lists: snippets, quick actions). */
  searchOnly?: boolean;
}

export interface RankedSection<T extends Rankable> {
  section: PaletteSection;
  items: T[];
  /** Rows held back by the short-query cap ("4 more as you type"). */
  more: number;
}

export interface RankResult<T extends Rankable> {
  sections: RankedSection<T>[];
  /** Flat order the arrow keys walk. */
  flat: T[];
  /** Index in `flat` of the best match (where Enter goes). 0 when empty query. */
  best: number;
}

/**
 * Filter and rank `items` for `query`. Empty query: every row that is not
 * search-only, in the order given. Typed: rows that match, best first inside
 * their section; sections stay in the fixed order. While the query is under
 * three letters, Sessions and Actions show at most `cap` rows each (Needs
 * you is never capped: those are the people waiting).
 */
export function rankPalette<T extends Rankable>(items: readonly T[], query: string, cap = 4): RankResult<T> {
  const q = query.trim();
  const scored: Array<{ x: T; s: number; i: number }> = [];
  items.forEach((x, i) => {
    if (!q) {
      if (!x.searchOnly) scored.push({ x, s: 1, i });
      return;
    }
    const s = Math.max(matchScore(q, x.label), matchScore(q, x.sub, false) * 0.6, matchScore(q, x.alias, false) * 0.9);
    if (s > 0) scored.push({ x, s, i });
  });
  if (q) scored.sort((a, b) => b.s - a.s || a.i - b.i);

  const sections: RankedSection<T>[] = [];
  const flat: T[] = [];
  let best = 0;
  let bestScore = -1;
  for (const section of PALETTE_SECTIONS) {
    const all = scored.filter((r) => r.x.section === section);
    if (all.length === 0) continue;
    const limit = q && q.length < 3 && section !== 'Needs you' ? cap : Infinity;
    const shown = all.slice(0, limit);
    for (const r of shown) {
      if (q && r.s > bestScore) { bestScore = r.s; best = flat.length; }
      flat.push(r.x);
    }
    sections.push({ section, items: shown.map((r) => r.x), more: all.length - shown.length });
  }
  return { sections, flat, best: q ? best : 0 };
}
