/**
 * @file HTTP Server
 * @description Serves client static files with SPA fallback, security headers,
 *   caching, compression, and health/status endpoints.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as os from 'os';
import * as crypto from 'crypto';
import Busboy from 'busboy';
import { audit } from './auditLog';
import { CONFIG_DIR } from './config';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const COMPRESSIBLE_TYPES = new Set([
  'text/html', 'application/javascript', 'text/css',
  'application/json', 'image/svg+xml',
]);

function isPathWithin(baseDir: string, targetPath: string): boolean {
  // Use resolve (not realpath) so non-existent files aren't rejected as path traversal
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

export interface ServerInfo {
  serverName: string;
  port: number;
  tmuxVersion: string;
  activeSessions: number;
}

function getSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: wss: http: https:",
      "img-src 'self' data:",
      // data: — the variable-font pipeline inlines some subset fonts as data
      // URIs; without it the console fills with CSP violations on every load.
      "font-src 'self' data:",
      "worker-src 'self' blob:",
    ].join('; '),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function hasContentHash(filePath: string): boolean {
  const basename = path.basename(filePath);
  return /\.[a-zA-Z0-9_-]{6,}\.\w+$/.test(basename) && !basename.endsWith('.html');
}

export function createHttpHandler(
  staticDir: string,
  getServerInfo?: () => ServerInfo,
  validateAuthToken?: (token: string) => boolean,
  getPinnedProfiles?: () => Array<{ id: string; name: string }>,
  opts: {
    disableFiles?: boolean;
    /** Phone's answer to a sign-in approval (tailnet door only). */
    onApproval?: (id: string, secret: string, decision: 'approve' | 'deny') => boolean;
  } = {},
): http.RequestListener {
  const securityHeaders = getSecurityHeaders();

  return (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) {
      res.setHeader(key, value);
    }

    const url = req.url || '/';
    const urlPath = url.split('?')[0];

    // Same-origin only. The client is served from this same origin, so it never
    // needs cross-origin CORS. We previously reflected any Origin back as
    // Access-Control-Allow-Origin (effectively `*`), which bought nothing and
    // widened the surface. The upload endpoint is token-authenticated regardless.
    if (urlPath.startsWith('/health') || urlPath.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (urlPath === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    if (urlPath === '/api/server-info' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      // Hostname + tmux version are recon material — authenticated callers only.
      const authHeader = req.headers['authorization'];
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token || !validateAuthToken?.(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      if (getServerInfo) {
        const info = getServerInfo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
      return;
    }

    // Sign-in approval answer from the phone's service worker. Authorized by
    // the one-time secret that only reached the phone (inside the encrypted
    // push), so no bearer token — the SW can't read the app's storage.
    if (urlPath === '/api/approval' && req.method === 'POST' && opts.onApproval) {
      readJsonBody(req, 4096).then((body) => {
        const b = body as { id?: unknown; secret?: unknown; decision?: unknown } | null;
        const ok = !!b && typeof b.id === 'string' && typeof b.secret === 'string'
          && (b.decision === 'approve' || b.decision === 'deny')
          && opts.onApproval!(b.id, b.secret, b.decision);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }

    // Public door with files off: refuse before any auth or body parsing.
    if (opts.disableFiles && (urlPath === '/api/upload' || urlPath.startsWith('/api/files/'))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File access is disabled on this connection' }));
      return;
    }

    // File upload endpoint (requires authentication)
    if (urlPath === '/api/upload' && req.method === 'POST') {
      handleUpload(req, res, validateAuthToken);
      return;
    }

    // File browser endpoints (multi-track roadmap Track 4 — File-Share's
    // core ported behind PersaLink token auth). Read-only: list + download/
    // preview. Scope is the server user's own permissions — the terminal
    // already grants full shell access, so this adds convenience, not power.
    if (urlPath === '/api/files/list' && req.method === 'GET') {
      handleFilesList(req, res, validateAuthToken);
      return;
    }
    if (urlPath === '/api/files/download' && req.method === 'GET') {
      handleFileDownload(req, res, validateAuthToken);
      return;
    }
    if ((urlPath === '/api/files/mkdir' || urlPath === '/api/files/rename' || urlPath === '/api/files/delete')
        && req.method === 'POST') {
      handleFileChange(urlPath.slice('/api/files/'.length) as FileChange, req, res, validateAuthToken);
      return;
    }

    // Dynamic manifest: the static manifest plus app shortcuts for pinned
    // profiles (Android long-press the icon → jump straight into a session
    // via the /?profile= deep link the client already understands).
    if (urlPath === '/manifest.webmanifest' && req.method === 'GET') {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(staticDir, 'manifest.webmanifest'), 'utf-8'));
        const pinned = getPinnedProfiles ? getPinnedProfiles().slice(0, 4) : [];
        if (pinned.length > 0) {
          manifest.shortcuts = pinned.map((p) => ({
            name: p.name,
            short_name: p.name.slice(0, 12),
            url: `/?profile=${encodeURIComponent(p.id)}`,
            icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
          }));
        }
        res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(manifest));
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
      return;
    }

    // Static file serving — skip if static dir doesn't exist
    if (!fs.existsSync(staticDir)) {
      res.writeHead(404);
      res.end('Client not built yet. Run: cd apps/client && npm run build');
      return;
    }

    let filePath = path.join(staticDir, urlPath);
    const resolved = path.resolve(filePath);
    const resolvedStaticDir = path.resolve(staticDir);
    if (!isPathWithin(resolvedStaticDir, resolved)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    filePath = resolved;

    fs.stat(filePath, (err, stats) => {
      if (!err && stats.isFile()) {
        serveFile(filePath, req, res);
        return;
      }
      // SPA fallback
      const indexPath = path.join(staticDir, 'index.html');
      fs.stat(indexPath, (indexErr) => {
        if (!indexErr) {
          serveFile(indexPath, req, res, true);
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
    });
  };
}

/** Small JSON body or null (too big, not JSON). Never rejects. */
function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
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

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_UPLOAD_FILES = 20;              // per request

interface UploadedFile {
  name: string;
  path: string;          // ~-relative, pasted into the terminal
  absolutePath: string;
  size: number;
}

/**
 * Stream a multipart upload to ~/shared/persalink-uploads using busboy.
 * Handles multiple files per request, enforces a per-file size cap by
 * streaming (never buffering whole files in memory), and returns the saved
 * paths in upload order. Replaces the old hand-rolled boundary parser.
 */
// ---------------------------------------------------------------------------
// File browser (read-only) — guards ported from the File-Share app
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/plain', '.json': 'application/json',
  '.js': 'text/plain', '.ts': 'text/plain', '.sh': 'text/plain', '.yml': 'text/plain',
  '.yaml': 'text/plain', '.toml': 'text/plain', '.conf': 'text/plain', '.env': 'text/plain',
  '.csv': 'text/plain', '.html': 'text/plain', '.css': 'text/plain', '.py': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
};

/** Expand ~, resolve, and require an absolute path. Authenticated users
 *  already have full shell access as this user; normalization here is about
 *  predictability, not privilege. */
function resolveBrowsePath(raw: string | null): string | null {
  let p = (raw || '~').trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) return null;
  return path.resolve(p);
}

function checkBearer(req: http.IncomingMessage, res: http.ServerResponse, validateAuthToken?: (token: string) => boolean): boolean {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !validateAuthToken?.(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return false;
  }
  return true;
}

function handleFilesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  validateAuthToken?: (token: string) => boolean,
): void {
  if (!checkBearer(req, res, validateAuthToken)) return;
  const query = new URL(req.url || '/', 'http://x').searchParams;
  const dir = resolveBrowsePath(query.get('path'));
  if (!dir) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Path must be absolute (or ~)' }));
    return;
  }
  try {
    const names = fs.readdirSync(dir).slice(0, 2000);
    const entries = names.map((name) => {
      try {
        const st = fs.statSync(path.join(dir, name));
        return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
      } catch {
        return { name, type: 'file', size: 0, mtime: 0 }; // broken symlink etc.
      }
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ path: dir, entries }));
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Cannot read directory' }));
  }
}

function handleFileDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  validateAuthToken?: (token: string) => boolean,
): void {
  if (!checkBearer(req, res, validateAuthToken)) return;
  const query = new URL(req.url || '/', 'http://x').searchParams;
  const file = resolveBrowsePath(query.get('path'));
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Path must be absolute (or ~)' }));
    return;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  if (!st.isFile()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not a file' }));
    return;
  }
  const inline = query.get('inline') === '1';
  audit('file_download', { name: file, method: inline ? 'inline' : 'attachment' });
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(path.basename(file))}"`,
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
  stream.pipe(res);
}

