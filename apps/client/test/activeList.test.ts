/**
 * @file Active list and profile category tests
 * @description The stable order of the one Active list
 *   (lib/sessionOrder activeOrder), the profile categories
 *   (lib/profileGroups) and the literal text command the Files panel uses
 *   to type an uploaded path into a session (lib/inlineAnswer
 *   typeTextCommand). Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeOrder } from '../src/lib/sessionOrder.ts';
import { groupProfiles, isArchiveGroup, isFlat } from '../src/lib/profileGroups.ts';
import { shellPath, typeTextCommand } from '../src/lib/inlineAnswer.ts';

type S = Parameters<typeof activeOrder>[0][number];
const s = (id: string, attention: S['attention'], createdAt: number, activityAt: number, unseen = false): S => ({
  id, name: id, windows: [], createdAt, attached: false, attention, activityAt, unseen,
});

test('active order: waiting (longest wait first), then errors, then newest started', () => {
  const list = [
    s('old-idle', 'idle', 1000, 900),
    s('new-working', 'working', 5000, 950),
    s('wait-late', 'waiting', 2000, 800),
    s('mid-done', 'idle', 3000, 990, true),
    s('wait-early', 'waiting', 4000, 100),
    s('err', 'error', 1500, 500),
  ];
  assert.deepEqual(activeOrder(list).map((x) => x.id), ['wait-early', 'wait-late', 'err', 'new-working', 'mid-done', 'old-idle']);
});

test('active order: a working/quiet flip does not move a row', () => {
  const a = s('a', 'working', 3000, 10);
  const b = s('b', 'idle', 2000, 999);
  const c = s('c', 'idle', 1000, 5);
  const before = activeOrder([a, b, c]).map((x) => x.id);
  const after = activeOrder([{ ...a, attention: 'idle', activityAt: 1 }, { ...b, attention: 'working' }, { ...c, unseen: true }]).map((x) => x.id);
  assert.deepEqual(before, ['a', 'b', 'c']);
  assert.deepEqual(after, before);
});

test('active order: does not mutate its input and breaks ties by id', () => {
  const list = [s('b', 'idle', 0, 0), s('a', 'idle', 0, 0)];
  assert.deepEqual(activeOrder(list).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(list.map((x) => x.id), ['b', 'a']);
});

type P = Parameters<typeof groupProfiles>[0][number];
const p = (id: string, group?: string, pinned = false): P => ({ id, name: id, cwd: '/', group, pinned } as P);

test('profile groups: pinned, named groups in first-seen order, Other, Archive last', () => {
  const g = groupProfiles([
    p('old', 'Archive'), p('ops', 'Brobata Apps'), p('caddy', 'Infrastructure'), p('loose'),
    p('olive', 'Brobata Apps'), p('star', 'Infrastructure', true), p('dead', 'archive'),
  ]);
  assert.deepEqual(g.map((x) => x.label), ['Pinned', 'Brobata Apps', 'Infrastructure', 'Other', 'Archive', 'archive']);
  assert.deepEqual(g[1].items.map((x) => x.id), ['ops', 'olive'], 'saved order kept inside a group');
  assert.deepEqual(g[0].items.map((x) => x.id), ['star'], 'pinned wins over its group');
  assert.deepEqual(g.map((x) => x.key), ['#pinned', 'g:Brobata Apps', 'g:Infrastructure', '#other', 'g:Archive', 'g:archive']);
});

test('profile groups: blank group names count as none; flat when grouping adds nothing', () => {
  const g = groupProfiles([p('a', '  '), p('b')]);
  assert.deepEqual(g.map((x) => x.label), ['Other']);
  assert.equal(isFlat(g), true);
  assert.equal(isFlat(groupProfiles([])), true);
  assert.equal(isFlat(groupProfiles([p('a', 'X'), p('b')])), false);
});

test('archive groups start folded', () => {
  assert.equal(isArchiveGroup('Archive'), true);
  assert.equal(isArchiveGroup(' archived '), true);
  assert.equal(isArchiveGroup('Archives of Ops'), false);
});

test('typeTextCommand: literal, quoted, never a control key, PersaLink sessions only', () => {
  assert.equal(
    typeTextCommand('pl-ops', '~/shared/persalink-uploads/a b.png '),
    "tmux send-keys -t '=pl-ops:' -l '~/shared/persalink-uploads/a b.png '",
  );
  assert.equal(typeTextCommand('pl-ops', "it's.txt"), "tmux send-keys -t '=pl-ops:' -l 'it'\\''s.txt'");
  assert.equal(typeTextCommand('pl-ops', 'a\nrm -rf /'), null, 'a newline would press Enter');
  assert.equal(typeTextCommand('pl-ops', 'a\x1b'), null);
  assert.equal(typeTextCommand('main', 'x'), null);
  assert.equal(typeTextCommand('pl-ops', ''), null);
});

test('shellPath: spaces and quotes escaped, tilde left to expand', () => {
  assert.equal(shellPath('~/shared/persalink-uploads/a b (1).png'), '~/shared/persalink-uploads/a\\ b\\ \\(1\\).png');
  assert.equal(shellPath("~/x/it's.txt"), "~/x/it\\'s.txt");
  assert.equal(shellPath('~/shared/persalink-uploads/plain_name-1.txt'), '~/shared/persalink-uploads/plain_name-1.txt');
  assert.equal(
    typeTextCommand('pl-ops', `${shellPath("~/x/it's a.txt")} `),
    "tmux send-keys -t '=pl-ops:' -l '~/x/it\\'\\''s\\ a.txt '",
  );
});
