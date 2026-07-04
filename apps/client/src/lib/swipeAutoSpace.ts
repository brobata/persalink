/**
 * @file Swipe-typing auto-space
 * @description Restores the leading space that Gboard/SwiftKey glide (swipe)
 * typing omits in the terminal. Swipe keyboards decide whether to prepend a
 * space by reading the text before the cursor in the input field — but we
 * deliberately clear xterm's hidden textarea after every keystroke (the
 * textarea-accumulation guard), so the keyboard always sees an empty field
 * and never inserts the space between swiped words.
 *
 * Heuristic: a chunk that (a) arrives right after a compositionend (swipe
 * commits words via IME composition), (b) is a pure Latin word of 2+ chars,
 * and (c) follows a word character or sentence punctuation we already sent,
 * gets a space prepended. Normal keystrokes, pastes, escape sequences, CJK
 * composition, Enter, and backspace all fall outside the gate.
 */

/** Composed word must arrive within this window of its compositionend. */
const COMPOSITION_WINDOW_MS = 400;

/** A swiped word: Latin letters/apostrophes only, 2+ chars (single letters
 * like "a"/"I" are tapped, not swiped). Intentionally excludes CJK — those
 * IMEs compose too, and must never get spaces injected. */
const SWIPED_WORD = /^[\p{Script=Latin}'’]{2,}$/u;

/** Last-sent characters after which a swipe keyboard would auto-space. */
const WANTS_SPACE_AFTER = /[\p{Script=Latin}\p{Nd}.,!?;)"'’”]$/u;

export interface SwipeAutoSpacer {
  /** Call from the textarea's compositionend listener. */
  noteCompositionEnd(): void;
  /** Run every outgoing chunk through this; returns the chunk to send. */
  process(chunk: string): string;
  /** Call when composition/delta state is reset (focus/blur). */
  reset(): void;
}

export function createSwipeAutoSpacer(): SwipeAutoSpacer {
  let lastSentChar = '';
  let composedAt = -Infinity;
  return {
    noteCompositionEnd() {
      composedAt = performance.now();
    },
    process(chunk: string): string {
      if (
        performance.now() - composedAt < COMPOSITION_WINDOW_MS &&
        SWIPED_WORD.test(chunk) &&
        WANTS_SPACE_AFTER.test(lastSentChar)
      ) {
        chunk = ' ' + chunk;
      }
      if (chunk) lastSentChar = chunk.charAt(chunk.length - 1);
      return chunk;
    },
    reset() {
      lastSentChar = '';
      composedAt = -Infinity;
    },
  };
}
