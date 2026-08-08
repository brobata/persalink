/**
 * @file Link extraction
 * @description Pull URLs out of raw terminal text. Feeds the session.links
 *   flow: the server captures the attached pane with `capture-pane -J`
 *   (rejoining lines tmux hard-wrapped at the pane width) and extracts the
 *   URLs here — the ones xterm.js can never detect because it only sees the
 *   split halves.
 */

// Whitespace ends a URL; quotes/backticks/angle-brackets are common wrappers
// ("...", `...`, <...>) and never legal URL characters in terminal output.
const URL_RX = /https?:\/\/[^\s"'`<>\\^{}|]+/g;

/** Strip prose punctuation trailing a URL ("see https://x.com." or a
 *  markdown-style "(https://x.com)") without eating legitimate URL chars —
 *  a trailing closer is only dropped when it has no matching opener inside
 *  the URL, so /wiki/Foo_(bar) keeps its paren. */
function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const prev = out;
    out = out.replace(/[.,;:!?]+$/, '');
    const last = out[out.length - 1];
    if (last === ')' || last === ']') {
      const open = last === ')' ? '(' : '[';
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) out = out.slice(0, -1);
    }
    if (out === prev) return out;
  }
}

/**
 * Extract unique URLs from terminal text, most recently seen first.
 * Capped so a log spewing thousands of URLs can't flood the client.
 */
export function extractLinks(text: string, max = 50): string[] {
  const lastIndex = new Map<string, number>();
  let i = 0;
  for (const match of text.matchAll(URL_RX)) {
    const url = trimTrailing(match[0]);
    // Host must look real: a dot (domains, IPs) or localhost. Filters junk
    // like a bare "http://" mid-sentence while keeping http://localhost:9877.
    if (!/^https?:\/\/([^/?#]*\.|localhost)/i.test(url)) continue;
    lastIndex.set(url, i++); // re-set bumps an earlier sighting to newest
  }
  return [...lastIndex.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([url]) => url);
}
