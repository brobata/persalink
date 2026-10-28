/**
 * @file Second-step unit tests
 * @description TOTP against the RFC 6238 SHA1 vectors (6-digit), drift window
 *   and replay guard; base32 round trip; and the phone-approval manager
 *   (single use, wrong secret, expiry, cancel).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const totp = require('../dist/apps/server/src/totp.js');
const { ApprovalManager } = require('../dist/apps/server/src/approvals.js');

const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

test('TOTP matches the RFC 6238 SHA1 vectors', () => {
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(totp.codeAt(RFC_SECRET, Math.floor(t / 30)), code, `t=${t}`);
  }
});

test('TOTP accepts one step of drift, refuses more, and refuses replays', () => {
  const now = 1234567890 * 1000;
  const step = Math.floor(now / 30000);
  assert.equal(totp.verifyCode(RFC_SECRET, totp.codeAt(RFC_SECRET, step), now), step);
  assert.equal(totp.verifyCode(RFC_SECRET, totp.codeAt(RFC_SECRET, step - 1), now), step - 1);
  assert.equal(totp.verifyCode(RFC_SECRET, totp.codeAt(RFC_SECRET, step + 1), now), step + 1);
  assert.equal(totp.verifyCode(RFC_SECRET, totp.codeAt(RFC_SECRET, step + 2), now), null);
  assert.equal(totp.verifyCode(RFC_SECRET, totp.codeAt(RFC_SECRET, step), now, step), null, 'same step again');
  assert.equal(totp.verifyCode(RFC_SECRET, totp.codeAt(RFC_SECRET, step - 1), now, step), null, 'older step');
  assert.equal(totp.verifyCode(RFC_SECRET, '12345', now), null);
  assert.equal(totp.verifyCode(RFC_SECRET, 'abcdef', now), null);
});

test('secrets round-trip through base32 and validate', () => {
  const s = totp.generateSecret();
  assert.ok(totp.isValidSecret(s));
  assert.equal(totp.base32Decode(s).length, 20);
  assert.equal(totp.base32Encode(totp.base32Decode(s)), s);
  assert.equal(totp.isValidSecret('short'), false);
  assert.equal(totp.isValidSecret('not base32 at all 1890'), false);
  assert.match(totp.otpauthUri(s, 'Terminal', 'SpokeRemote'), /^otpauth:\/\/totp\/SpokeRemote%3ATerminal\?secret=[A-Z2-7]+&issuer=SpokeRemote/);
});

test('an approval is answered once, only with its secret', async () => {
  const m = new ApprovalManager(5000);
  const r = m.create();
  assert.match(r.number, /^\d{2}$/);
  assert.equal(m.answer(r.id, 'wrong', 'approve'), false);
  assert.equal(m.answer('other-id', r.secret, 'approve'), false);
  assert.equal(m.answer(r.id, r.secret, 'approve'), true);
  assert.equal(m.answer(r.id, r.secret, 'deny'), false, 'single use');
  assert.equal(await r.outcome, 'approved');

  const d = m.create();
  assert.equal(m.answer(d.id, d.secret, 'deny'), true);
  assert.equal(await d.outcome, 'denied');
});

test('an unanswered approval expires, and a cancelled one cannot be answered', async () => {
  const m = new ApprovalManager(50);
  const r = m.create();
  assert.equal(await r.outcome, 'expired');
  assert.equal(m.answer(r.id, r.secret, 'approve'), false);

  const c = new ApprovalManager(5000).create();
  c.cancel();
  assert.equal(await c.outcome, 'cancelled');
});
