/**
 * @file Claude prompt options
 * @description Reads a Claude Code numbered prompt ("Do you want to
 *   proceed?" then "1. Yes / 2. Yes, and don't ask again ... / 3. No, and
 *   tell Claude what to do differently") from the bottom of a terminal's
 *   text, and gives each option its one chip label. Labels are the agent's
 *   own words, never cut short; the two long standard ones have a fixed
 *   name everywhere: "Always" and "No, explain" (never a bare "No", because
 *   that option opens a reply). Pure functions, no DOM.
 */

export interface PromptOption {
  /** The key that picks the option in Claude Code ("1", "2", ...). */
  key: string;
  /** The option exactly as the agent wrote it, minus a trailing "(esc)". */
  label: string;
}

export interface ClaudePrompt {
  question: string;
  options: PromptOption[];
}

const OPTION_RX = /^(?:[❯›>]\s*)?(\d{1,2})[.)]\s+(.+?)$/;

/** Box-drawing frames and the selection caret, gone. */
function clean(line: string): string {
  return line.replace(/^[\s│┃|]+/, '').replace(/[\s│┃|]+$/, '').trim();
}

/**
 * The prompt at the bottom of `lines` (oldest first), or null. Only a run of
 * options numbered 1, 2, 3 ... in order counts, and only near the bottom
 * (Claude draws its prompt last), so numbered lists earlier in a reply are
 * never mistaken for a question.
 */
export function parseClaudePrompt(lines: readonly string[], lookback = 16): ClaudePrompt | null {
  const start = Math.max(0, lines.length - lookback);
  let end = -1;
  for (let i = lines.length - 1; i >= start; i--) {
    if (OPTION_RX.test(clean(lines[i]))) { end = i; break; }
  }
  if (end < 0) return null;

  let first = end;
  while (first - 1 >= start && OPTION_RX.test(clean(lines[first - 1]))) first--;

  const options: PromptOption[] = [];
  for (let i = first; i <= end; i++) {
    const m = OPTION_RX.exec(clean(lines[i]));
    if (!m) return null;
    if (Number(m[1]) !== options.length + 1) return null;
    options.push({ key: m[1], label: m[2].replace(/\s*\(esc\)\s*$/i, '').trim() });
  }
  if (options.length < 2) return null;

  let question = '';
  for (let i = first - 1; i >= Math.max(0, first - 6); i--) {
    const t = clean(lines[i]);
    if (t) { question = t; break; }
  }
  return { question, options };
}

export function isAlwaysOption(o: PromptOption): boolean {
  return /^Yes, and don.t ask again/i.test(o.label);
}

/** The option that declines and asks for words instead of a key. */
export function isRedirectOption(o: PromptOption): boolean {
  return /^No, and tell Claude/i.test(o.label);
}

/** The one label an answer chip shows for an option, at every width. */
export function chipLabel(o: PromptOption): string {
  if (isAlwaysOption(o)) return 'Always';
  if (isRedirectOption(o)) return 'No, explain';
  return o.label;
}

/** The part of an xterm Terminal the prompt reader needs (no DOM). */
export interface BufferLike {
  buffer: {
    active: {
      length: number;
      baseY: number;
      cursorY: number;
      getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/**
 * The numbered prompt on a terminal's screen right now, or null. Reads the
 * rows up to the cursor's row plus a few below it (Claude draws hints under
 * the options), so old scrollback never counts.
 */
export function promptOnScreen(term: BufferLike, lookback = 16): ClaudePrompt | null {
  const b = term.buffer.active;
  const end = Math.min(b.length, b.baseY + b.cursorY + 4);
  const lines: string[] = [];
  for (let i = Math.max(0, end - lookback - 4); i < end; i++) {
    lines.push(b.getLine(i)?.translateToString(true) ?? '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return parseClaudePrompt(lines, lookback);
}
