/**
 * @file Palette and key tests
 * @description The pure rules behind the command palette (lib/paletteRank:
 *   word-start ranking, fixed sections, the short-query cap), the keymap
 *   matchers (lib/keymap: the Titan's symbol layer is never stolen) and the
 *   on-screen prompt reader digit answers use (lib/claudePrompt). Run with
 *   `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, rankPalette, type Rankable } from '../src/lib/paletteRank.ts';
import { answerDigit, desktopAction, phoneAction, type KeyLike } from '../src/lib/keymap.ts';
import { promptOnScreen, type BufferLike } from '../src/lib/claudePrompt.ts';

test('match: start beats word start beats contiguous beats letters in order', () => {
  const start = matchScore('sto', 'Stoked');
  const word = matchScore('sto', 'Big Stoked');
  const inner = matchScore('sto', 'Kistoked');
  const loose = matchScore('sto', 'Setup tools');
  assert.ok(start > word && word > inner && inner > loose && loose > 0);
  assert.equal(matchScore('stoked', 'Setup tools other kit'), 0, 'long queries do not match loose letters');
  assert.equal(matchScore('', 'anything'), 1);
  assert.equal(matchScore('x', ''), 0);
});

test('match: a later word start still counts as a word start', () => {
  // "ops" appears mid-word first ("tops"), then at a word start ("ops").
  assert.ok(matchScore('ops', 'laptops ops suite') >= 79);
});

type Item = Rankable & { id: string };
const items: Item[] = [
  { id: 'w1', section: 'Needs you', label: 'Olive' },
  { id: 'w2', section: 'Needs you', label: 'Ops Suite' },
  { id: 's1', section: 'Sessions', label: 'Stoked site' },
  { id: 's2', section: 'Sessions', label: 'PersaLink' },
  { id: 's3', section: 'Sessions', label: 'Freecost' },
  { id: 'a1', section: 'Actions', label: 'Settings' },
  { id: 'a2', section: 'Actions', label: 'Files' },
  { id: 'a3', section: 'Actions', label: 'New Stoked session', searchOnly: true },
];

test('rank: empty query keeps the order given, hides search-only rows, sections fixed', () => {
  const r = rankPalette(items, '');
  assert.deepEqual(r.sections.map((s) => s.section), ['Needs you', 'Sessions', 'Actions']);
  assert.deepEqual(r.flat.map((x) => x.id), ['w1', 'w2', 's1', 's2', 's3', 'a1', 'a2']);
  assert.equal(r.best, 0);
});

test('rank: sections stay in order while the best match leads inside its section and gets the selection', () => {
  const r = rankPalette(items, 'stok');
  assert.deepEqual(r.sections.map((s) => s.section), ['Sessions', 'Actions']);
  assert.deepEqual(r.flat.map((x) => x.id), ['s1', 'a3']);
  assert.equal(r.flat[r.best].id, 's1', 'Enter goes to the prefix match');
});

test('rank: best match can sit below the first section', () => {
  const r = rankPalette(items, 'files');
  assert.equal(r.flat[r.best].id, 'a2');
});

test('rank: a short query caps Sessions and Actions, never Needs you', () => {
  const many: Item[] = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, section: 'Needs you' as const, label: `agent ${i}` })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, section: 'Sessions' as const, label: `a session ${i}` })),
  ];
  const r = rankPalette(many, 'a', 4);
  const needs = r.sections.find((s) => s.section === 'Needs you')!;
  const sess = r.sections.find((s) => s.section === 'Sessions')!;
  assert.equal(needs.items.length, 6);
  assert.equal(sess.items.length, 4);
  assert.equal(sess.more, 2);
  const long = rankPalette(many, 'session', 4);
  assert.equal(long.sections.find((s) => s.section === 'Sessions')!.items.length, 6, 'three letters lifts the cap');
});

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k, code: mods.code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

test('keys: desktop palette, next waiting, files, settings, shortcuts', () => {
  assert.equal(desktopAction(key('K', { ctrlKey: true, shiftKey: true }), true), 'palette');
  assert.equal(desktopAction(key('k', { ctrlKey: true }), false), 'palette');
  assert.equal(desktopAction(key('k', { ctrlKey: true }), true), null, 'Ctrl+K stays kill-line inside the terminal');
  assert.equal(desktopAction(key('k', { metaKey: true }), false), 'palette');
  assert.equal(desktopAction(key('j', { ctrlKey: true, altKey: true }), true), 'next-waiting');
  assert.equal(desktopAction(key('f', { ctrlKey: true, altKey: true }), true), 'files');
  assert.equal(desktopAction(key(',', { ctrlKey: true, altKey: true }), true), 'settings');
  assert.equal(desktopAction(key('?', { ctrlKey: true, shiftKey: true, code: 'Slash' }), true), 'shortcuts');
  // AltGr (Ctrl+Alt) producing a symbol is typing, not a shortcut.
  assert.equal(desktopAction(key('@', { ctrlKey: true, altKey: true, code: 'KeyQ' }), true), null);
});

test('keys: the phone Alt set, and a symbol layer is never taken', () => {
  assert.equal(phoneAction(key('k', { altKey: true, code: 'KeyK' })), 'palette');
  assert.equal(phoneAction(key('j', { altKey: true, code: 'KeyJ' })), 'next-waiting');
  assert.equal(phoneAction(key('m', { altKey: true })), 'composer');
  assert.equal(phoneAction(key('y', { altKey: true })), 'copy-claude');
  assert.equal(phoneAction(key('u', { altKey: true })), 'upload');
  assert.equal(phoneAction(key('h', { altKey: true })), 'home');
  assert.equal(phoneAction(key('[', { altKey: true, code: 'BracketLeft' })), 'prev-session');
  assert.equal(phoneAction(key(']', { altKey: true, code: 'BracketRight' })), 'next-session');
  // The Titan's Alt layer: Alt+M types "." and some letter key types "[".
  assert.equal(phoneAction(key('.', { altKey: true, code: 'KeyM' })), null);
  assert.equal(phoneAction(key('[', { altKey: true, code: 'KeyX' })), null);
  assert.equal(phoneAction(key('j')), null, 'a plain letter is typing');
  assert.equal(phoneAction(key('K', { ctrlKey: true, shiftKey: true })), 'palette');
});

test('keys: digit answers are bare digits 1-9 only', () => {
  assert.equal(answerDigit(key('1')), '1');
  assert.equal(answerDigit(key('9')), '9');
  assert.equal(answerDigit(key('0')), null);
  assert.equal(answerDigit(key('1', { altKey: true })), null);
  assert.equal(answerDigit(key('1', { ctrlKey: true })), null);
});

function fakeTerm(rows: string[], cursorRow = rows.length - 1): BufferLike {
  return {
    buffer: {
      active: {
        length: rows.length,
        baseY: 0,
        cursorY: cursorRow,
        getLine: (i: number) => (i < rows.length ? { translateToString: () => rows[i] } : undefined),
      },
    },
  };
}

test('prompt on screen: reads the numbered prompt at the cursor, ignores old scrollback', () => {
  const screen = [
    'old output',
    '1. an old numbered list',
    '2. that scrolled past',
    ...Array.from({ length: 30 }, () => 'work work'),
    '╭──────────────────────────────╮',
    '│ Do you want to proceed?      │',
    '│ ❯ 1. Yes                     │',
    "│   2. Yes, and don't ask again │",
    '│   3. No, and tell Claude what to do differently (esc) │',
    '╰──────────────────────────────╯',
    '',
    '',
  ];
  const p = promptOnScreen(fakeTerm(screen, screen.length - 3));
  assert.ok(p);
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => o.key), ['1', '2', '3']);
  const plain = promptOnScreen(fakeTerm(['$ ls', 'a  b  c', '$ ']));
  assert.equal(plain, null);
});
