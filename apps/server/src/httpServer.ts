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
      const authHeader = req.headers['authorization'];
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token || !validateAuthToken?.(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }

      const uploadDir = path.join(os.homedir(), 'shared', 'persalink-uploads');
      fs.mkdirSync(uploadDir, { recursive: true });

      // Parse multipart form data (simple single-file parser)
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
        return;
      }

      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing boundary' }));
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      const MAX_SIZE = 50 * 1024 * 1024; // 50MB limit

      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File too large (max 50MB)' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          const body = Buffer.concat(chunks);
          const boundary = '--' + boundaryMatch![1];
          const bodyStr = body.toString('binary');

          // Find the file content between boundaries
          const parts = bodyStr.split(boundary);
          let fileName = '';
          let fileContent: Buffer | null = null;

          for (const part of parts) {
            if (!part.includes('Content-Disposition')) continue;
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) continue;

            const headers = part.slice(0, headerEnd);
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            if (!filenameMatch) continue;

            fileName = filenameMatch[1];
            // Extract binary content after headers
            const contentStart = headerEnd + 4;
            const contentEnd = part.lastIndexOf('\r\n');
            const rawContent = part.slice(contentStart, contentEnd > contentStart ? contentEnd : undefined);
            fileContent = Buffer.from(rawContent, 'binary');
            break;
          }

          if (!fileName || !fileContent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No file found in upload' }));
            return;
          }

          // Sanitize filename and add timestamp to avoid collisions
          const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const timestamp = Date.now();
          const ext = path.extname(safeName);
          const base = path.basename(safeName, ext);
          const finalName = `${base}_${timestamp}${ext}`;
          const filePath = path.join(uploadDir, finalName);

          fs.writeFileSync(filePath, fileContent);

          const serverPath = filePath.replace(os.homedir(), '~');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            path: serverPath,
            absolutePath: filePath,
            name: finalName,
            size: fileContent.length,
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upload failed' }));
        }
      });
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
