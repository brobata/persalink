/**
 * @file Design system rule tests
 * @description The pure rules behind the shared UI components: the state
 *   vocabulary and groups (lib/sessionState), Claude prompt options and chip
 *   labels (lib/claudePrompt), profile monograms (lib/monogram) and the
 *   connection readout (lib/readout). Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateKey, stateWord, groupSessions, countStates, needsSentence, rowAge } from '../src/lib/sessionState.ts';
import { parseClaudePrompt, chipLabel } from '../src/lib/claudePrompt.ts';
import { monogram, tileColor } from '../src/lib/monogram.ts';
import { readout } from '../src/lib/readout.ts';

type S = Parameters<typeof stateKey>[0];
const NOW = 1_800_000_000_000;
const s = (id: string, attention: S['attention'], ageSec: number, unseen = false): S => ({
  id, name: id, windows: [], createdAt: 0, attached: false, attention, activityAt: NOW / 1000 - ageSec, unseen,
});

test('state keys follow the vocabulary', () => {
  assert.equal(stateKey(s('a', 'waiting', 0)), 'waiting');
  assert.equal(stateKey(s('a', 'idle', 0, true)), 'done');
  assert.equal(stateKey(s('a', 'idle', 0)), 'idle');
  assert.equal(stateKey(s('a', undefined, 0)), 'idle');
  assert.equal(stateKey(s('a', 'working', 0), { exited: true }), 'exited');
  assert.equal(stateKey(s('a', 'working', 0), { offline: true }), 'disconnected');
});

test('state words and row ages', () => {
  assert.equal(stateWord(s('a', 'waiting', 240), undefined, NOW), 'Waiting 4m');
  assert.equal(stateWord(s('a', 'working', 240), undefined, NOW), 'Working');
  assert.equal(stateWord(s('a', 'idle', 3900, true), undefined, NOW), 'Done 1h 5m');
  assert.equal(rowAge(s('a', 'working', 240), undefined, NOW), '');
  assert.equal(rowAge(s('a', 'waiting', 240), undefined, NOW), '4m');
});

test('groups keep their fixed order and put done before idle in Quiet', () => {
  const list = [s('idle', 'idle', 10), s('done', 'idle', 900, true), s('w', 'working', 5), s('wait', 'waiting', 60), s('err', 'error', 30)];
  const g = groupSessions(list);
  assert.deepEqual(g.map((x) => x.id), ['needs', 'working', 'quiet', 'ended']);
  assert.deepEqual(g[0].items.map((x) => x.id), ['wait', 'err']);
  assert.deepEqual(g[2].items.map((x) => x.id), ['done', 'idle']);
  assert.equal(g[3].items.length, 0);
  const c = countStates(list);
  assert.deepEqual([c.waiting, c.working, c.quiet, c.ended, c.live], [2, 1, 2, 0, 5]);
});

test('needs sentence is computed, singular and plural', () => {
  assert.equal(needsSentence(0), 'Nothing needs you');
  assert.equal(needsSentence(1), '1 agent needs you');
  assert.equal(needsSentence(3), '3 agents need you');
});

test('parses a Claude permission prompt at the bottom of the screen', () => {
  const lines = [
    '⏺ Bash(node scripts/db/apply-migration.mjs)',
    '',
    '╭──────────────────────────────────────╮',
    '│ Do you want to proceed?              │',
    '│ ❯ 1. Yes                             │',
    "│   2. Yes, and don't ask again for node scripts/db in /home/x │",
    '│   3. No, and tell Claude what to do differently (esc) │',
    '╰──────────────────────────────────────╯',
  ];
  const p = parseClaudePrompt(lines);
  assert.ok(p);
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => o.key), ['1', '2', '3']);
  assert.equal(p.options[2].label, 'No, and tell Claude what to do differently');
  assert.deepEqual(p.options.map(chipLabel), ['Yes', 'Always', 'No, explain']);
});

test('a numbered list earlier in a reply is not a prompt', () => {
  const lines = ['Steps:', '1. Build', '2. Test', 'Done. Anything else?', '> ', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
  assert.equal(parseClaudePrompt(lines), null);
  assert.equal(parseClaudePrompt(['1. only one']), null);
  assert.equal(parseClaudePrompt(['Pick', '1. a', '3. c']), null);
});

test('chip labels are never shortened', () => {
  assert.equal(chipLabel({ key: '1', label: 'Yes, upload 0.4.2 (31) now' }), 'Yes, upload 0.4.2 (31) now');
});

test('monograms', () => {
  assert.equal(monogram('Ops Suite'), 'OS');
  assert.equal(monogram('olive'), 'OL');
  assert.equal(monogram('brobata-ops'), 'BO');
  assert.equal(monogram('  '), '?');
  assert.equal(monogram(undefined), '?');
  assert.equal(tileColor('#3ddc97'), '#3ddc97');
  assert.equal(tileColor('red; background:url(x)'), null);
});

test('connection readout', () => {
  assert.deepEqual(readout('authenticated', 18.4), { kind: 'ok', text: '18 ms' });
  assert.deepEqual(readout('authenticated', 312), { kind: 'slow', text: '312 ms slow' });
  assert.deepEqual(readout('authenticated', null), { kind: 'ok', text: 'connected' });
  assert.deepEqual(readout('reconnecting', 18), { kind: 'off', text: 'reconnecting' });
  assert.deepEqual(readout('disconnected', null), { kind: 'off', text: 'offline' });
});
