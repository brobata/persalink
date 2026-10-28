/**
 * @file Public door integration test
 * @description Boots the compiled server (needs tmux on PATH) with a public
 *   listener whose Access keys come from a local JWKS server, then drives
 *   real HTTP + WebSocket traffic through both doors: the JWT gate, door-bound
 *   tokens, refused operations, the first-run setup guard, and the second
 *   step (authenticator code) every public password login needs.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const jose = require('jose');
const WebSocket = require('ws');
const SERVER = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../dist/apps/server/src/main/index.js');

const TEAM = 'test.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const EMAIL = 'owner@example.com';
const PASSWORD = 'door-test-pass-1';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DOOR_PASSWORD = 'laptop-only-pass-3';
const base = 20000 + Math.floor(Math.random() * 20000);
const PORTS = { tailnet: base, public: base + 1, jwks: base + 2, setupTailnet: base + 3, setupPublic: base + 4, graceTailnet: base + 5, gracePublic: base + 6 };
const GRACE_MS = 1000;

let key, jwksServer;
const children = [];

function writeConfig(dir, { port, publicPort, passwordHash, totpSecret, doorPasswordHash }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port, serverName: 'doortest', passwordHash: passwordHash ?? null,
    security: { bindHost: '127.0.0.1' },
    publicListener: {
      enabled: true, port: publicPort, accessTeamDomain: TEAM, accessAud: AUD,
      allowedEmails: [EMAIL], sessionTokenTtlHours: 12, disableFiles: true,
      ...(totpSecret ? { totpSecret } : {}),
      ...(doorPasswordHash ? { passwordHash: doorPasswordHash } : {}),
    },
    _version: 1,
  }));
}

async function boot(dir, publicPort, env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PERSALINK_CONFIG_DIR: dir, PERSALINK_ACCESS_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/certs`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => {
      out += d;
      if (out.includes(`Public door on 127.0.0.1:${publicPort}`) && out.includes('Server running')) { clearTimeout(t); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
}

before(async () => {
  key = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(key.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  }).listen(PORTS.jwks, '127.0.0.1');

  const { hashPassword } = require('../dist/apps/server/src/auth.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-door-int-'));
  writeConfig(path.join(root, 'main'), { port: PORTS.tailnet, publicPort: PORTS.public, passwordHash: await hashPassword(PASSWORD), totpSecret: TOTP_SECRET });
  writeConfig(path.join(root, 'setup'), { port: PORTS.setupTailnet, publicPort: PORTS.setupPublic });
  await boot(path.join(root, 'main'), PORTS.public);
  await boot(path.join(root, 'setup'), PORTS.setupPublic);
  writeConfig(path.join(root, 'grace'), { port: PORTS.graceTailnet, publicPort: PORTS.gracePublic, passwordHash: await hashPassword(PASSWORD), totpSecret: TOTP_SECRET, doorPasswordHash: await hashPassword(DOOR_PASSWORD) });
  await boot(path.join(root, 'grace'), PORTS.gracePublic, { PERSALINK_PUBLIC_GRACE_MS: String(GRACE_MS) });
});

after(() => {
  for (const c of children) c.kill('SIGTERM');
  jwksServer?.close();
});

function jwt(claims = {}) {
  return new jose.SignJWT({ email: EMAIL, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime('10m')
    .sign(key.privateKey);
}

function get(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open a WS and collect messages; resolves { ws, next(type) } or { status } if refused. */
function connect(port, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
    });
    const next = (type) => {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        waiters.push({ type, resolve: res });
        setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), 10000);
      });
    };
    ws.on('open', () => resolve({ ws, next, send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on('unexpected-response', (_, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => {});
  });
}

const { codeAt } = require('../dist/apps/server/src/totp.js');
const nowStep = () => Math.floor(Date.now() / 30000);

async function login(port, headers, extra = {}) {
  const c = await connect(port, headers);
  assert.ok(c.ws, `connection refused (${c.status})`);
  await c.next('auth.required');
  c.send({ type: 'auth', password: PASSWORD, ...extra });
  return { ...c, ok: await c.next('auth.ok') };
}

// A code is single-use (replay guard), so the suite makes ONE public password
// login and opens every other public tab with its token — the same thing a
// second browser tab does.
let publicToken;
async function publicLogin(headers) {
  if (!publicToken) {
    const c = await login(PORTS.public, headers, { totp: codeAt(TOTP_SECRET, nowStep()) });
    publicToken = c.ok.token;
    return c;
  }
  return publicTab(headers, publicToken);
}

async function publicTab(headers, token) {
  const c = await connect(PORTS.public, headers);
  assert.ok(c.ws, `connection refused (${c.status})`);
  await c.next('auth.required');
  c.send({ type: 'auth.token', token });
  return { ...c, ok: { ...(await c.next('auth.ok')), token } };
}

test('public door refuses HTTP without a valid Access JWT', async () => {
  assert.equal((await get(PORTS.public, '/')).statusCode, 403);
  assert.equal((await get(PORTS.public, '/', { 'cf-access-jwt-assertion': 'garbage' })).statusCode, 403);
  assert.equal((await get(PORTS.public, '/', { 'cf-access-jwt-assertion': await jwt({ email: 'x@evil.com' }) })).statusCode, 403);
});

test('public door serves the app with a valid JWT and marks the door', async () => {
  const res = await get(PORTS.public, '/', { 'cf-access-jwt-assertion': await jwt() });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['set-cookie']), /pl_door=public/);
  assert.equal((await get(PORTS.tailnet, '/')).headers['set-cookie'], undefined);
});

