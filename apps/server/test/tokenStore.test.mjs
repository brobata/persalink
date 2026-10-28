/**
 * @file TokenStore expiry tests
 * @description Runs against the compiled server (`npm run build:server` first;
 *   `npm test` does both). Uses a throwaway PERSALINK_CONFIG_DIR.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const DAY = 24 * 60 * 60 * 1000;
let auth;

before(() => {
  process.env.PERSALINK_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-tokens-'));
  auth = require('../dist/apps/server/src/auth.js');
});

function freshStore(idleDays) {
  fs.rmSync(path.join(process.env.PERSALINK_CONFIG_DIR, 'tokens.json'), { force: true });
  return new auth.TokenStore(idleDays);
}

function backdate(store, plaintext, lastUsedDaysAgo) {
  const token = store.validateToken(plaintext);
  token.lastUsedAt = new Date(Date.now() - lastUsedDaysAgo * DAY).toISOString();
}

test('a recently used token validates', () => {
  const store = freshStore(90);
  const { plaintext } = store.createAccessToken('phone', 365);
  backdate(store, plaintext, 10);
  assert.ok(store.validateToken(plaintext));
});

test('a token idle past the limit is rejected and purged', () => {
  const store = freshStore(90);
  const { plaintext } = store.createAccessToken('old laptop', 365);
  const keep = store.createAccessToken('phone', 365).plaintext;
  backdate(store, plaintext, 91);
  assert.equal(store.validateToken(plaintext), null);
  assert.equal(store.purgeExpired(), 1);
  assert.deepEqual(store.list().map((t) => t.name), ['phone']);
  assert.ok(store.validateToken(keep));
});

test('idle expiry off (null) keeps old tokens until their TTL', () => {
  const store = freshStore(null);
  const { plaintext } = store.createAccessToken('desk', 365);
  backdate(store, plaintext, 300);
  assert.ok(store.validateToken(plaintext));
  assert.equal(store.purgeExpired(), 0);
});

test('a token past its TTL is rejected even if used recently', () => {
  const store = freshStore(90);
  const { plaintext } = store.createAccessToken('desk', 1);
  assert.equal(store.purgeExpired(new Date(Date.now() + 2 * DAY)), 1);
  assert.equal(store.validateToken(plaintext), null);
});

test('purge persists to disk', () => {
  const store = freshStore(90);
  const { plaintext } = store.createAccessToken('gone', 365);
  backdate(store, plaintext, 120);
  store.purgeExpired();
  const reloaded = new auth.TokenStore(90);
  assert.equal(reloaded.list().length, 0);
});

test('a non-positive idle setting disables idle expiry instead of locking everyone out', () => {
  const store = freshStore(0);
  const { plaintext } = store.createAccessToken('desk', 365);
  backdate(store, plaintext, 1);
  assert.ok(store.validateToken(plaintext));
});
