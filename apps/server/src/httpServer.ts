/**
 * @file HTTP Server
 * @description Serves client static files with SPA fallback, security headers,
 *   caching, compression, and health/status endpoints.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createFileApi, isPathWithin, readJsonBody, type FileApiAuth } from './fileApi';

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
      // blob: — Files previews; media: the Files viewer streams video/audio.
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
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
    /** Token lookups for the Files API (absent: file routes are not served). */
    fileAuth?: FileApiAuth;
    /** Let browsers cache file previews (off on the public door: shared laptops). */
    cacheFiles?: boolean;
    /** Phone's answer to a sign-in approval (tailnet door only). */
    onApproval?: (id: string, secret: string, decision: 'approve' | 'deny') => boolean;
  } = {},
): http.RequestListener {
  const securityHeaders = getSecurityHeaders();
  const files = opts.fileAuth ? createFileApi(opts.fileAuth, { cache: opts.cacheFiles !== false }) : null;

  const listener: http.RequestListener = (req, res) => {
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

    if (files?.handle(urlPath, req, res)) return;

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

  // A throw anywhere in a handler must never take the whole server (and
  // every terminal) down with it.
  return (req, res) => {
    try {
      listener(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
    }
  };
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