test('files are refused on the public door even with a valid JWT', async () => {
  const h = { 'cf-access-jwt-assertion': await jwt() };
  assert.equal((await get(PORTS.public, '/api/upload', h, 'POST')).statusCode, 403);
  assert.equal((await get(PORTS.public, '/api/files/list?path=~', h)).statusCode, 403);
});

test('public door refuses a WebSocket upgrade without a valid JWT', async () => {
  assert.equal((await connect(PORTS.public)).status, 403);
  assert.equal((await connect(PORTS.public, { 'cf-access-jwt-assertion': await jwt({ email: 'x@evil.com' }) })).status, 403);
});

test('a public password login needs a second step, and a code works once', async () => {
  const h = { 'cf-access-jwt-assertion': await jwt() };
  const c = await connect(PORTS.public, h);
  const req = await c.next('auth.required');
  assert.deepEqual(req.secondFactor, { push: false, totp: true });
  c.send({ type: 'auth', password: PASSWORD });
  assert.match((await c.next('auth.failed')).message, /second step/i);
  c.send({ type: 'auth', password: PASSWORD, approval: true }); // no phone subscribed
  assert.match((await c.next('auth.failed')).message, /second step/i);
  c.send({ type: 'auth', password: PASSWORD, totp: codeAt(TOTP_SECRET, nowStep() + 5) });
  assert.match((await c.next('auth.failed')).message, /wrong or expired code/i);
  c.ws.close();

  const code = codeAt(TOTP_SECRET, nowStep());
  const ok = await login(PORTS.public, h, { totp: code });
  assert.equal(ok.ok.door, 'public');
  publicToken = ok.ok.token;
  const replay = await connect(PORTS.public, h);
  await replay.next('auth.required');
  replay.send({ type: 'auth', password: PASSWORD, totp: code });
  assert.match((await replay.next('auth.failed')).message, /wrong or expired code/i);
  replay.ws.close();
  ok.ws.close();
});

test('the tailnet door never asks for a second step', async () => {
  const c = await connect(PORTS.tailnet);
  assert.equal((await c.next('auth.required')).secondFactor, undefined);
  c.ws.close();
});

test('phone answers are accepted only on the tailnet door', async () => {
  const body = JSON.stringify({ id: 'nope', secret: 'nope', decision: 'approve' });
  const post = (port, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/approval', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: d }));
    });
    r.on('error', reject); r.end(body);
  });
  const tail = await post(PORTS.tailnet);
  assert.equal(tail.status, 404);
  assert.deepEqual(JSON.parse(tail.body), { ok: false });
  const pub = await post(PORTS.public, { 'cf-access-jwt-assertion': await jwt() });
  // Not the endpoint: at most the app shell falls through.
  assert.doesNotMatch(String(pub.type), /json/);
  assert.doesNotMatch(pub.body, /"ok"/);
});

test('logins are bound to their door and public ones are short', async () => {
  const pub = await publicLogin({ 'cf-access-jwt-assertion': await jwt() });
  assert.equal(pub.ok.door, 'public');
  assert.equal(pub.ok.disableFiles, true);
  const tail = await login(PORTS.tailnet);
  assert.equal(tail.ok.door, 'tailnet');

  // A public token is useless on the tailnet door, and vice versa.
  const t1 = await connect(PORTS.tailnet);
  await t1.next('auth.required');
  t1.send({ type: 'auth.token', token: pub.ok.token });
  assert.match((await t1.next('auth.failed')).message, /Invalid or expired/);
  const t2 = await connect(PORTS.public, { 'cf-access-jwt-assertion': await jwt() });
  await t2.next('auth.required');
  t2.send({ type: 'auth.token', token: tail.ok.token });
  assert.match((await t2.next('auth.failed')).message, /Invalid or expired/);

  // The public session sees only public logins.
  pub.send({ type: 'token.list' });
  const list = await pub.next('token.list');
  assert.ok(list.tokens.length >= 1);
  assert.ok(list.tokens.every((t) => /\(public\)$/.test(t.name)), JSON.stringify(list.tokens));

  for (const c of [pub, tail, t1, t2]) c.ws.close();
});

