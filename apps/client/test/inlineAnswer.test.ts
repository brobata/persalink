/**
 * @file Inline answer tests
 * @description The pure rules behind answering from Home (lib/inlineAnswer):
 *   only PersaLink session names and digit keys ever reach a command, the
 *   session is matched exactly, the prompt is read from captured pane text,
 *   and a key is typed only while the same question is still on screen.
 *   Also the answered book (lib/answered): an agent answered from Home
 *   reads as moving on until the server's own snapshot of it changes.
 *   Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCommand, confirmOption, isAnswerableSession, peekKey, promptFromCapture, samePrompt, sendKeyCommand,
} from '../src/lib/inlineAnswer.ts';
import { createAnsweredBook, ANSWERED_WORKING_MS } from '../src/lib/answered.ts';
import type { SessionInfo } from '@persalink/shared/protocol';

const SCREEN = [
  '● Bash(npm run migrate -- --prod)',
  '',
  '╭──────────────────────────────────────────╮',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  "│   2. Yes, and don't ask again for npm    │",
  '│   3. No, and tell Claude what to do differently (esc) │',
  '╰──────────────────────────────────────────╯',
  '',
  '',
].join('\n');

test('commands: only pl- session names, matched exactly', () => {
  assert.equal(captureCommand('pl-ops-suite-2'), "tmux capture-pane -p -J -t '=pl-ops-suite-2:' -S -40");
  assert.equal(sendKeyCommand('pl-ops', '2'), "tmux send-keys -t '=pl-ops:' -l '2'");
  for (const bad of ['ops', "pl-x'; rm -rf ~", 'pl-a b', 'pl-$(id)', 'pl-', '']) {
    assert.equal(isAnswerableSession(bad), false, bad);
    assert.equal(captureCommand(bad), null, bad);
    assert.equal(sendKeyCommand(bad, '1'), null, bad);
  }
});

test('commands: only a digit or two is ever typed', () => {
  for (const bad of ['', 'y', '1\n', '123', '\x1b', "1'"]) {
    assert.equal(sendKeyCommand('pl-ops', bad), null, JSON.stringify(bad));
  }
});

test('capture: reads the prompt at the bottom, frames and trailing blanks ignored', () => {
  const p = promptFromCapture(SCREEN);
  assert.ok(p);
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => o.key), ['1', '2', '3']);
  assert.equal(p.options[2].label, 'No, and tell Claude what to do differently');
  assert.equal(promptFromCapture('$ ls\nREADME.md\n$ '), null);
});

test('confirm: types only while the same question is on screen', () => {
  const asked = promptFromCapture(SCREEN)!;
  const yes = asked.options[0];
  assert.equal(confirmOption(asked, promptFromCapture(SCREEN), yes)?.key, '1');
  // Claude moved on: nothing to confirm.
  assert.equal(confirmOption(asked, null, yes), null);
  // A different question with the same keys must not get the old answer.
  const other = promptFromCapture(SCREEN.replace('Do you want to proceed?', 'Delete the prod table?'));
  assert.equal(samePrompt(asked, other), false);
  assert.equal(confirmOption(asked, other, yes), null);
});

test('peek key: moves with the preview and the activity', () => {
  const a = peekKey({ id: 'pl-a', preview: 'x', activityAt: 1 });
  assert.notEqual(a, peekKey({ id: 'pl-a', preview: 'y', activityAt: 1 }));
  assert.notEqual(a, peekKey({ id: 'pl-a', preview: 'x', activityAt: 2 }));
  assert.equal(a, peekKey({ id: 'pl-a', preview: 'x', activityAt: 1 }));
});

function sess(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, name: id, windows: [], createdAt: 0, attached: false, attention: 'waiting', activityAt: 100, preview: '3. No, and tell Claude', ...over };
}

test('answered: patched until the server snapshot changes, then the server wins', () => {
  const book = createAnsweredBook();
  const a = sess('pl-a');
  const b = sess('pl-b');
  book.mark(a, 'Yes', 1_000_000);
  let out = book.apply([a, b], 1_000_500);
  assert.equal(out[0].attention, 'working');
  assert.equal(out[0].preview, 'Answered: Yes');
  assert.equal(out[1], b, 'other sessions untouched');
  // Re-applying an already patched list keeps the patch (the store re-applies after a mark).
  assert.equal(book.apply(out, 1_000_600)[0].attention, 'working');
  // Same stale snapshot after a minute: idle, not waiting.
  out = book.apply([sess('pl-a')], 1_000_000 + ANSWERED_WORKING_MS + 1);
  assert.equal(out[0].attention, 'idle');
  // The server saw something new: its word stands, and the entry is gone.
  const fresh = sess('pl-a', { activityAt: 200, preview: 'Do you want to run git push?' });
  assert.equal(book.apply([fresh])[0], fresh);
  assert.equal(book.apply([sess('pl-a')])[0].attention, 'waiting', 'forgotten after the server caught up');
});

test('answered: a session that is gone is forgotten', () => {
  const book = createAnsweredBook();
  book.mark(sess('pl-a'), 'Yes');
  book.apply([]);
  assert.equal(book.apply([sess('pl-a')])[0].attention, 'waiting');
});
