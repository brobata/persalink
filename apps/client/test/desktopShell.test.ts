/**
 * @file Desktop shell tests
 * @description The pure rules behind the calm desktop: pane layouts and the
 *   stash that keeps panes a smaller layout put aside (lib/workspaces), a
 *   saved four-pane grid reopening as a split of two, workspace tab names,
 *   where a message goes and what the status bar adds (lib/statusLine),
 *   whole-row fitting (lib/terminalDims rowInset), the readable preview line
 *   (lib/sessionState previewLine) and the new desktop keys. Run with
 *   `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calmOpen, clearWhere, dedupePanes, dropWhere, newWorkspaceId, paneCountFor, reshape, workspaceLabel,
  type PaneSlot, type Workspace,
} from '../src/lib/workspaces.ts';
import { goesToStatusBar, sentSentence, waitingTail } from '../src/lib/statusLine.ts';
import { rowInset } from '../src/lib/terminalDims.ts';
import { previewLine } from '../src/lib/sessionState.ts';
import { desktopAction, type KeyLike } from '../src/lib/keymap.ts';

const slot = (id: string, sessionId: string | null = null): PaneSlot => ({ id, sessionId, serverId: null });

test('reshape: shrinking stashes assigned panes, growing brings them back', () => {
  const four = [slot('pane-0', 'a'), slot('pane-1', 'b'), slot('pane-2', 'c'), slot('pane-3')];
  const two = reshape('split-h', four);
  assert.deepEqual(two.panes.map((p) => p.sessionId), ['a', 'b']);
  assert.deepEqual(two.stash.map((p) => p.sessionId), ['c'], 'the empty pane is dropped, the assigned one kept');
  const back = reshape('2x2', two.panes, two.stash);
  assert.deepEqual(back.panes.map((p) => p.sessionId), ['a', 'b', 'c', null]);
  assert.equal(back.stash.length, 0);
  assert.equal(new Set(back.panes.map((p) => p.id)).size, 4, 'pane ids stay unique');
});

test('reshape: pane counts per layout', () => {
  assert.equal(paneCountFor('single'), 1);
  assert.equal(paneCountFor('split-h'), 2);
  assert.equal(paneCountFor('split-v'), 2);
  assert.equal(paneCountFor('2x2'), 4);
  assert.equal(reshape('single', []).panes.length, 1);
});

test('calmOpen: a saved 2x2 reopens as a split of the focused pane and the next one in use', () => {
  const ws: Workspace = {
    id: 'ws-1', name: null, layout: '2x2', focusedPaneId: 'pane-2', stash: [],
    panes: [slot('pane-0'), slot('pane-1', 'b'), slot('pane-2', 'c'), slot('pane-3', 'd')],
  };
  const calm = calmOpen(ws);
  assert.equal(calm.layout, 'split-h');
  assert.deepEqual(calm.panes.map((p) => p.sessionId), ['c', 'b']);
  assert.equal(calm.focusedPaneId, 'pane-2');
  assert.deepEqual(calm.stash.map((p) => p.sessionId), ['d'], 'the fourth waits in the stash');
  const split: Workspace = { ...ws, layout: 'split-h' };
  assert.equal(calmOpen(split), split, 'other layouts open as saved');
});

test('clearWhere / dropWhere: unchanged arrays come back as the same array', () => {
  const panes = [slot('pane-0', 'a')];
  assert.equal(clearWhere(panes, () => false), panes);
  assert.deepEqual(clearWhere(panes, (p) => p.sessionId === 'a')[0].sessionId, null);
  const stash = [slot('pane-2', 'c')];
  assert.equal(dropWhere(stash, () => false), stash);
  assert.equal(dropWhere(stash, () => true).length, 0);
});

test('dedupePanes: the same session on the same server shows once', () => {
  const out = dedupePanes([slot('pane-0', 'a'), slot('pane-1', 'a'), { id: 'pane-2', sessionId: 'a', serverId: 'other' }]);
  assert.deepEqual(out.map((p) => p.sessionId), ['a', null, 'a']);
});

test('workspaceLabel: typed name, else what its panes show, else Empty', () => {
  const titles: Record<string, string> = { a: 'Ops Suite', b: 'Olive', c: 'Stoked' };
  const t = (id: string) => titles[id] ?? null;
  assert.equal(workspaceLabel({ name: 'Agents', layout: 'single', panes: [slot('pane-0', 'a')] }, t), 'Agents');
  assert.equal(workspaceLabel({ name: null, layout: 'split-h', panes: [slot('pane-0', 'a'), slot('pane-1', 'b')] }, t), 'Ops Suite · Olive');
  assert.equal(workspaceLabel({ name: null, layout: '2x2', panes: [slot('pane-0', 'a'), slot('pane-1', 'b'), slot('pane-2', 'c'), slot('pane-3')] }, t), 'Ops Suite · Olive +1');
  assert.equal(workspaceLabel({ name: '  ', layout: 'single', panes: [slot('pane-0')] }, t), 'Empty');
  assert.equal(workspaceLabel({ name: null, layout: 'single', panes: [slot('pane-0', 'a'), slot('pane-1', 'b')] }, t), 'Ops Suite', 'hidden panes do not name the tab');
});

test('newWorkspaceId: never reuses an id', () => {
  assert.equal(newWorkspaceId(['ws-1']), 'ws-2');
  assert.equal(newWorkspaceId(['ws-1', 'ws-3']), 'ws-4');
  assert.equal(newWorkspaceId(['ws-2']), 'ws-3');
});

test('status line: confirmations go to the bar, errors and tap prompts stay toasts', () => {
  assert.equal(goesToStatusBar({ kind: 'info' }), true);
  assert.equal(goesToStatusBar({ kind: 'info', op: 'remote' }), true);
  assert.equal(goesToStatusBar({ kind: 'error' }), false);
  assert.equal(goesToStatusBar({ kind: 'info', op: 'copy-pending' }), false);
  assert.equal(goesToStatusBar({ kind: 'info', op: 'link-open' }), false);
  assert.equal(goesToStatusBar({ kind: 'info', op: 'share-pending' }), false);
});

test('status line: the sentence and its waiting tail', () => {
  assert.equal(sentSentence('Yes', 'Ops Suite'), "Sent 'Yes' to Ops Suite");
  assert.equal(sentSentence('Always', null), "Sent 'Always'");
  assert.equal(waitingTail({ title: 'Olive', age: '9m' }), 'Olive is waiting 9m');
  assert.equal(waitingTail({ title: 'Olive', age: 'now' }), 'Olive is waiting');
  assert.equal(waitingTail(null), null);
});

test('rowInset: whole rows only, never negative or fractional', () => {
  assert.equal(rowInset(500, 486), 14);
  assert.equal(rowInset(500.6, 486), 14);
  assert.equal(rowInset(480, 486), 0);
  assert.equal(rowInset(0, 0), 0);
  assert.equal(rowInset(Number.NaN, 10), 0);
});

test('previewLine: frames go, a bare option line on a waiting agent reads as a question', () => {
  const base = { id: 'x', name: 'x', windows: [], createdAt: 0, attached: false };
  assert.equal(previewLine({ ...base, attention: 'waiting', preview: '│   3. No, and tell Claude what to do differently (esc) │' }), 'Asking you to choose an option');
  assert.equal(previewLine({ ...base, attention: 'working', preview: '│ ⠋ building │' }), '⠋ building');
  assert.equal(previewLine({ ...base, attention: 'waiting', preview: '❯ Upload build 31 now?' }), 'Upload build 31 now?');
});

test('desktop keys: Ctrl+Alt+B folds the sidebar, Ctrl+Alt+H goes Home', () => {
  const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.equal(desktopAction(key('b', { ctrlKey: true, altKey: true }), true), 'sidebar');
  assert.equal(desktopAction(key('h', { ctrlKey: true, altKey: true }), true), 'home');
  assert.equal(desktopAction(key('b', { ctrlKey: true }), true), null, 'plain Ctrl+B stays with the terminal');
  assert.equal(desktopAction(key('h', { ctrlKey: true }), true), null, 'plain Ctrl+H (backspace) stays with the terminal');
});