/** A single path segment: no separators, not `.`/`..`, no control chars. */
function isPlainName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 255
    && name !== '.' && name !== '..' && !/[/\\\x00-\x1f]/.test(name);
}

const TRASH_DIR = path.join(CONFIG_DIR, 'trash');

/** True if anything (even a broken symlink) already has this path. */
function pathTaken(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}
const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

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

type FileChange = 'mkdir' | 'rename' | 'delete';

/**
 * New folder, rename, and delete for the Files screen. Same scope as the
 * terminal (this user's permissions). Delete moves the item into
 * ~/.persalink/trash (kept 30 days) so a mis-tap on a phone is recoverable.
 */
function handleFileChange(
  action: FileChange,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  validateAuthToken?: (token: string) => boolean,
): void {
  if (!checkBearer(req, res, validateAuthToken)) return;
  const reply = (status: number, body: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  readJsonBody(req, 8192).then((body) => {
    const b = (body ?? {}) as { path?: unknown; name?: unknown };
    const target = typeof b.path === 'string' ? resolveBrowsePath(b.path) : null;
    if (!target) { reply(400, { error: 'Path must be absolute (or ~)' }); return; }
    const home = os.homedir();
    try {
      if (action === 'mkdir') {
        if (!isPlainName(b.name)) { reply(400, { error: 'Folder names cannot contain /' }); return; }
        const dir = path.join(target, b.name);
        fs.mkdirSync(dir);
        audit('file_mkdir', { name: dir });
        reply(200, { path: dir });
        return;
      }
      // rename + delete act on an existing item; never the root, home, or the
      // server's own config folder (losing config.json = setup mode, no password)
      if (target === '/' || target === home
          || isPathWithin(CONFIG_DIR, target) || isPathWithin(target, CONFIG_DIR)) {
        reply(400, { error: 'That folder cannot be changed from here' });
        return;
      }
      fs.lstatSync(target); // ENOENT → 404 below
      if (action === 'rename') {
        if (!isPlainName(b.name)) { reply(400, { error: 'Names cannot contain /' }); return; }
        const dest = path.join(path.dirname(target), b.name);
        if (dest === target) { reply(200, { path: dest }); return; }
        // renameSync silently replaces an existing file — refuse instead
        if (pathTaken(dest)) { reply(409, { error: `${b.name} already exists` }); return; }
        fs.renameSync(target, dest);
        audit('file_rename', { name: target, path: dest });
        reply(200, { path: dest });
        return;
      }
      const now = Date.now();
      fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 });
      let trashed = path.join(TRASH_DIR, `${now}-${path.basename(target)}`);
      // renameSync would replace an earlier trashed item with the same name
      for (let n = 1; pathTaken(trashed); n++) trashed = path.join(TRASH_DIR, `${now}-${n}-${path.basename(target)}`);
      fs.renameSync(target, trashed);
      audit('file_delete', { name: target, path: trashed });
      purgeTrash(now);
      reply(200, { trash: trashed.replace(home, '~') });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') reply(404, { error: 'Not found' });
      else if (code === 'EEXIST') reply(409, { error: 'That name is already taken' });
      else if (code === 'EACCES' || code === 'EPERM') reply(403, { error: 'Permission denied' });
      else if (code === 'EXDEV') reply(400, { error: 'That is on another drive — delete it from the terminal' });
      else reply(500, { error: 'Could not change that file' });
    }
  });
}

