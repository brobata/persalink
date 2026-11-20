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
  /** The line(s) Claude prints under the option (AskUserQuestion descriptions). */
  detail?: string;
}

export interface ClaudePrompt {
  question: string;
  options: PromptOption[];
}

const OPTION_RX = /^(?:[❯›>]\s*)?(\d{1,2})[.)]\s+(.+?)$/;
/** An option drawn with Claude's selection caret. */
const CARET_RX = /^[❯›]\s*\d{1,2}[.)]\s/;
/** The question form's footer. */
const FOOTER_RX = /enter to select\b.*\besc to cancel/i;
/** The most rows an option block (options + descriptions) may span. */
const MAX_BLOCK = 30;
/** The rule Claude draws between a question's options and "Chat about this". */
const RULE_RX = /^[─━]{8,}$/;

/** Box-drawing frames and the selection caret, gone. */
function clean(line: string): string {
  return line.replace(/^[\s│┃|]+/, '').replace(/[\s│┃|]+$/, '').trim();
}

/** The line with a leading box frame removed, spaces kept (for columns). */
function unframed(line: string): string {
  return line.replace(/^[│┃|]/, '').replace(/\s+$/, '');
}

function indentOf(line: string): number {
  const s = unframed(line);
  return s.length - s.trimStart().length;
}

/**
 * The prompt at the bottom of `lines` (oldest first), or null. Only options
 * numbered 1, 2, 3 ... in order count, and only near the bottom (Claude draws
 * its prompt last), so numbered lists earlier in a reply are never mistaken
 * for a question. Between options it accepts what Claude's question form
 * draws: a description indented under its option's label, and the rule
 * before "Chat about this". Anything else ends the block.
 */
export function parseClaudePrompt(lines: readonly string[], lookback = 16): ClaudePrompt | null {
  const start = Math.max(0, lines.length - lookback);
  let end = -1;
  for (let i = lines.length - 1; i >= start; i--) {
    if (OPTION_RX.test(clean(lines[i]))) { end = i; break; }
  }
  if (end < 0) return null;

  // The last option must sit near the bottom; the block itself may run
  // further up (descriptions make a question form tall). Descriptions and
  // rules are only accepted when the block is plainly one of Claude's
  // dialogs: the selection caret on an option, or the form's footer just
  // below. A numbered list in a reply hang-indents its wrapped lines the
  // same way, and must never become answer chips.
  const floor = Math.max(0, end - MAX_BLOCK);
  const anchored =
    lines.slice(end + 1, end + 5).some((l) => FOOTER_RX.test(l)) ||
    lines.slice(floor, end + 1).some((l) => CARET_RX.test(clean(l)));
  let first = end;
  for (let i = end - 1; i >= floor; i--) {
    const t = clean(lines[i]);
    if (OPTION_RX.test(t)) first = i;
    else if (anchored && (RULE_RX.test(t) || (t && indentOf(lines[i]) >= 3))) continue;
    else break;
  }

  const options: PromptOption[] = [];
  let labelCol = 0;
  for (let i = first; i <= end; i++) {
    const t = clean(lines[i]);
    const m = OPTION_RX.exec(t);
    if (m) {
      if (Number(m[1]) !== options.length + 1) return null;
      options.push({ key: m[1], label: m[2].replace(/\s*\(esc\)\s*$/i, '').trim() });
      labelCol = unframed(lines[i]).indexOf(m[2]);
      continue;
    }
    if (!anchored) return null;
    if (RULE_RX.test(t)) continue;
    if (!t || indentOf(lines[i]) < labelCol) return null;
    const last = options[options.length - 1];
    last.detail = last.detail ? `${last.detail} ${t}` : t;
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

/**
 * The option that asks for words instead of a key: the permission prompt's
 * "No, and tell Claude..." and the question form's "Type something.".
 */
export function isRedirectOption(o: PromptOption): boolean {
  return /^No, and tell Claude/i.test(o.label) || /^Type something\.?$/i.test(o.label);
}

/** The one label an answer chip shows for an option, at every width. */
export function chipLabel(o: PromptOption): string {
  if (isAlwaysOption(o)) return 'Always';
  if (/^Type something\.?$/i.test(o.label)) return 'Your words';
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
  for (let i = Math.max(0, end - lookback - MAX_BLOCK - 6); i < end; i++) {
    lines.push(b.getLine(i)?.translateToString(true) ?? '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return parseClaudePrompt(lines, lookback);
}
