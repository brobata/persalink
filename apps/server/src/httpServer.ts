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
      "font-src 'self'",
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
): http.RequestListener {
  const securityHeaders = getSecurityHeaders();

  return (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) {
      res.setHeader(key, value);
    }

    const url = req.url || '/';
    const urlPath = url.split('?')[0];

    // CORS for API endpoints — reflect the request origin (same-origin by default)
    if (urlPath.startsWith('/health') || urlPath.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Vary', 'Origin');
      }
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
