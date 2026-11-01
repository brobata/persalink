/**
 * @file File manager API
 * @description Everything behind the Files screen: list, upload, new folder /
 *   file, rename, copy, move, delete (to trash), save text, and downloads.
 *   Scope is this user's own permissions — a signed-in device already has a
 *   full shell, so this adds convenience, not power. Two guards are about
 *   mistakes, not privilege: nothing is ever overwritten (names get " (1)"),
 *   and PersaLink's own config folder can't be changed from here (losing
 *   config.json means setup mode with no password).
 *
 *   <img>/<video>/<a download> can't send a bearer header, so a listing also
 *   returns a signed link for its folder: HMAC over (token id, folder, expiry,
 *   token hash). It dies with the login (revoke / sign-out / expiry) and at
 *   the hour mark after next, and only reaches that folder.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import Busboy from 'busboy';
import { audit } from './auditLog';
import { CONFIG_DIR } from './config';

export interface FileApiAuth {
  /** Bearer token → its id + hash when valid on this door (counts as use). */
  resolveToken: (token: string) => { id: string; hash: string } | null;
  /** Token id → hash while that login is still live on this door. */
  liveTokenHash: (id: string) => string | null;
}

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_UPLOAD_FILES = 20;              // per request
const MAX_SAVE_BYTES = 2 * 1024 * 1024;   // text editor
const MAX_LIST = 5000;
const HOUR_MS = 60 * 60 * 1000;
const TRASH_DIR = path.join(CONFIG_DIR, 'trash');
const TRASH_KEEP_MS = 30 * 24 * HOUR_MS;

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/plain', '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
};
// Anything a browser would run as a page is served as plain text when shown inline.
// (SVG stays an image: <img> never runs its scripts, and opened in a tab the
// sandbox CSP below keeps it away from the app.)
const ACTIVE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml']);

// ---------------------------------------------------------------------------
// Shared helpers (httpServer imports these too)
// ---------------------------------------------------------------------------

export function isPathWithin(baseDir: string, targetPath: string): boolean {
  // Use resolve (not realpath) so non-existent files aren't rejected as path traversal
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

/** Small JSON body or null (too big, not JSON). Never rejects. */
export function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Expand ~, resolve, and require an absolute path. */
function resolveBrowsePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim() || '~';
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) return null;
  return path.resolve(p);
}

/** A single path segment: no separators, not `.`/`..`, no control chars. */
function isPlainName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 255
    && name !== '.' && name !== '..' && !/[/\\\x00-\x1f]/.test(name);
}

/** True if anything (even a broken symlink) already has this path. */
function pathTaken(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** `name`, or `name (1)`, `name (2)`… — the first one not already in `dir`. */
function freeName(dir: string, name: string, taken: Set<string> = new Set()): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    if (!taken.has(candidate) && !pathTaken(path.join(dir, candidate))) return candidate;
  }
}

/** Never changed from here: the root, home, and PersaLink's config folder
 *  (plus every folder above it — renaming ~ would take it along). */
function isProtected(target: string): boolean {
  return target === '/' || target === os.homedir()
    || isPathWithin(CONFIG_DIR, target) || isPathWithin(target, CONFIG_DIR);
}

/** Destinations for new things: anywhere but the config folder. */
function isWritableDir(dir: string): boolean {
  return !isPathWithin(CONFIG_DIR, dir);
}

function errorReply(res: http.ServerResponse, err: unknown, fallback: string): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') sendJson(res, 404, { error: 'Not found' });
  else if (code === 'EEXIST') sendJson(res, 409, { error: 'That name is already taken' });
  else if (code === 'EACCES' || code === 'EPERM') sendJson(res, 403, { error: 'Permission denied' });
  else if (code === 'ENOTDIR') sendJson(res, 400, { error: 'Not a folder' });
  else if (code === 'ENOSPC') sendJson(res, 507, { error: 'The server disk is full' });
  else sendJson(res, 500, { error: fallback });
}

