/**
 * @file betaClient.test.mjs
 * @description The /beta/ preview client: served from its own folder with its
 *   own SPA fallback, never escaping it, and absent when no betaDir is given.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
let root, withBeta, without, base, baseNoBeta;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-beta-')));
  process.env.PERSALINK_CONFIG_DIR = path.join(root, '.persalink');
  const main = path.join(root, 'dist');
  const beta = path.join(root, 'dist-beta');
  fs.mkdirSync(path.join(beta, 'assets'), { recursive: true });
  fs.mkdirSync(main);
  fs.writeFileSync(path.join(main, 'index.html'), 'MAIN');
  fs.writeFileSync(path.join(beta, 'index.html'), 'BETA');
  fs.writeFileSync(path.join(beta, 'assets', 'app.abc123.js'), 'BETAJS');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
  const { createHttpHandler } = require('../dist/apps/server/src/httpServer.js');
  withBeta = http.createServer(createHttpHandler(main, undefined, undefined, undefined, { betaDir: beta }));
  without = http.createServer(createHttpHandler(main));
  await new Promise((r) => withBeta.listen(0, '127.0.0.1', r));
  await new Promise((r) => without.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${withBeta.address().port}`;
  baseNoBeta = `http://127.0.0.1:${without.address().port}`;
});

after(() => { withBeta.close(); without.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('/beta redirects to /beta/, which serves the preview index', async () => {
  const r = await fetch(`${base}/beta`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/beta/');
  assert.equal(await (await fetch(`${base}/beta/`)).text(), 'BETA');
});

test('preview assets and SPA fallback come from the preview folder', async () => {
  assert.equal(await (await fetch(`${base}/beta/assets/app.abc123.js`)).text(), 'BETAJS');
  assert.equal(await (await fetch(`${base}/beta/some/route`)).text(), 'BETA');
});

test('the real client is untouched', async () => {
  assert.equal(await (await fetch(`${base}/`)).text(), 'MAIN');
  assert.equal(await (await fetch(`${base}/anything`)).text(), 'MAIN');
  assert.equal(await (await fetch(`${base}/betamax`)).text(), 'MAIN');
});

test('the preview folder cannot be escaped', async () => {
  for (const p of ['/beta/../secret.txt', '/beta/%2e%2e/secret.txt', '/beta/..%2fsecret.txt']) {
    const body = await (await fetch(base + p)).text();
    assert.notEqual(body, 'SECRET', p);
  }
});

test('without betaDir, /beta/ is just the real SPA', async () => {
  assert.equal(await (await fetch(`${baseNoBeta}/beta/`)).text(), 'MAIN');
});
