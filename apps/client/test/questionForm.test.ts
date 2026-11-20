/**
 * @file Question form tests
 * @description Claude Code's multiple-choice question form (AskUserQuestion)
 *   reads as a tappable prompt: every option, its description, the rule
 *   before "Chat about this", and "Type something." as a words-reply. The
 *   server's attention classifier calls the form "waiting". Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudePrompt, chipLabel, isRedirectOption } from '../src/lib/claudePrompt.ts';
import { classifyPane } from '../../server/src/attention.ts';

const FORM = [
  '● User answered Claude\'s questions:',
  '  ⎿  · Referrals? → One free month each (Recommended)',
  '──────────────────────────────────────────────────────────────────────────────────',
  '←  ☐ Booking  ☐ CO invite  ☐ Fulfil  ☐ Presets  ✔ Submit  →',
  '',
  'How do people book a CaterOps walkthrough call?',
  '',
  '❯ 1. Google Calendar booking page (Recommended)',
  '     A booking page on your Google Calendar (free), linked from cater-ops.com',
  "     'Book a walkthrough'. Short form first.",
  '  2. Request form, you call back',
  '     They fill a form; you get an email and reach out.',
  '  3. Both',
  '     Book a time, or leave details for a call back.',
  '  4. Type something.',
  '──────────────────────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

test('question form: all five options, descriptions joined, question found', () => {
  const p = parseClaudePrompt(FORM);
  assert.ok(p);
  assert.equal(p.question, 'How do people book a CaterOps walkthrough call?');
  assert.deepEqual(p.options.map((o) => o.key), ['1', '2', '3', '4', '5']);
  assert.equal(p.options[0].label, 'Google Calendar booking page (Recommended)');
  assert.equal(p.options[0].detail,
    "A booking page on your Google Calendar (free), linked from cater-ops.com 'Book a walkthrough'. Short form first.");
  assert.equal(p.options[2].detail, 'Book a time, or leave details for a call back.');
  assert.equal(p.options[3].detail, undefined);
  assert.equal(p.options[4].label, 'Chat about this');
});

test('"Type something." asks for words, chip says so', () => {
  const p = parseClaudePrompt(FORM)!;
  assert.equal(isRedirectOption(p.options[3]), true);
  assert.equal(chipLabel(p.options[3]), 'Your words');
  assert.equal(isRedirectOption(p.options[4]), false);
});

test('an unindented line between options still breaks the block', () => {
  const broken = ['Pick one', '1. A', 'not a description', '2. B', '3. C'];
  // The run is cut at the stray line and "2. B" can't start one, so nothing parses.
  assert.equal(parseClaudePrompt(broken), null);
});

test('a wrapped numbered list in a reply is never a prompt', () => {
  const reply = [
    '● Two ways to fix the flaky upload test:',
    '',
    '  1. Retry the upload once on a 502 before failing, which hides real outages',
    '     but stops the nightly going red.',
    '  2. Mock the storage call in the unit test and keep the real call in the E2E',
    '     suite only.',
    '',
    '  Do you want to proceed with 2?',
  ];
  assert.equal(parseClaudePrompt(reply), null);
});

test('the form still parses with the caret moved off option 1', () => {
  const moved = FORM.map((l) => l.replace('❯ 1.', '  1.').replace('  3. Both', '❯ 3. Both'));
  assert.equal(parseClaudePrompt(moved)?.options.length, 5);
  const noFooter = FORM.slice(0, -1);
  assert.equal(parseClaudePrompt(noFooter)?.options.length, 5);
});

test('server calls the question form waiting', () => {
  assert.equal(classifyPane(FORM.join('\n'), 0), 'waiting');
});