/** Drop trash older than 30 days. Best effort — a failure just waits for next time. */
function purgeTrash(now: number): void {
  let names: string[];
  try { names = fs.readdirSync(TRASH_DIR); } catch { return; }
  for (const name of names) {
    const stamp = Number(name.split('-', 1)[0]);
    if (Number.isFinite(stamp) && now - stamp > TRASH_KEEP_MS) {
      fs.rm(path.join(TRASH_DIR, name), { recursive: true, force: true }, () => {});
    }
  }
}

/** rename, falling back to copy + remove across drives. */
async function moveItem(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

/** Single `bytes=a-b` range (all a browser's <video> ever asks for). */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (m[1] === '') { // suffix: last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return { start, end };
}

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

export interface FileApi {
  /** Handles the request if it is a file route; false otherwise. */
  handle(urlPath: string, req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createFileApi(auth: FileApiAuth, { cache = true }: { cache?: boolean } = {}): FileApi {
  // Per process + per door: a restart, or the other door, invalidates links.
  const signKey = crypto.randomBytes(32);

  const sign = (tid: string, hash: string, dir: string, exp: number) =>
    crypto.createHmac('sha256', signKey).update(`${tid}\n${hash}\n${dir}\n${exp}`).digest('base64url');

  /** Valid bearer → token, else replies 401. */
  const bearer = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const resolved = token ? auth.resolveToken(token) : null;
    if (!resolved) sendJson(res, 401, { error: 'Authentication required' });
    return resolved;
  };

  /** Signed folder link from the query → the folder, else replies 403. */
  const signedDir = (q: URLSearchParams, res: http.ServerResponse): string | null => {
    const dir = q.get('dir') ?? '';
    const tid = q.get('tid') ?? '';
    const exp = Number(q.get('exp'));
    const sig = q.get('sig') ?? '';
    const hash = tid ? auth.liveTokenHash(tid) : null;
    const want = hash && Number.isFinite(exp) && exp > Date.now() ? sign(tid, hash, dir, exp) : null;
    const got = Buffer.from(sig);
    const expected = want ? Buffer.from(want) : null;
    // Byte lengths: a non-ASCII sig can match in characters but not bytes.
    if (!expected || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('This link has expired — reopen the folder.');
      return null;
    }
    return dir;
  };

  const list = (req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams) => {
    const tok = bearer(req, res);
    if (!tok) return;
    const dir = resolveBrowsePath(q.get('path') ?? '~');
    if (!dir) { sendJson(res, 400, { error: 'Path must be absolute (or ~)' }); return; }
    fs.promises.readdir(dir, { withFileTypes: true }).then(async (dirents) => {
      const truncated = dirents.length > MAX_LIST;
      const entries = await Promise.all(dirents.slice(0, MAX_LIST).map(async (d) => {
        const full = path.join(dir, d.name);
        try {
          const st = await fs.promises.stat(full);
          return { name: d.name, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: Math.floor(st.mtimeMs), link: d.isSymbolicLink() };
        } catch {
          return { name: d.name, type: 'file', size: 0, mtime: 0, link: d.isSymbolicLink(), broken: true };
        }
      }));
      // Expiry on the hour after next: stable URLs for an hour, so the
      // browser's cache keeps thumbnails across re-listings.
      const exp = (Math.floor(Date.now() / HOUR_MS) + 2) * HOUR_MS;
      sendJson(res, 200, {
        path: dir,
        home: os.homedir(),
        parent: dir === '/' ? null : path.dirname(dir),
        readOnly: !isWritableDir(dir),
        truncated,
        entries,
        link: { dir, tid: tok.id, exp, sig: sign(tok.id, tok.hash, dir, exp) },
      });
    }, (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') sendJson(res, 400, { error: 'Not a folder' });
      else if (code === 'EACCES' || code === 'EPERM') sendJson(res, 403, { error: 'Permission denied' });
      else sendJson(res, 404, { error: 'Folder not found' });
    });
  };

  /** One file from a signed folder link: inline (img/video/audio/pdf/text) or ?dl=1. */
  const raw = (req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams) => {
    const dir = signedDir(q, res);
    if (dir === null) return;
    const name = q.get('name');
    if (!isPlainName(name)) { sendJson(res, 400, { error: 'Bad file name' }); return; }
    const file = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { sendJson(res, 404, { error: 'Not found' }); return; }
    if (!st.isFile()) { sendJson(res, 400, { error: 'Not a file' }); return; }

    const download = q.get('dl') === '1';
    let mime = MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
    if (!download && ACTIVE_TYPES.has(mime)) mime = 'text/plain';
    if (!download && mime === 'application/octet-stream' && st.size <= MAX_SAVE_BYTES) mime = 'text/plain';
    if (mime.startsWith('text/')) mime += '; charset=utf-8';
    const headers: Record<string, string | number> = {
      'Content-Type': mime,
      'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache ? 'private, max-age=3600' : 'no-store',
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    };
    // Opened in a tab, a file must never run as part of this app's origin.
    // Chrome's PDF viewer refuses sandboxed documents, and PDFs can't reach
    // the page's storage anyway.
    if (!mime.startsWith('application/pdf')) {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
    }
    const range = parseRange(req.headers.range, st.size);
    if (range === 'bad') {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return;
    }
    if (!range) audit('file_download', { name: file, method: download ? 'attachment' : 'inline' });
    const { start, end } = range ?? { start: 0, end: Math.max(0, st.size - 1) };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || st.size === 0) { res.end(); return; }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  /** Several items from a signed folder as one .zip, streamed by the zip CLI. */
  const zip = (_req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams) => {
    const dir = signedDir(q, res);
    if (dir === null) return;
    const names = q.getAll('n');
    if (names.length === 0 || names.length > 2000 || !names.every(isPlainName)) {
      sendJson(res, 400, { error: 'Bad file names' });
      return;
    }
    if (!names.every((n) => pathTaken(path.join(dir, n)))) { sendJson(res, 404, { error: 'Not found' }); return; }
    const label = names.length === 1 ? names[0] : (path.basename(dir) || 'files');
    audit('file_download', { name: dir, method: 'zip', count: names.length });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', `${label}.zip`),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    // -y stores symlinks as links (no reaching outside through them);
    // ./ keeps a name like "-x" from being read as an option.
    const child = spawn('zip', ['-q', '-r', '-y', '-', ...names.map((n) => `./${n}`)], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(res);
    child.on('error', () => res.destroy());
    child.on('close', (code) => { if (code !== 0 && code !== 18) res.destroy(); }); // 18 = some files unreadable
    res.on('close', () => { if (child.exitCode === null) child.kill(); });
  };

  /** Bearer download by path (text previews and older clients). */
  const download = (req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams) => {
    if (!bearer(req, res)) return;
    const file = resolveBrowsePath(q.get('path'));
    if (!file) { sendJson(res, 400, { error: 'Path must be absolute (or ~)' }); return; }
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { sendJson(res, 404, { error: 'Not found' }); return; }
    if (!st.isFile()) { sendJson(res, 400, { error: 'Not a file' }); return; }
    const inline = q.get('inline') === '1';
    if (!inline) audit('file_download', { name: file, method: 'attachment' });
    res.writeHead(200, {
      'Content-Type': MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', path.basename(file)),
      'Last-Modified': st.mtime.toUTCString(),
      'X-File-Mtime': String(Math.floor(st.mtimeMs)),
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  /** JSON-body changes. Each validates its own fields. */
  const change = (action: string, req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!bearer(req, res)) return;
    const limit = action === 'save' ? MAX_SAVE_BYTES * 2 + 4096 : 256 * 1024;
    readJsonBody(req, limit).then(async (body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      try {
        switch (action) {
          case 'mkdir':
          case 'newfile': {
            const parent = resolveBrowsePath(b.path);
            if (!parent) { sendJson(res, 400, { error: 'Path must be absolute (or ~)' }); return; }
            if (!isPlainName(b.name)) { sendJson(res, 400, { error: 'Names cannot contain /' }); return; }
            if (!isWritableDir(parent)) { sendJson(res, 400, { error: 'That folder cannot be changed from here' }); return; }
            const target = path.join(parent, b.name);
            if (action === 'mkdir') fs.mkdirSync(target);
            else fs.writeFileSync(target, '', { flag: 'wx' });
            audit(action === 'mkdir' ? 'file_mkdir' : 'file_save', { name: target });
            sendJson(res, 200, { path: target });
            return;
          }
          case 'rename': {
            const target = resolveBrowsePath(b.path);
            if (!target) { sendJson(res, 400, { error: 'Path must be absolute (or ~)' }); return; }
            if (isProtected(target)) { sendJson(res, 400, { error: 'That folder cannot be changed from here' }); return; }
            if (!isPlainName(b.name)) { sendJson(res, 400, { error: 'Names cannot contain /' }); return; }
            fs.lstatSync(target);
            const dest = path.join(path.dirname(target), b.name);
            if (dest === target) { sendJson(res, 200, { path: dest }); return; }
            // renameSync silently replaces an existing file — refuse instead
            if (pathTaken(dest)) { sendJson(res, 409, { error: `${b.name} already exists` }); return; }
            fs.renameSync(target, dest);
            audit('file_rename', { name: target, path: dest });
            sendJson(res, 200, { path: dest });
            return;
          }
          case 'delete': {
            const target = resolveBrowsePath(b.path);
            if (!target) { sendJson(res, 400, { error: 'Path must be absolute (or ~)' }); return; }
            if (isProtected(target)) { sendJson(res, 400, { error: 'That folder cannot be changed from here' }); return; }
            fs.lstatSync(target);
            const now = Date.now();
            fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 });
            let trashed = path.join(TRASH_DIR, `${now}-${path.basename(target)}`);
            // renameSync would replace an earlier trashed item with the same name
            for (let n = 1; pathTaken(trashed); n++) trashed = path.join(TRASH_DIR, `${now}-${n}-${path.basename(target)}`);
            try {
              fs.renameSync(target, trashed);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
                sendJson(res, 400, { error: 'That is on another drive — delete it from the terminal' });
                return;
              }
              throw err;
            }
            audit('file_delete', { name: target, path: trashed });
            purgeTrash(now);
            sendJson(res, 200, { trash: trashed.replace(os.homedir(), '~') });
            return;
          }
          case 'copy':
          case 'move': {
            const to = resolveBrowsePath(b.to);
            const sources = Array.isArray(b.paths) ? b.paths.map(resolveBrowsePath) : [];
            if (!to || sources.length === 0 || sources.length > 500 || sources.some((s) => !s)) {
              sendJson(res, 400, { error: 'Pick what to move and where' });
              return;
            }
            if (!fs.statSync(to).isDirectory()) { sendJson(res, 400, { error: 'Not a folder' }); return; }
            if (!isWritableDir(to)) { sendJson(res, 400, { error: 'That folder cannot be changed from here' }); return; }
            const done: { from: string; to: string; renamed: boolean }[] = [];
            const failed: { from: string; error: string }[] = [];
            const claimed = new Set<string>();
            for (const src of sources as string[]) {
              const base = path.basename(src);
              if (action === 'move' && isProtected(src)) { failed.push({ from: src, error: 'cannot be moved from here' }); continue; }
              if (isPathWithin(src, to)) { failed.push({ from: src, error: 'cannot go inside itself' }); continue; }
              if (action === 'move' && path.dirname(src) === to) continue; // already here
              try {
                fs.lstatSync(src);
                const name = freeName(to, base, claimed);
                claimed.add(name);
                const dest = path.join(to, name);
                if (action === 'move') await moveItem(src, dest);
                else await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
                done.push({ from: src, to: dest, renamed: name !== base });
              } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                failed.push({ from: src, error: code === 'ENOENT' ? 'not found' : code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code === 'ENOSPC' ? 'disk full' : 'failed' });
              }
            }
            audit(action === 'move' ? 'file_rename' : 'file_copy', { name: to, count: done.length });
            sendJson(res, failed.length && !done.length ? 400 : 200, { done, failed });
            return;
          }
          case 'save': {
            const asked = resolveBrowsePath(b.path);
            if (!asked || typeof b.content !== 'string') { sendJson(res, 400, { error: 'Nothing to save' }); return; }
            // Write the file a symlink points at, so the link survives the save.
            const target = fs.realpathSync(asked);
            if (!isWritableDir(path.dirname(target)) || isProtected(target)) { sendJson(res, 400, { error: 'That file cannot be changed from here' }); return; }
            if (Buffer.byteLength(b.content) > MAX_SAVE_BYTES) { sendJson(res, 413, { error: 'Too big to save from here (2 MB max)' }); return; }
            const st = fs.statSync(target);
            if (!st.isFile()) { sendJson(res, 400, { error: 'Not a file' }); return; }
            // tmp + rename would split a hard link from its other names.
            if (st.nlink > 1) { sendJson(res, 400, { error: 'That file has other names (hard links) — edit it in the terminal' }); return; }
            // Someone (or something) changed it since it was opened — don't clobber.
            if (typeof b.mtime === 'number' && Math.floor(st.mtimeMs) !== b.mtime) {
              sendJson(res, 409, { error: 'It changed on the server since you opened it — reopen to see the new version' });
              return;
            }
            // Write beside it, then swap: a crash mid-write never leaves half a file.
            const tmp = path.join(path.dirname(target), `.${path.basename(target)}.persalink-${process.pid}-${Date.now()}`);
            fs.writeFileSync(tmp, b.content, { mode: st.mode & 0o7777, flag: 'wx' });
            try { fs.renameSync(tmp, target); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
            audit('file_save', { name: target });
            sendJson(res, 200, { mtime: Math.floor(fs.statSync(target).mtimeMs) });
            return;
          }
        }
      } catch (err) {
        errorReply(res, err, 'Could not change that file');
      }
    });
  };

  const upload = (req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams) => {
    if (!bearer(req, res)) return;
    if (!(req.headers['content-type'] || '').includes('multipart/form-data')) {
      sendJson(res, 400, { error: 'Expected multipart/form-data' });
      return;
    }
    // ?dir= → the Files screen uploading into the folder on screen, keeping
    // the file's own name. Without it: the terminal's paste-a-path drop folder.
    const dirParam = q.get('dir');
    const intoFolder = dirParam !== null;
    const uploadDir = intoFolder ? resolveBrowsePath(dirParam) : path.join(os.homedir(), 'shared', 'persalink-uploads');
    if (!uploadDir) { sendJson(res, 400, { error: 'Path must be absolute (or ~)' }); return; }
    try {
      if (intoFolder) {
        if (!fs.statSync(uploadDir).isDirectory()) throw new Error('not a folder');
      } else {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
    } catch {
      sendJson(res, intoFolder ? 404 : 500, { error: intoFolder ? 'Folder not found' : 'Could not create upload directory' });
      return;
    }
    if (intoFolder && !isWritableDir(uploadDir)) { sendJson(res, 400, { error: 'That folder cannot be changed from here' }); return; }

    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE, files: MAX_UPLOAD_FILES } });
    } catch {
      sendJson(res, 400, { error: 'Malformed multipart request' });
      return;
    }

    interface Saved { name: string; path: string; absolutePath: string; size: number }
    const pending: Promise<Saved | null>[] = [];
    const claimed = new Set<string>(); // names given out in this request
    let seq = 0; // so files arriving in the same millisecond don't collide
    let tooLarge = false;
    let writeFailed: string | null = null; // why a file could not be saved, for the reply
    let responded = false;
    // Files still being written. A cancelled or dropped upload never reaches
    // busboy's 'close', so those files would sit there truncated under the
    // real name: remove them when the connection goes away first.
    const open = new Map<fs.WriteStream, () => boolean>();
    res.on('close', () => {
      if (responded) return;
      responded = true;
      for (const [ws, wasOpened] of open) {
        const file = ws.path as string;
        ws.destroy();
        if (wasOpened()) fs.unlink(file, () => {});
      }
      open.clear();
    });

    bb.on('file', (_field, stream, info) => {
      const filename = info.filename;
      // A form field with no filename (or busboy's files-limit reached) — skip it.
      if (!filename) { stream.resume(); return; }

      let finalName: string;
      if (intoFolder) {
        const own = path.basename(filename.replace(/\\/g, '/'));
        finalName = freeName(uploadDir, isPlainName(own) ? own : 'file', claimed);
        claimed.add(finalName);
      } else {
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext) || 'file';
        finalName = `${base}_${Date.now()}_${seq++}${ext}`;
      }
      const filePath = path.join(uploadDir, finalName);

      let truncated = false;
      let size = 0;
      stream.on('data', (d: Buffer) => { size += d.length; });
      stream.on('limit', () => { truncated = true; tooLarge = true; });

      // 'wx': never overwrite — freeName checked, this closes the race
      const writeStream = fs.createWriteStream(filePath, { flags: 'wx' });
      let opened = false;
      writeStream.on('open', () => { opened = true; });
      open.set(writeStream, () => opened);
      writeStream.on('close', () => open.delete(writeStream));
      pending.push(new Promise<Saved | null>((resolve) => {
        // Only remove what this request created — with 'wx' a failed open means
        // the name belongs to someone else's file.
        const cleanupAndFail = () => { if (opened) fs.unlink(filePath, () => {}); stream.resume(); resolve(null); };
        writeStream.on('error', (err: NodeJS.ErrnoException) => {
          writeFailed = err.code === 'EEXIST' ? `${finalName} appeared while uploading — try again`
            : err.code === 'EACCES' ? 'Permission denied in that folder'
            : err.code === 'ENOSPC' ? 'The server disk is full' : 'Could not save the file';
          cleanupAndFail();
        });
        stream.on('error', cleanupAndFail);
        writeStream.on('close', () => {
          // Over-limit file is partial garbage — discard it rather than hand back
          // a truncated path the user would unknowingly use.
          if (truncated) { cleanupAndFail(); return; }
          if (!opened) return; // error path already resolved
          resolve({ name: finalName, path: filePath.replace(os.homedir(), '~'), absolutePath: filePath, size });
        });
      }));
      stream.pipe(writeStream);
    });

    bb.on('error', () => {
      if (responded) return;
      responded = true;
      sendJson(res, 400, { error: 'Upload parse error' });
      req.unpipe(bb);
      req.resume(); // drain the rest so the socket isn't left hanging
    });

    bb.on('close', async () => {
      const files = (await Promise.all(pending)).filter((f): f is Saved => f !== null);
      if (responded) return;
      responded = true;
      if (files.length === 0) {
        sendJson(res, tooLarge ? 413 : writeFailed ? 500 : 400, {
          error: tooLarge ? 'File too large (max 50MB per file)' : writeFailed ?? 'No file found in upload',
        });
        return;
      }
      if (intoFolder) audit('file_upload', { name: uploadDir, count: files.length });
      sendJson(res, 200, {
        paths: files.map((f) => f.path),
        files,
        path: files[0].path, // back-compat: single-file callers read `.path`
        partial: tooLarge, // true if some file(s) were dropped for exceeding the cap
      });
    });

    req.pipe(bb);
  };

  return {
    handle(urlPath, req, res) {
      if (urlPath !== '/api/upload' && !urlPath.startsWith('/api/files/')) return false;
      let q: URLSearchParams;
      try {
        q = new URL(req.url || '/', 'http://x').searchParams;
      } catch {
        sendJson(res, 400, { error: 'Bad request' });
        return true;
      }
      const get = req.method === 'GET' || req.method === 'HEAD';
      if (urlPath === '/api/upload' && req.method === 'POST') { upload(req, res, q); return true; }
      if (!urlPath.startsWith('/api/files/')) return false;
      const action = urlPath.slice('/api/files/'.length);
      if (get && action === 'list') list(req, res, q);
      else if (get && action === 'raw') raw(req, res, q);
      else if (get && action === 'zip') zip(req, res, q);
      else if (get && action === 'download') download(req, res, q);
      else if (req.method === 'POST' && ['mkdir', 'newfile', 'rename', 'delete', 'copy', 'move', 'save'].includes(action)) change(action, req, res);
      else return false;
      return true;
    },
  };
}
