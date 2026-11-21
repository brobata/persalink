/**
 * @file Question form tests
 * @description Claude Code's multiple-choice question form (AskUserQuestion)
 *   reads as a tappable prompt: every option, its description, the rule
 *   before "Chat about this", and "Type something." as a words-reply. The
 *   server's attention classifier calls the form "waiting". Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudePrompt, chipLabel, isRedirectOption, answerOptions, displayOptions, isTick, NEXT_KEY } from '../src/lib/claudePrompt.ts';
import { promptFromCapture } from '../src/lib/inlineAnswer.ts';
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
  assert.equal(p.options[0].label, 'Google Calendar booking page');
  assert.equal(p.options[0].recommended, true);
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

// Captured from a live Claude Code 2.1 form after "1" answered Color and
// "1" + "3" ticked Apple and Mango.
const MULTI = [
  '──────────────────────────────────────────────────────────────────────────────────',
  '←  ☒ Color  ☐ Fruit  ✔ Submit  →',
  '',
  'Which fruits do you like? Pick any number.',
  '',
  '❯ 1. [✔] Apple',
  '         Crisp and sweet-tart.',
  '  2. [ ] Banana',
  '         Soft and sweet.',
  '  3. [✔] Mango',
  '         Juicy and tropical.',
  '  4. [ ] Type something',
  '     Submit',
  '──────────────────────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

test('multi-select: boxes become ticks, Submit row skipped, steps read', () => {
  const p = parseClaudePrompt(MULTI)!;
  assert.equal(p.multi, true);
  assert.equal(p.question, 'Which fruits do you like? Pick any number.');
  assert.deepEqual(p.options.map((o) => [o.label, !!o.checked]),
    [['Apple', true], ['Banana', false], ['Mango', true], ['Type something', false], ['Chat about this', false]]);
  assert.equal(p.options[3].detail, undefined);
  assert.deepEqual(p.steps, [{ label: 'Color', done: true }, { label: 'Fruit', done: false }]);
  assert.equal(chipLabel(p.options[0]), '✓ Apple');
  assert.equal(isRedirectOption(p.options[3]), true);
  const chips = answerOptions(p);
  assert.equal(chips[chips.length - 1].key, NEXT_KEY);
  assert.equal(chipLabel(chips[chips.length - 1]), 'Next →');
});

test('single-select forms get no Next chip', () => {
  const p = parseClaudePrompt(FORM)!;
  assert.equal(answerOptions(p).length, 5);
  assert.deepEqual(p.steps?.map((s) => s.label), ['Booking', 'CO invite', 'Fulfil', 'Presets']);
});

test('the review screen is titled and answerable', () => {
  const review = ['Review your answers', '', ' ● Which color do you prefer?', '   → Red', ' ● Which fruits?', '   → Apple, Mango', '', '❯ 1. Submit answers', '  2. Cancel'];
  const p = parseClaudePrompt(review)!;
  assert.equal(p.question, 'Review your answers');
  assert.deepEqual(p.options.map((o) => o.label), ['Submit answers', 'Cancel']);
});

test('Home never answers a multi-select inline', () => {
  assert.equal(promptFromCapture(MULTI.join('\n')), null);
  assert.ok(promptFromCapture(FORM.join('\n')));
});

test('only boxed options tick; Chat about this and Type something answer', () => {
  const p = parseClaudePrompt(MULTI)!;
  assert.deepEqual(p.options.map(isTick), [true, true, true, false, false]);
  assert.equal(parseClaudePrompt(FORM)!.options.some(isTick), false);
});

test('the recommended option shows first, keys unchanged', () => {
  const lines = FORM.map((l) => l
    .replace('Google Calendar booking page (Recommended)', 'Google Calendar booking page')
    .replace('  3. Both', '  3. Both (Recommended)'));
  const p = parseClaudePrompt(lines)!;
  const shown = displayOptions(p);
  assert.deepEqual(shown.map((o) => o.key), ['3', '1', '2', '4', '5']);
  assert.equal(shown[0].label, 'Both');
  assert.deepEqual(answerOptions(p).map((o) => o.key), ['3', '1', '2', '4', '5']);
});

test('"(Recommended)" in a plain reply list is left alone', () => {
  const p = parseClaudePrompt(['Pick one:', '1. Fast (Recommended)', '2. Slow'])!;
  assert.equal(p.options[0].label, 'Fast (Recommended)');
  assert.equal(p.options[0].recommended, undefined);
});
