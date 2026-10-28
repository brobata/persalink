/**
 * @file Public door integration test
 * @description Boots the compiled server (needs tmux on PATH) with a public
 *   listener whose Access keys come from a local JWKS server, then drives
 *   real HTTP + WebSocket traffic through both doors: the JWT gate, door-bound
 *   tokens, refused operations, and the first-run setup guard.
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
const base = 20000 + Math.floor(Math.random() * 20000);
const PORTS = { tailnet: base, public: base + 1, jwks: base + 2, setupTailnet: base + 3, setupPublic: base + 4 };

let key, jwksServer;
const children = [];

function writeConfig(dir, { port, publicPort, passwordHash }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port, serverName: 'doortest', passwordHash: passwordHash ?? null,
    security: { bindHost: '127.0.0.1' },
    publicListener: {
      enabled: true, port: publicPort, accessTeamDomain: TEAM, accessAud: AUD,
      allowedEmails: [EMAIL], sessionTokenTtlHours: 12, disableFiles: true,
    },
    _version: 1,
  }));
}

async function boot(dir, publicPort) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PERSALINK_CONFIG_DIR: dir, PERSALINK_ACCESS_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/certs` },
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
  writeConfig(path.join(root, 'main'), { port: PORTS.tailnet, publicPort: PORTS.public, passwordHash: await hashPassword(PASSWORD) });
  writeConfig(path.join(root, 'setup'), { port: PORTS.setupTailnet, publicPort: PORTS.setupPublic });
  await boot(path.join(root, 'main'), PORTS.public);
  await boot(path.join(root, 'setup'), PORTS.setupPublic);
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

async function login(port, headers) {
  const c = await connect(port, headers);
  assert.ok(c.ws, `connection refused (${c.status})`);
  await c.next('auth.required');
  c.send({ type: 'auth', password: PASSWORD });
  return { ...c, ok: await c.next('auth.ok') };
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

test('logins are bound to their door and public ones are short', async () => {
  const pub = await login(PORTS.public, { 'cf-access-jwt-assertion': await jwt() });
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

  const pub = await login(PORTS.public, { 'cf-access-jwt-assertion': await jwt() });
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
  const pub = await login(PORTS.public, { 'cf-access-jwt-assertion': shortJwt });
  const code = await new Promise((resolve) => pub.ws.on('close', (c) => resolve(c)));
  assert.equal(code, 4001);
});

test('sign out revokes the login it was made with', async () => {
  const h = { 'cf-access-jwt-assertion': await jwt() };
  const pub = await login(PORTS.public, h);
  const token = pub.ok.token;
  // A second tab on the same login.
  const tab2 = await connect(PORTS.public, h);
  await tab2.next('auth.required');
  tab2.send({ type: 'auth.token', token });
  await tab2.next('auth.ok');
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