test('public door refuses device tokens, password change, push and revoking device logins', async () => {
  const tail = await login(PORTS.tailnet);
  tail.send({ type: 'token.list' });
  const deviceToken = (await tail.next('token.list')).tokens.find((t) => !/\(public\)$/.test(t.name));
  assert.ok(deviceToken, 'a tailnet device login exists');

  const pub = await publicLogin({ 'cf-access-jwt-assertion': await jwt() });
  const refused = async (msg) => {
    pub.send(msg);
    const err = await pub.next('error');
    assert.equal(err.op, msg.type, JSON.stringify(err));
  };
  await refused({ type: 'token.create', name: 'x' });
  await refused({ type: 'password.change', currentPassword: PASSWORD, newPassword: 'another-pass-2' });
  await refused({ type: 'token.revoke', tokenId: deviceToken.id });
  await refused({ type: 'push.subscribe', subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } } });

  // The tailnet session is untouched.
  tail.send({ type: 'ping' });
  await tail.next('pong');
  pub.ws.close();
  tail.ws.close();
});

test('first-run setup is impossible through the public door', async () => {
  const c = await connect(PORTS.setupPublic, { 'cf-access-jwt-assertion': await jwt() });
  const req = await c.next('auth.required');
  assert.equal(req.setupMode, true);
  c.send({ type: 'auth', password: 'claim-this-box-1' });
  assert.match((await c.next('auth.failed')).message, /no password set/i);
  c.ws.close();
});

test('a public socket is closed when the Access session ends', async () => {
  const shortJwt = await new jose.SignJWT({ email: EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3)
    .sign(key.privateKey);
  const pub = await publicLogin({ 'cf-access-jwt-assertion': shortJwt });
  const code = await new Promise((resolve) => pub.ws.on('close', (c) => resolve(c)));
  assert.equal(code, 4001);
});

test('sign out revokes the login it was made with', async () => {
  const h = { 'cf-access-jwt-assertion': await jwt() };
  const pub = await publicLogin(h);
  const token = pub.ok.token;
  // A second tab on the same login.
  const tab2 = await publicTab(h, token);
  const tab2Closed = new Promise((resolve) => tab2.ws.on('close', (c) => resolve(c)));
  const closed = new Promise((resolve) => pub.ws.on('close', (c) => resolve(c)));
  pub.send({ type: 'auth.logout' });
  await pub.next('auth.loggedOut');
  assert.equal(await closed, 4002);
  assert.equal(await tab2Closed, 4002, 'other tabs on the same login are signed out too');

  const again = await connect(PORTS.public, h);
  await again.next('auth.required');
  again.send({ type: 'auth.token', token });
  assert.match((await again.next('auth.failed')).message, /Invalid or expired/);
  again.ws.close();
});

test('a door-only password replaces the main one on the public door only', async () => {
  const h = { 'cf-access-jwt-assertion': await jwt() };
  const c = await connect(PORTS.gracePublic, h);
  await c.next('auth.required');
  c.send({ type: 'auth', password: PASSWORD, totp: '000000' });
  assert.match((await c.next('auth.failed')).message, /Incorrect password/);
  c.ws.close();
  // The tailnet door still takes the main password, and not the door one.
  const t = await login(PORTS.graceTailnet);
  assert.equal(t.ok.door, 'tailnet');
  // ...and the home password can't be changed to the laptop one.
  t.send({ type: 'password.change', currentPassword: PASSWORD, newPassword: DOOR_PASSWORD });
  assert.match((await t.next('error')).message, /term\.brobata\.com password/);
  t.ws.close();
  const t2 = await connect(PORTS.graceTailnet);
  await t2.next('auth.required');
  t2.send({ type: 'auth', password: DOOR_PASSWORD });
  assert.match((await t2.next('auth.failed')).message, /Incorrect password/);
  t2.ws.close();
});

test('closing the last tab ends a public login unless a tab comes back in time', async () => {
  const h = { 'cf-access-jwt-assertion': await jwt() };
  const c0 = await connect(PORTS.gracePublic, h);
  await c0.next('auth.required');
  c0.send({ type: 'auth', password: DOOR_PASSWORD, totp: codeAt(TOTP_SECRET, nowStep()) });
  const first = { ...c0, ok: await c0.next('auth.ok') };
  const token = first.ok.token;
  const tabAgain = async () => {
    const c = await connect(PORTS.gracePublic, h);
    await c.next('auth.required');
    c.send({ type: 'auth.token', token });
    return c;
  };
  const closeAndWait = (c) => new Promise((resolve) => { c.ws.on('close', resolve); c.ws.close(); });

  // A reload inside the grace keeps the login (and cancels the revoke).
  await closeAndWait(first);
  await new Promise((r) => setTimeout(r, GRACE_MS / 4));
  const back = await tabAgain();
  await back.next('auth.ok');
  await new Promise((r) => setTimeout(r, GRACE_MS * 1.5));
  back.send({ type: 'ping' });
  await back.next('pong');

  // Gone longer than the grace: the login is revoked.
  await closeAndWait(back);
  await new Promise((r) => setTimeout(r, GRACE_MS * 1.5));
  const late = await tabAgain();
  assert.match((await late.next('auth.failed')).message, /Invalid or expired/);
  late.ws.close();
});
