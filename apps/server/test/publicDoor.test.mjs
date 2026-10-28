/**
 * @file Public door tests — Access JWT verification, door-bound tokens,
 *   fail-closed config. Runs against the compiled server (`npm test`).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const jose = require('jose');
let auth, accessJwt, config;

const TEAM = 'brobata.cloudflareaccess.com';
const AUD = 'ad425f823a512c5ec3be6992cf4229c9a0d27ceb0464cd7f0953c990d279a20b';
let key, otherKey, keySet;

before(async () => {
  process.env.PERSALINK_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-door-'));
  auth = require('../dist/apps/server/src/auth.js');
  accessJwt = require('../dist/apps/server/src/accessJwt.js');
  config = require('../dist/apps/server/src/config.js');
  key = await jose.generateKeyPair('RS256');
  otherKey = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(key.publicKey)), kid: 'k1', alg: 'RS256' };
  keySet = jose.createLocalJWKSet({ keys: [jwk] });
});

function sign(claims, { signer = key.privateKey, exp = '5m' } = {}) {
  return new jose.SignJWT({ email: 'j.levy@brobata.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(signer);
}

function verifier() {
  return accessJwt.createAccessVerifier(
    { teamDomain: TEAM, aud: AUD, allowedEmails: ['J.Levy@brobata.com', 'jeremiah.levy@gmail.com'] },
    keySet,
  );
}

test('a valid Access JWT for an allowed email passes (case-insensitive)', async () => {
  const r = await verifier()(await sign({}));
  assert.equal(r.identity.email, 'j.levy@brobata.com');
  assert.ok(r.identity.expiresAt > Date.now(), 'carries the Access session expiry');
});

test('missing JWT is refused', async () => {
  assert.equal((await verifier()(undefined)).reason, 'missing');
});

test('an email outside the allowlist is refused even with a valid signature', async () => {
  const r = await verifier()(await sign({ email: 'someone@else.com' }));
  assert.equal(r.reason, 'email_not_allowed');
});

test('wrong audience, wrong issuer, expired and forged JWTs are refused', async () => {
  const v = verifier();
  const wrongAud = await new jose.SignJWT({ email: 'j.levy@brobata.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(`https://${TEAM}`)
    .setAudience('0'.repeat(64)).setExpirationTime('5m').sign(key.privateKey);
  const wrongIss = await new jose.SignJWT({ email: 'j.levy@brobata.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://evil.cloudflareaccess.com')
    .setAudience(AUD).setExpirationTime('5m').sign(key.privateKey);
  const expired = await sign({}, { exp: Math.floor(Date.now() / 1000) - 3600 });
  const forged = await sign({}, { signer: otherKey.privateKey });
  for (const jwt of [wrongAud, wrongIss, expired, forged, 'not.a.jwt']) {
    assert.ok('reason' in (await v(jwt)), `should refuse: ${jwt.slice(0, 20)}`);
  }
});

test('tokens only work on the door that minted them', () => {
  fs.rmSync(path.join(process.env.PERSALINK_CONFIG_DIR, 'tokens.json'), { force: true });
  const store = new auth.TokenStore(90);
  const tailnet = store.createAccessToken('phone', 365).plaintext;
  const pub = store.createPublicToken('work pc', 12).plaintext;
  assert.ok(store.validateToken(tailnet));
  assert.ok(store.validateToken(tailnet, 'tailnet'));
  assert.equal(store.validateToken(tailnet, 'public'), null);
  assert.ok(store.validateToken(pub, 'public'));
  assert.equal(store.validateToken(pub, 'tailnet'), null);
  assert.equal(store.validateToken(pub), null);
});

test('public tokens expire in hours, capped at 24', () => {
  const store = new auth.TokenStore(90);
  const { stored } = store.createPublicToken('work pc', 12);
  const ms = new Date(stored.expiresAt) - new Date(stored.createdAt);
  assert.equal(ms, 12 * 3600 * 1000);
  const capped = store.createPublicToken('x', 1000).stored;
  assert.equal(new Date(capped.expiresAt) - new Date(capped.createdAt), 24 * 3600 * 1000);
});

const goodDoor = {
  enabled: true, port: 9878, accessTeamDomain: TEAM, accessAud: AUD,
  allowedEmails: ['j.levy@brobata.com'], sessionTokenTtlHours: 12, disableFiles: true,
};

test('public listener config: off when absent or disabled', () => {
  assert.equal(config.resolvePublicListener({ port: 9877 }), null);
  assert.equal(config.resolvePublicListener({ port: 9877, publicListener: { ...goodDoor, enabled: false } }), null);
  assert.deepEqual(config.resolvePublicListener({ port: 9877, publicListener: goodDoor }), goodDoor);
});

test('public listener config: enabled but incomplete refuses to start', () => {
  for (const bad of [
    { accessAud: '' }, { accessTeamDomain: '' }, { allowedEmails: [] }, { allowedEmails: ['nope'] },
    { port: 9877 }, { sessionTokenTtlHours: 0 }, { sessionTokenTtlHours: 48 }, { disableFiles: 'yes' },
  ]) {
    assert.throws(() => config.resolvePublicListener({ port: 9877, publicListener: { ...goodDoor, ...bad } }),
      /publicListener is enabled but invalid/, JSON.stringify(bad));
  }
});
