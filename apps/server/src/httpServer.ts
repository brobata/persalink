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

  const uploadDir = path.join(os.homedir(), 'shared', 'persalink-uploads');
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not create upload directory' }));
    return;
  }

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

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext) || 'file';
    const finalName = `${base}_${Date.now()}_${seq++}${ext}`;
    const filePath = path.join(uploadDir, finalName);

    let truncated = false;
    let size = 0;
    stream.on('data', (d: Buffer) => { size += d.length; });
    stream.on('limit', () => { truncated = true; tooLarge = true; });

    const writeStream = fs.createWriteStream(filePath);
    pending.push(new Promise<UploadedFile | null>((resolve) => {
      const cleanupAndFail = () => { fs.unlink(filePath, () => {}); resolve(null); };
      writeStream.on('error', cleanupAndFail);
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
      res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: tooLarge ? 'File too large (max 50MB per file)' : 'No file found in upload' }));
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
