/**
 * @file Inline answers (pure rules)
 * @description How Home answers a waiting agent without opening it. The
 *   server already runs short commands for the client (`exec.run`, used by
 *   snippets), so Home reads a waiting session's screen with
 *   `tmux capture-pane` and types the chosen digit with `tmux send-keys`:
 *   no attach, so no resize and no redraw of anyone else's view, and no
 *   protocol change. These are the pure parts: the two commands (session
 *   names are checked and matched exactly, so `pl-app` never reaches
 *   `pl-app-2`), reading the prompt from the captured text, and the check
 *   that the prompt on screen is still the one that was answered. No DOM,
 *   no store; lib/useInlineAnswer.ts does the sending.
 */

import { parseClaudePrompt, type ClaudePrompt, type PromptOption } from './claudePrompt.ts';

/** PersaLink session names: what tmuxManager creates (pl-<profile>[-n] or pl-<time>). */
const SESSION_NAME = /^pl-[A-Za-z0-9._-]{1,120}$/;
/** A Claude Code option key: a digit or two, nothing else is ever typed. */
const OPTION_KEY = /^\d{1,2}$/;

export function isAnswerableSession(id: string): boolean {
  return SESSION_NAME.test(id);
}

/** `=name:` targets the session by exact name (tmux otherwise prefix-matches). */
function target(id: string): string {
  return `'=${id}:'`;
}

/** Read the bottom of a session's active pane: wrapped lines joined, 40 lines of history. */
export function captureCommand(id: string): string | null {
  if (!isAnswerableSession(id)) return null;
  return `tmux capture-pane -p -J -t ${target(id)} -S -40`;
}

/** Type one option key into the session, literally (no Enter: Claude Code picks on the digit). */
export function sendKeyCommand(id: string, key: string): string | null {
  if (!isAnswerableSession(id) || !OPTION_KEY.test(key)) return null;
  return `tmux send-keys -t ${target(id)} -l '${key}'`;
}

/** A path as the shell should read it: anything outside the plain set (a
 *  space, a quote, a parenthesis) is backslash-escaped. `~` stays bare so
 *  it still expands. */
export function shellPath(p: string): string {
  return p.replace(/[^A-Za-z0-9._~/+@:=,%-]/g, (c) => `\\${c}`);
}

/**
 * Type a line of text into the session literally, no Enter (the Files
 * panel's "Send a file to ..." pastes uploaded paths this way when the
 * session is not on screen). Control characters are refused so nothing can
 * press Enter or Esc on the person's behalf; quotes are escaped for sh.
 */
export function typeTextCommand(id: string, text: string): string | null {
  if (!isAnswerableSession(id) || !text || text.length > 4000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) return null;
  return `tmux send-keys -t ${target(id)} -l '${text.replace(/'/g, `'\\''`)}'`;
}

/** The numbered prompt at the bottom of captured pane text, or null. */
export function promptFromCapture(text: string): ClaudePrompt | null {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const p = parseClaudePrompt(lines);
  // A multi-select needs several toggles and then Next: open the session.
  return p?.multi ? null : p;
}

/** Same question, same options in the same order: safe to type the key. */
export function samePrompt(a: ClaudePrompt | null, b: ClaudePrompt | null): boolean {
  if (!a || !b) return false;
  return a.question === b.question
    && a.options.length === b.options.length
    && a.options.every((o, i) => o.key === b.options[i].key && o.label === b.options[i].label);
}

/** The option to type now: the one answered, only if the screen still asks the same thing. */
export function confirmOption(answered: ClaudePrompt, onScreen: ClaudePrompt | null, option: PromptOption): PromptOption | null {
  if (!samePrompt(answered, onScreen)) return null;
  return onScreen!.options.find((o) => o.key === option.key && o.label === option.label) ?? null;
}

/** The cache key for a peek: a session's prompt is re-read when its preview or activity moves. */
export function peekKey(s: { id: string; preview?: string; activityAt?: number }): string {
  return `${s.id}\u0000${s.preview ?? ''}\u0000${s.activityAt ?? 0}`;
}
