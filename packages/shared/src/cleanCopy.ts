/**
 * @file Clean copy
 * @description Undo what a TUI's own line-wrapping does to copied text.
 *   Claude Code (and similar TUIs) hard-wrap output to the pane width and
 *   indent every line with a gutter, so a terminal selection comes back with
 *   that gutter in front of every line and long URLs / tokens split across
 *   rows with real newlines. xterm can't rejoin those — they aren't soft
 *   wraps. This strips the shared indent and rejoins rows that were broken in
 *   the middle of a URL or long unbroken token. It deliberately does NOT
 *   unwrap prose paragraphs: guessing wrong there would glue separate lines
 *   (list items, code) together, which is worse than leaving the newlines.
 */

const URL_TOKEN_RX = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;
/** How far short of the pane edge a TUI may stop wrapping (Claude Code keeps
 *  a small right margin). A row this close to the edge counts as wrapped. */
const EDGE_SLACK = 4;

function leadingSpaces(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/** Last whitespace-delimited token of a line. */
function lastToken(line: string): string {
  const m = line.match(/(\S+)$/);
  return m ? m[1] : '';
}

/** Does the row end inside something that was broken mid-token by wrapping?
 *  Only URLs/paths and long unbroken tokens qualify — never ordinary words. */
function endsMidToken(line: string): boolean {
  const token = lastToken(line);
  if (!token) return false;
  if (/^[(<["'`]?https?:\/\//i.test(token) || /^[(<["'`]?www\./i.test(token)) return true;
  return token.length >= 30;
}

/**
 * @param text  Raw selection text (\n or \r\n line endings; output keeps them).
 * @param cols  Terminal width in columns. Only rows that reach the pane edge
 *              (within EDGE_SLACK) can be treated as wrapped.
 */
export function cleanTerminalCopy(text: string, cols: number): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const raw = text.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''));
  if (raw.length <= 1) return raw.join(eol).trim();

  // Shared indent. The first row is excluded when it has none — a drag that
  // starts mid-row doesn't capture the gutter, but every following row does.
  const indentOf = (rows: string[]) => {
    const counts = rows.filter((l) => l.length > 0).map(leadingSpaces);
    return counts.length > 0 ? Math.min(...counts) : 0;
  };
  const firstHasIndent = leadingSpaces(raw[0]) > 0;
  const indent = firstHasIndent ? indentOf(raw) : indentOf(raw.slice(1));
  const lines = raw.map((l, i) => (i === 0 && !firstHasIndent ? l : l.slice(Math.min(indent, leadingSpaces(l)))));

  // A row was wrapped by the TUI (not ended by the author) only if it ran
  // into the pane edge. Anything shorter ended where its author ended it —
  // two long `export` lines or file paths stay two lines.
  const fullAt = cols - EDGE_SLACK;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let rawLen = raw[i].length;
    while (i + 1 < lines.length && rawLen >= fullAt && endsMidToken(line)) {
      const next = lines[i + 1].trimStart();
      // A row that starts a new URL or list item is its own line, even when
      // the row above it reached the pane edge.
      if (/^(https?:\/\/|www\.)/i.test(next) || /^([-*+]|\d+[.)])\s/.test(next)) break;
      if (!URL_TOKEN_RX.test(next)) break;
      line += next;
      rawLen = raw[i + 1].length;
      i++;
    }
    out.push(line);
  }
  return out.join(eol).replace(/^\s*\n/, '').trimEnd();
}
