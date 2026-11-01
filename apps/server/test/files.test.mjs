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
let live = true; // flips to simulate a signed-out login

before(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-files-')));
  process.env.HOME = home;
  process.env.PERSALINK_CONFIG_DIR = path.join(home, '.persalink');
  fs.mkdirSync(path.join(home, 'shared'));
  const { createHttpHandler } = require('../dist/apps/server/src/httpServer.js');
  const fileAuth = {
    resolveToken: (t) => (t === TOKEN && live ? { id: 'tid-1', hash: 'hash-1' } : null),
    liveTokenHash: (id) => (id === 'tid-1' && live ? 'hash-1' : null),
  };
  server = http.createServer(createHttpHandler(home, undefined, (t) => t === TOKEN, undefined, { fileAuth }));
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

async function listing(dir) {
  const res = await fetch(`${base}/api/files/list?path=${encodeURIComponent(dir)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  return res.json();
}

function signed(route, link, extra) {
  const q = new URLSearchParams({ dir: link.dir, tid: link.tid, exp: String(link.exp), sig: link.sig });
  for (const [k, v] of extra) q.append(k, v);
  return `${base}/api/files/${route}?${q}`;
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

test('signed links stream files with ranges, and die with the login', async () => {
  fs.mkdirSync(path.join(home, 'shared', 'media'));
  fs.writeFileSync(path.join(home, 'shared', 'media', 'clip.mp4'), '0123456789');
  fs.writeFileSync(path.join(home, 'shared', 'media', 'page.html'), '<script>alert(1)</script>');
  const { link, entries } = await listing('~/shared/media');
  assert.deepEqual(entries.map((e) => e.name).sort(), ['clip.mp4', 'page.html']);

  const whole = await fetch(signed('raw', link, [['name', 'clip.mp4']]));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(await whole.text(), '0123456789');

  const part = await fetch(signed('raw', link, [['name', 'clip.mp4']]), { headers: { Range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await part.text(), '234');

  // A page in the folder never runs as the app: plain text, sandboxed.
  const page = await fetch(signed('raw', link, [['name', 'page.html']]));
  assert.match(page.headers.get('content-type'), /^text\/plain/);
  assert.match(page.headers.get('content-security-policy'), /sandbox/);

  // The link reaches only its own folder, can't be edited, and dies at sign-out.
  assert.equal((await fetch(signed('raw', link, [['name', '../a.txt']]))).status, 400);
  assert.equal((await fetch(signed('raw', { ...link, dir: path.join(home, 'shared') }, [['name', 'c.txt']]))).status, 403);
  assert.equal((await fetch(signed('raw', { ...link, exp: link.exp + 1 }, [['name', 'clip.mp4']]))).status, 403);
  live = false;
  try {
    assert.equal((await fetch(signed('raw', link, [['name', 'clip.mp4']]))).status, 403);
  } finally {
    live = true;
  }
});

test('zip downloads several items', async () => {
  const { link } = await listing('~/shared/media');
  const res = await fetch(signed('zip', link, [['n', 'clip.mp4'], ['n', 'page.html']]));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /media\.zip/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.ok(bytes.includes(Buffer.from('clip.mp4')));
  assert.equal((await fetch(signed('zip', link, [['n', '-x']]))).status, 404);
});

test('copy and move never overwrite and refuse a folder into itself', async () => {
  fs.mkdirSync(path.join(home, 'shared', 'dest'));
  fs.writeFileSync(path.join(home, 'shared', 'dest', 'clip.mp4'), 'already here');
  let res = await post('copy', { paths: ['~/shared/media/clip.mp4'], to: '~/shared/dest' });
  let body = await res.json();
  assert.equal(body.done[0].renamed, true);
  assert.equal(fs.readFileSync(path.join(home, 'shared', 'dest', 'clip.mp4'), 'utf8'), 'already here');
  assert.equal(fs.readFileSync(path.join(home, 'shared', 'dest', 'clip (1).mp4'), 'utf8'), '0123456789');

  res = await post('move', { paths: ['~/shared/media/page.html', '~/shared/media'], to: '~/shared/media' });
  body = await res.json();
  assert.equal(body.failed[0].error, 'cannot go inside itself');
  res = await post('move', { paths: ['~/shared/media/page.html'], to: '~/shared/dest' });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(home, 'shared', 'dest', 'page.html')));
  assert.equal(fs.existsSync(path.join(home, 'shared', 'media', 'page.html')), false);

  // Nothing new goes into the config folder, and it can't be moved out.
  assert.equal((await post('copy', { paths: ['~/shared/dest/page.html'], to: '~/.persalink' })).status, 400);
  body = await (await post('move', { paths: ['~/.persalink/config.json'], to: '~/shared' })).json();
  assert.equal(body.failed[0].error, 'cannot be moved from here');
});

test('save refuses to clobber a file that changed since it was opened', async () => {
  assert.equal((await post('newfile', { path: '~/shared', name: 'notes.txt' })).status, 200);
  assert.equal((await post('newfile', { path: '~/shared', name: 'notes.txt' })).status, 409);
  const file = path.join(home, 'shared', 'notes.txt');
  fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01')); // so the save visibly moves it
  const mtime = Math.floor(fs.statSync(file).mtimeMs);
  let res = await post('save', { path: '~/shared/notes.txt', content: 'v1', mtime });
  assert.equal(res.status, 200);
  assert.notEqual((await res.json()).mtime, mtime);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1');
  res = await post('save', { path: '~/shared/notes.txt', content: 'stale', mtime });
  assert.equal(res.status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1');
  assert.equal((await post('save', { path: '~/.persalink/config.json', content: '{}' })).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(home, 'shared')).filter((n) => n.includes('.persalink-')), []);
});

test('a malformed request path is refused without taking the server down', async () => {
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '//' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.ok(status < 500);
  assert.equal((await fetch(`${base}/api/files/list?path=~`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
});

test('a non-ASCII signature is refused, not thrown', async () => {
  const { link } = await listing('~/shared');
  const res = await fetch(signed('raw', { ...link, sig: 'é'.repeat(link.sig.length) }, [['name', 'c.txt']]));
  assert.equal(res.status, 403);
});

test('a cancelled upload leaves nothing behind', async () => {
  const boundary = 'xBOUNDARYx';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="half.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST',
      path: `/api/upload?dir=${encodeURIComponent('~/shared')}`,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': 10_000_000 },
    });
    req.on('error', () => resolve());
    req.write(head);
    req.write(Buffer.alloc(200_000, 1), () => setTimeout(() => { req.destroy(); resolve(); }, 100));
  });
  for (let i = 0; i < 50 && fs.existsSync(path.join(home, 'shared', 'half.bin')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.existsSync(path.join(home, 'shared', 'half.bin')), false);
});

test('saving through a symlink edits the real file and keeps the link', async () => {
  fs.writeFileSync(path.join(home, 'real.txt'), 'old');
  fs.symlinkSync(path.join(home, 'real.txt'), path.join(home, 'shared', 'linked.txt'));
  const res = await post('save', { path: '~/shared/linked.txt', content: 'new' });
  assert.equal(res.status, 200);
  assert.ok(fs.lstatSync(path.join(home, 'shared', 'linked.txt')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(home, 'real.txt'), 'utf8'), 'new');
});
