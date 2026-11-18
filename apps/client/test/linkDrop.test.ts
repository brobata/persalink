/**
 * @file Link drop rule tests
 * @description When a dropped link counts as down, the 8s escalation point,
 *   and the drop's wording (lib/linkDrop). Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATE_MS, isLinkDown, downFor, backSentence } from '../src/lib/linkDrop.ts';
import { readout } from '../src/lib/readout.ts';

test('a drop counts only on signed-in views', () => {
  for (const view of ['home', 'terminal', 'settings', 'profile-editor', 'files']) {
    assert.equal(isLinkDown(view, 'reconnecting'), true, view);
    assert.equal(isLinkDown(view, 'connecting'), true, view);
    // socket open again but not yet authenticated: still down
    assert.equal(isLinkDown(view, 'connected'), true, view);
    assert.equal(isLinkDown(view, 'authenticated'), false, view);
  }
  for (const view of ['locked', 'connect', 'auth']) {
    assert.equal(isLinkDown(view, 'reconnecting'), false, view);
  }
  assert.equal(isLinkDown('home', 'disconnected'), false);
});

test('escalation waits about 8 seconds', () => {
  assert.equal(ESCALATE_MS, 8000);
});

test('the title says reconnecting while down', () => {
  assert.equal(readout('reconnecting', 18).text, 'reconnecting');
  assert.equal(readout('connecting', null).text, 'reconnecting');
});

test('down-for wording', () => {
  assert.equal(downFor(400), '0s');
  assert.equal(downFor(12_300), '12s');
  assert.equal(downFor(60_000), '1m');
  assert.equal(downFor(72_900), '1m 12s');
  assert.equal(downFor(-5), '0s');
});

test('back sentence names the server', () => {
  assert.equal(backSentence('x570d4u', 12_000), 'Back on x570d4u after 12s. Sessions kept running.');
  assert.equal(backSentence(null, 9_000), 'Back on the server after 9s. Sessions kept running.');
});