/** `name`, or `name (1)`, `name (2)`… — the first one not already in `dir`. */
function freeName(dir: string, name: string, taken: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    if (!taken.has(candidate) && !pathTaken(path.join(dir, candidate))) return candidate;
  }
}

function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  validateAuthToken?: (token: string) => boolean,
): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !validateAuthToken?.(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
    return;
  }

  // ?dir= → the Files screen uploading into the folder on screen, keeping the
  // file's own name. Without it: the terminal's paste-a-path drop folder.
  const dirParam = new URL(req.url || '/', 'http://x').searchParams.get('dir');
  const intoFolder = dirParam !== null;
  const uploadDir = intoFolder ? resolveBrowsePath(dirParam) : path.join(os.homedir(), 'shared', 'persalink-uploads');
  if (!uploadDir) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Path must be absolute (or ~)' }));
    return;
  }
  try {
    if (intoFolder) {
      if (!fs.statSync(uploadDir).isDirectory()) throw new Error('not a folder');
    } else {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
  } catch (err) {
    res.writeHead(intoFolder ? 404 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: intoFolder ? 'Folder not found' : 'Could not create upload directory' }));
    return;
  }
  const claimed = new Set<string>(); // names given out in this request

  let bb: ReturnType<typeof Busboy>;
  try {
    bb = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_UPLOAD_SIZE, files: MAX_UPLOAD_FILES },
    });
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed multipart request' }));
    return;
  }

  const pending: Promise<UploadedFile | null>[] = [];
  // Per-request counter so files arriving in the same millisecond don't collide.
  let seq = 0;
  let tooLarge = false;
  let writeFailed: string | null = null; // why a file could not be saved, for the reply
  let responded = false;

  const fail = (status: number, error: string) => {
    if (responded) return;
    responded = true;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
    req.unpipe(bb);
    req.resume(); // drain the rest so the socket isn't left hanging
  };

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
    pending.push(new Promise<UploadedFile | null>((resolve) => {
      // Only remove what this request created — with 'wx' a failed open means
      // the name belongs to someone else's file.
      const cleanupAndFail = () => { if (opened) fs.unlink(filePath, () => {}); stream.resume(); resolve(null); };
      writeStream.on('error', (err: NodeJS.ErrnoException) => {
        writeFailed = err.code === 'EEXIST' ? `${finalName} appeared while uploading — try again`
          : err.code === 'EACCES' ? 'Permission denied in that folder' : 'Could not save the file';
        cleanupAndFail();
      });
      stream.on('error', cleanupAndFail);
      writeStream.on('close', () => {
        // Over-limit file is partial garbage — discard it rather than hand back
        // a truncated path the user would unknowingly use.
        if (truncated) { cleanupAndFail(); return; }
        resolve({
          name: finalName,
          path: filePath.replace(os.homedir(), '~'),
          absolutePath: filePath,
          size,
        });
      });
    }));

    stream.pipe(writeStream);
  });

  bb.on('error', () => fail(400, 'Upload parse error'));

  bb.on('close', async () => {
    const files = (await Promise.all(pending)).filter((f): f is UploadedFile => f !== null);
    if (responded) return;

    if (files.length === 0) {
      res.writeHead(tooLarge ? 413 : writeFailed ? 500 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: tooLarge ? 'File too large (max 50MB per file)' : writeFailed ?? 'No file found in upload' }));
      return;
    }

    responded = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      paths: files.map((f) => f.path),
      files,
      // Back-compat: single-file callers can still read `.path`.
      path: files[0].path,
      partial: tooLarge, // true if some file(s) were dropped for exceeding the cap
    }));
  });

  req.pipe(bb);
}

function serveFile(
  filePath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  isSpaFallback: boolean = false
): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (isSpaFallback || ext === '.html') {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (hasContentHash(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  const acceptEncoding = (req.headers['accept-encoding'] || '') as string;
  const canGzip = acceptEncoding.includes('gzip') && COMPRESSIBLE_TYPES.has(contentType);

  fs.stat(filePath, (statErr, stats) => {
    if (statErr) {
      res.writeHead(500);
      res.end('Internal Server Error');
      return;
    }

    if (canGzip && stats.size > 1024) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
      });
      const stream = fs.createReadStream(filePath);
      const gzip = zlib.createGzip();
      stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      gzip.on('error', () => res.end());
      stream.pipe(gzip).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size.toString(),
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      stream.pipe(res);
    }
  });
}
