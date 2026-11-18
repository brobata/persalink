/**
 * @file Profile monograms
 * @description Profiles are drawn as monogram tiles, never emoji: one or two
 *   letters from the name ("Ops Suite" -> "OS", "olive" -> "OL",
 *   "brobata-ops" -> "BO") on a 14% tint of the profile colour. An old emoji
 *   icon stays in the profile data untouched; it is simply not drawn.
 */

/** One or two uppercase letters for a name. */
export function monogram(name: string | null | undefined): string {
  const words = (name ?? '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
  return ([...words[0]][0] + [...words[1]][0]).toUpperCase();
}

const HEX_RX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A profile colour that is safe to put in a style, or the neutral tile. */
export function tileColor(color: string | null | undefined): string | null {
  return color && HEX_RX.test(color) ? color : null;
}
