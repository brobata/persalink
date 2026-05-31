/**
 * @file attention.ts
 * @description Heuristic classifier that turns a tmux pane's visible content
 *   into a coarse attention state: working / idle / waiting / error. Drives the
 *   session-list badges and the agent notifications. Tuned for the Claude Code
 *   TUI (the dominant workload) with generic shell fallbacks; intentionally
 *   conservative on `error` to avoid false-positive notifications.
 */

export type Attention = 'working' | 'idle' | 'waiting' | 'error';

/**
 * Classify the visible pane text. `idleSeconds` is tmux's time-since-last-
 * activity, used to disambiguate a still-streaming pane from a settled prompt.
 */
export function classifyPane(raw: string, idleSeconds: number): Attention {
  const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
  const text = lines.slice(-30).join('\n');
  const lower = text.toLowerCase();

  // WAITING — blocked on the user's choice. Checked first: a paused Claude that
  // needs approval isn't "working". Matches Claude's permission dialog
  // (numbered Yes/No options, "Do you want to proceed/allow…") and common shell
  // confirmation prompts.
  if (
    /\bdo you want to (proceed|continue|create|run|make|allow|trust|overwrite)\b/i.test(text) ||
    (/❯\s*1\.\s/.test(text) && /\b(yes|no|allow|proceed)\b/i.test(lower)) ||
    (/\b1\.\s*yes\b/i.test(lower) && /(\b2\.\s*no|don'?t)\b/i.test(lower)) ||
    /\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\)/i.test(lower) ||
    /press (enter|any key) to (continue|proceed)/i.test(lower)
  ) {
    return 'waiting';
  }

  // WORKING — Claude prints "esc to interrupt" only while generating; braille
  // spinners and a pane that's actively streaming (very recent activity, not
  // sitting at a prompt) also count.
  if (
    /esc to interrupt/i.test(lower) ||
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/.test(text) ||
    (idleSeconds < 2 && !/[$%#❯]\s*$/.test(text))
  ) {
    return 'working';
  }

  // ERROR — conservative: a clear failure marker anchored at the start of a
  // line near the bottom, while otherwise settled. Avoids matching inline
  // mentions of "error" in normal prose/output.
  if (
    /(^|\n)\s*(error:|fatal:|traceback \(most recent call last\)|.+: command not found|panic:|unhandled (exception|rejection)|segmentation fault)/i.test(text) &&
    !/\b0 errors?\b/i.test(lower)
  ) {
    return 'error';
  }

  return 'idle';
}
