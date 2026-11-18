/**
 * @file Session attention order tests
 * @description The ordering, next-waiting and cold-open rules in
 *   apps/client/src/lib/sessionOrder.ts. Run with `npm test` (node --test,
 *   native TS type stripping).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderSessions, nextWaiting, opensFirst, waitAge, RECENT_FOCUS_MS } from '../src/lib/sessionOrder.ts';

type S = Parameters<typeof orderSessions>[0][number];
const NOW = 1_800_000_000_000;
const s = (id: string, attention: S['attention'], activityAt: number, unseen = false): S => ({
  id, name: id, windows: [], createdAt: 0, attached: false, attention, activityAt, unseen,
});

const quiet = s('quiet', 'idle', 900);
const done = s('done', 'idle', 800, true);
const working = s('working', 'working', 700);
const error = s('error', 'error', 600);
const waitNew = s('waitNew', 'waiting', 500);
const waitOld = s('waitOld', 'waiting', 100);

test('sorts waiting, error, working, done-unseen, quiet; longest wait first', () => {
  const ids = orderSessions([quiet, done, working, waitNew, error, waitOld]).map((x) => x.id);
  assert.deepEqual(ids, ['waitOld', 'waitNew', 'error', 'working', 'done', 'quiet']);
});

test('outside "needs you" the newest activity comes first', () => {
  const a = s('a', 'idle', 100), b = s('b', 'idle', 200);
  assert.deepEqual(orderSessions([a, b]).map((x) => x.id), ['b', 'a']);
});

test('does not mutate its input', () => {
  const list = [quiet, waitOld];
  orderSessions(list);
  assert.deepEqual(list.map((x) => x.id), ['quiet', 'waitOld']);
});

test('next waiting skips the session on screen and returns null when nobody waits', () => {
  const list = [quiet, waitNew, waitOld];
  assert.equal(nextWaiting(list, null)?.id, 'waitOld');
  assert.equal(nextWaiting(list, 'waitOld')?.id, 'waitNew');
  assert.equal(nextWaiting([quiet, working], null), null);
});

test('cold open keeps a recent last session', () => {
  assert.equal(opensFirst([quiet, waitOld], 'quiet', NOW - 60_000, NOW)?.id, 'quiet');
});

test('cold open prefers the longest-waiting agent over a stale last session', () => {
  assert.equal(opensFirst([quiet, waitNew, waitOld], 'quiet', NOW - RECENT_FOCUS_MS - 1, NOW)?.id, 'waitOld');
});

test('cold open keeps a stale last session that is itself waiting', () => {
  assert.equal(opensFirst([waitNew, waitOld], 'waitNew', NOW - 86_400_000, NOW)?.id, 'waitNew');
});

test('cold open falls back to the stale last session, then to Home', () => {
  assert.equal(opensFirst([quiet, working], 'quiet', null, NOW)?.id, 'quiet');
  assert.equal(opensFirst([quiet, working], null, null, NOW), null);
  assert.equal(opensFirst([quiet], 'gone', NOW, NOW), null);
});

test('cold open respects leaving for Home even when an agent waits', () => {
  assert.equal(opensFirst([quiet, waitOld], null, null, NOW), null);
});

test('wait age reads short', () => {
  const at = (sec: number) => s('x', 'waiting', NOW / 1000 - sec);
  assert.equal(waitAge(at(10), NOW), 'now');
  assert.equal(waitAge(at(4 * 60), NOW), '4m');
  assert.equal(waitAge(at(65 * 60), NOW), '1h 5m');
  assert.equal(waitAge(at(2 * 86400), NOW), '2d');
});
