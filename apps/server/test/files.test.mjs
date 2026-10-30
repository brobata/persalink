/**
 * @file Files screen endpoint tests
 * @description New folder, rename, delete-to-trash and upload-into-folder,
 *   against the compiled server (`npm test` builds first). HOME points at a
 *   throwaway folder so the trash and audit log never touch the real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const TOKEN = 'good-token';
let home, server, base;

before(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-files-')));
  process.env.HOME = home;
  process.env.PERSALINK_CONFIG_DIR = path.join(home, '.persalink');
  fs.mkdirSync(path.join(home, 'shared'));
  const { createHttpHandler } = require('../dist/apps/server/src/httpServer.js');
  server = http.createServer(createHttpHandler(home, undefined, (t) => t === TOKEN));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function post(action, body, token = TOKEN) {
  return fetch(`${base}/api/files/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function upload(dir, files) {
  const form = new FormData();
  for (const [name, text] of files) form.append('file', new Blob([text]), name);
  return fetch(`${base}/api/upload?dir=${encodeURIComponent(dir)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form,
  });
}

test('changes need a valid token', async () => {
  const res = await post('mkdir', { path: '~/shared', name: 'x' }, 'wrong');
  assert.equal(res.status, 401);
  assert.equal(fs.existsSync(path.join(home, 'shared', 'x')), false);
});

test('new folder; names with / or .. are refused', async () => {
  assert.equal((await post('mkdir', { path: '~/shared', name: 'Menus' })).status, 200);
  assert.ok(fs.statSync(path.join(home, 'shared', 'Menus')).isDirectory());
  assert.equal((await post('mkdir', { path: '~/shared', name: 'Menus' })).status, 409);
  for (const name of ['a/b', '..', '.', '']) {
    assert.equal((await post('mkdir', { path: '~/shared', name })).status, 400, name);
  }
});

test('rename never replaces an existing file', async () => {
  fs.writeFileSync(path.join(home, 'shared', 'a.txt'), 'A');
  fs.writeFileSync(path.join(home, 'shared', 'b.txt'), 'B');
  assert.equal((await post('rename', { path: '~/shared/a.txt', name: 'b.txt' })).status, 409);
  assert.equal(fs.readFileSync(path.join(home, 'shared', 'b.txt'), 'utf8'), 'B');
  assert.equal((await post('rename', { path: '~/shared/a.txt', name: '../escape.txt' })).status, 400);
  fs.symlinkSync(path.join(home, 'nowhere'), path.join(home, 'shared', 'dangling'));
  assert.equal((await post('rename', { path: '~/shared/a.txt', name: 'dangling' })).status, 409);
  assert.equal((await post('rename', { path: '~/shared/a.txt', name: 'c.txt' })).status, 200);
  assert.equal(fs.readFileSync(path.join(home, 'shared', 'c.txt'), 'utf8'), 'A');
  assert.equal((await post('rename', { path: '~/shared/missing', name: 'z' })).status, 404);
});

test('delete moves to the trash; home and the trash itself are off limits', async () => {
  fs.mkdirSync(path.join(home, 'shared', 'old'));
  fs.writeFileSync(path.join(home, 'shared', 'old', 'f.txt'), 'keep me');
  const res = await post('delete', { path: '~/shared/old' });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.join(home, 'shared', 'old')), false);
  const trash = path.join(home, '.persalink', 'trash');
  const [entry] = fs.readdirSync(trash);
  assert.match(entry, /^\d+-old$/);
  assert.equal(fs.readFileSync(path.join(trash, entry, 'f.txt'), 'utf8'), 'keep me');
  fs.writeFileSync(path.join(home, '.persalink', 'config.json'), '{}');
  for (const p of ['~', '/', '~/.persalink', '~/.persalink/config.json', '~/.persalink/trash', `~/.persalink/trash/${entry}`]) {
    assert.equal((await post('delete', { path: p })).status, 400, p);
  }
  assert.equal((await post('rename', { path: '~', name: 'x' })).status, 400);
  assert.equal((await post('rename', { path: '~/.persalink/config.json', name: 'x.json' })).status, 400);
  assert.ok(fs.existsSync(path.join(home, '.persalink', 'config.json')));
});

test('deleting the same name twice keeps both in the trash', async () => {
  const trash = path.join(home, '.persalink', 'trash');
  const before = fs.readdirSync(trash).length;
  for (const text of ['first', 'second']) {
    fs.writeFileSync(path.join(home, 'shared', 'twin.txt'), text);
    assert.equal((await post('delete', { path: '~/shared/twin.txt' })).status, 200);
  }
  const twins = fs.readdirSync(trash).filter((n) => n.endsWith('twin.txt'));
  assert.equal(fs.readdirSync(trash).length, before + 2);
  assert.deepEqual(twins.map((n) => fs.readFileSync(path.join(trash, n), 'utf8')).sort(), ['first', 'second']);
});

test('trash older than 30 days is purged on the next delete', async () => {
  const trash = path.join(home, '.persalink', 'trash');
  const stale = path.join(trash, `${Date.now() - 31 * 24 * 60 * 60 * 1000}-stale`);
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(home, 'shared', 'gone.txt'), '');
  assert.equal((await post('delete', { path: '~/shared/gone.txt' })).status, 200);
  for (let i = 0; i < 50 && fs.existsSync(stale); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.existsSync(stale), false);
});

test('upload into a folder keeps names and never overwrites', async () => {
  fs.writeFileSync(path.join(home, 'shared', 'menu.pdf'), 'original');
  const res = await upload('~/shared', [['menu.pdf', 'new 1'], ['menu.pdf', 'new 2'], ['../evil.txt', 'x']]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.files.map((f) => f.name), ['menu (1).pdf', 'menu (2).pdf', 'evil.txt']);
  assert.equal(fs.readFileSync(path.join(home, 'shared', 'menu.pdf'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(home, 'shared', 'menu (2).pdf'), 'utf8'), 'new 2');
  assert.equal(fs.existsSync(path.join(home, 'evil.txt')), false);
  assert.equal((await upload('~/shared/nope', [['a.txt', 'a']])).status, 404);
});

test('upload without a folder still goes to the terminal drop folder', async () => {
  const form = new FormData();
  form.append('file', new Blob(['hi']), 'shot.png');
  const res = await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  assert.equal(res.status, 200);
  const { paths } = await res.json();
  assert.match(paths[0], /^~\/shared\/persalink-uploads\/shot_\d+_0\.png$/);
});
