/**
 * @file PersaLink Server — Main Entry Point
 * @description Tmux session orchestrator. WebSocket transport for terminal I/O,
 *   JSON control messages for session/profile management. Each client gets one
 *   attached tmux session at a time, relayed through a PTY bridge.
 */

import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, saveConfig, type ServerConfig } from '../config';
import { TmuxManager, type TmuxSessionBridge } from '../tmuxManager';
import { ProfileManager } from '../profileManager';
import { HealthChecker } from '../healthChecker';
import { createHttpHandler, type ServerInfo } from '../httpServer';
import { TokenStore, hashPassword, verifyPassword, validatePassword } from '../auth';
import { RateLimiter } from '../rateLimiter';
import { audit } from '../auditLog';
import type { ClientMessage, ServerMessage } from '@persalink/shared/protocol';
import { PROTOCOL_VERSION } from '@persalink/shared/protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectedClient {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  ip: string;
  authTimeout: ReturnType<typeof setTimeout> | null;
  tokenName: string | null;
  /** Active PTY bridge to a tmux session (one per client) */
  bridge: TmuxSessionBridge | null;
  /** Which tmux session this client is attached to */
  attachedSession: string | null;
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let config: ServerConfig;
let tmuxManager: TmuxManager;
let profileManager: ProfileManager;
let healthChecker: HealthChecker;
let tokenStore: TokenStore;
let rateLimiter: RateLimiter;
const clients: Map<string, ConnectedClient> = new Map();

const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024;
let settingUpPassword = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(client: ConnectedClient, message: ServerMessage): void {
  try {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      if (message.type === 'session.output') return;
    }
    client.ws.send(JSON.stringify(message));
  } catch { /* client disconnected */ }
}

function broadcastToAuthenticated(message: ServerMessage): void {
  for (const client of clients.values()) {
    if (client.authenticated) {
      send(client, message);
    }
  }
}

async function sendSessionsList(client: ConnectedClient): Promise<void> {
  const sessions = await tmuxManager.listSessions(profileManager.getMap());
  send(client, { type: 'sessions.list', sessions });
}

async function broadcastSessionsList(): Promise<void> {
  const sessions = await tmuxManager.listSessions(profileManager.getMap());
  broadcastToAuthenticated({ type: 'sessions.list', sessions });
}

function detachClient(client: ConnectedClient): void {
  if (client.bridge) {
    // Mark bridge as intentionally detached so onExit doesn't send session.ended
    client.bridge.intentionalDetach = true;
    try { client.bridge.ptyProcess.kill(); } catch { /* best effort */ }
    client.bridge = null;
  }
  client.attachedSession = null;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function sendRateLimited(client: ConnectedClient, rate: { retryAfterMs?: number; permanentLock?: boolean }): void {
  if (rate.permanentLock) {
    send(client, {
      type: 'auth.failed',
      message: 'Server locked after too many failed attempts. Delete ~/.persalink/rate-limits.json on the server to reset, or reinstall.',
      permanentLock: true,
    });
  } else {
    send(client, { type: 'auth.failed', message: 'Too many attempts', retryAfterMs: rate.retryAfterMs });
  }
}

function handleFailedAuth(client: ConnectedClient, method: 'password' | 'token', userMessage: string): void {
  const rate = rateLimiter.recordFailure(client.ip);
  audit('auth_failed', { ip: client.ip, method, failures: rate.failures, permanentLock: rate.permanentLock });
  if (rate.permanentLock) {
    tokenStore.revokeAll();
    audit('permanent_lock', { ip: client.ip, failures: rate.failures });
    sendRateLimited(client, rate);
    return;
  }
  if (!rate.allowed) {
    sendRateLimited(client, rate);
    return;
  }
  send(client, { type: 'auth.failed', message: userMessage });
}

async function handleAuth(client: ConnectedClient, message: ClientMessage): Promise<void> {
  if (message.type === 'auth') {
    const rateResult = rateLimiter.check(client.ip);
    if (!rateResult.allowed) {
      sendRateLimited(client, rateResult);
      return;
    }

    // Setup mode: first connection sets the password
    if (!config.passwordHash && !settingUpPassword) {
      settingUpPassword = true;
      const validationError = validatePassword(message.password);
      if (validationError) {
        settingUpPassword = false;
        send(client, { type: 'auth.failed', message: validationError });
        return;
      }
      config.passwordHash = await hashPassword(message.password);
      saveConfig(config);
      settingUpPassword = false;
      audit('password_set', { ip: client.ip });
    } else if (!config.passwordHash && settingUpPassword) {
      send(client, { type: 'auth.failed', message: 'Password setup in progress, try again' });
      return;
    }

    // Normal password verification
    if (config.passwordHash) {
      const valid = await verifyPassword(message.password, config.passwordHash);
      if (!valid) {
        handleFailedAuth(client, 'password', 'Incorrect password');
        return;
      }
    }

    rateLimiter.recordSuccess(client.ip);
    completeAuth(client, message.tokenName);

  } else if (message.type === 'auth.token') {
    const rateResult = rateLimiter.check(client.ip);
    if (!rateResult.allowed) {
      sendRateLimited(client, rateResult);
      return;
    }
    const stored = tokenStore.validateToken(message.token);
    if (!stored) {
      handleFailedAuth(client, 'token', 'Invalid or expired token');
      return;
    }
    rateLimiter.recordSuccess(client.ip);
    tokenStore.touch(stored.tokenHash);
    client.tokenName = stored.name;
    completeAuth(client, stored.name, true);
  }
}

function completeAuth(client: ConnectedClient, tokenName?: string, skipTokenCreate?: boolean): void {
  client.authenticated = true;
  if (client.authTimeout) {
    clearTimeout(client.authTimeout);
    client.authTimeout = null;
  }
  client.tokenName = tokenName || client.ip;

  let token: string | undefined;
  if (!skipTokenCreate) {
    const name = tokenName || client.ip;
    const { stored, plaintext } = tokenStore.createAccessToken(name, 365);
    token = plaintext;
    audit('token_created', { ip: client.ip, name: stored.name, tokenId: stored.id });
  }

  audit('auth_success', { ip: client.ip, tokenName: client.tokenName });

  send(client, {
    type: 'auth.ok',
    serverName: config.serverName,
    setupMode: false,
    token,
    protocolVersion: PROTOCOL_VERSION,
  });

  // Send current state
  sendSessionsList(client);
  send(client, { type: 'profiles.list', profiles: profileManager.list() });
  send(client, { type: 'health.status', statuses: healthChecker.getStatuses() });
}

// ---------------------------------------------------------------------------
// Message handling (authenticated clients only)
// ---------------------------------------------------------------------------

async function handleMessage(client: ConnectedClient, message: ClientMessage): Promise<void> {
  switch (message.type) {
    // ---- Session management ----
    case 'session.create': {
      const profile = message.profileId ? profileManager.get(message.profileId) : undefined;
      const cols = Math.max(10, Math.min(500, message.cols || 120));
      const rows = Math.max(2, Math.min(200, message.rows || 40));

      try {
        const sessionName = await tmuxManager.createSession(profile || undefined, cols, rows);
        audit('tmux_session_created', { ip: client.ip, sessionId: sessionName, profileId: message.profileId });

        // Auto-attach after creation
        detachClient(client);
        await attachToSession(client, sessionName, cols, rows);
        await broadcastSessionsList();
      } catch (err) {
        send(client, { type: 'error', message: `Failed to create session: ${err instanceof Error ? err.message : err}` });
      }
      break;
    }

    case 'session.attach': {
      if (!message.sessionId.startsWith('pl-')) {
        send(client, { type: 'error', message: 'Cannot attach to non-PersaLink sessions' });
        break;
      }
      const cols = Math.max(10, Math.min(500, message.cols || 120));
      const rows = Math.max(2, Math.min(200, message.rows || 40));
      // 0 = no prefill (fastest, current default); cap at tmux history-limit.
      const scrollbackLines = Math.max(0, Math.min(10000, message.scrollbackLines ?? 0));

      try {
        detachClient(client);
        await attachToSession(client, message.sessionId, cols, rows, scrollbackLines);
      } catch (err) {
        send(client, { type: 'error', message: `Failed to attach: ${err instanceof Error ? err.message : err}` });
      }
      break;
    }

    case 'session.detach': {
      detachClient(client);
      send(client, { type: 'session.detached' });
      break;
    }

    case 'session.input': {
      if (client.bridge) {
        try { client.bridge.ptyProcess.write(message.data); } catch { /* ignore */ }
      }
      break;
    }

    case 'session.resize': {
      const cols = Math.max(10, Math.min(500, message.cols));
      const rows = Math.max(2, Math.min(200, message.rows));
      if (client.bridge) {
        try { client.bridge.ptyProcess.resize(cols, rows); } catch { /* ignore */ }
      }
      break;
    }

    case 'session.kill': {
      try {
        // If this client is attached to the session being killed, detach first
        if (client.attachedSession === message.sessionId) {
          detachClient(client);
          send(client, { type: 'session.detached' });
        }
        // Also detach any other clients attached to this session
        for (const c of clients.values()) {
          if (c.attachedSession === message.sessionId) {
            detachClient(c);
            send(c, { type: 'session.detached' });
          }
        }
        await tmuxManager.killSession(message.sessionId);
        audit('tmux_session_killed', { ip: client.ip, sessionId: message.sessionId });
        await broadcastSessionsList();
      } catch (err) {
        send(client, { type: 'error', message: `Failed to kill session: ${err instanceof Error ? err.message : err}` });
      }
      break;
    }

    case 'session.rename': {
      try {
        await tmuxManager.renameSession(message.sessionId, message.name);
        audit('tmux_session_renamed', { ip: client.ip, sessionId: message.sessionId, name: message.name });
        await broadcastSessionsList();
      } catch (err) {
        send(client, { type: 'error', message: `Failed to rename session: ${err instanceof Error ? err.message : err}` });
      }
      break;
    }

    case 'sessions.list': {
      await sendSessionsList(client);
      break;
    }

    // ---- Scrollback ----
    case 'session.scrollback': {
      if (client.attachedSession) {
        const lines = Math.min(message.lines || 2000, 10000);
        const data = await tmuxManager.captureScrollback(client.attachedSession, lines);
        send(client, { type: 'session.scrollback', data });
      }
      break;
    }

    // ---- Window management ----
    case 'window.select': {
      if (client.attachedSession) {
        await tmuxManager.selectWindow(client.attachedSession, message.windowIndex);
        const windows = await tmuxManager.listWindows(client.attachedSession);
        send(client, { type: 'windows.list', windows });
      }
      break;
    }

    case 'window.rename': {
      if (client.attachedSession) {
        await tmuxManager.renameWindow(client.attachedSession, message.windowIndex, message.name);
        const windows = await tmuxManager.listWindows(client.attachedSession);
        send(client, { type: 'windows.list', windows });
      }
      break;
    }

    case 'window.create': {
      if (client.attachedSession) {
        await tmuxManager.createWindow(client.attachedSession, message.name);
        const windows = await tmuxManager.listWindows(client.attachedSession);
        send(client, { type: 'windows.list', windows });
      }
      break;
    }

    case 'window.kill': {
      if (client.attachedSession) {
        try {
          await tmuxManager.killWindow(client.attachedSession, message.windowIndex);
          const windows = await tmuxManager.listWindows(client.attachedSession);
          if (windows.length === 0) {
            // Last window killed — session is gone
            detachClient(client);
            send(client, { type: 'session.ended', sessionId: client.attachedSession });
            await broadcastSessionsList();
          } else {
            send(client, { type: 'windows.list', windows });
          }
        } catch (err) {
          send(client, { type: 'error', message: `Failed to close tab: ${err instanceof Error ? err.message : err}` });
        }
      }
      break;
    }

    // ---- Quick actions ----
    case 'action.run': {
      const profile = profileManager.get(message.profileId);
      if (!profile?.actions) {
        send(client, { type: 'error', message: 'Profile has no actions' });
        break;
      }
      const action = profile.actions.find(a => a.id === message.actionId);
      if (!action) {
        send(client, { type: 'error', message: 'Action not found' });
        break;
      }
      audit('action_executed', { ip: client.ip, profileId: message.profileId, actionId: message.actionId });
      const result = await tmuxManager.runAction(action.command, profile.cwd);
      send(client, {
        type: 'action.result',
        actionId: action.id,
        profileId: message.profileId,
        output: result.output,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        spawnError: result.spawnError,
      });
      break;
    }

    // ---- Profile management ----
    case 'profiles.list': {
      send(client, { type: 'profiles.list', profiles: profileManager.list() });
      break;
    }

    case 'profile.save': {
      const error = profileManager.upsert(message.profile);
      if (error) {
        send(client, { type: 'error', message: error });
      } else {
        broadcastToAuthenticated({ type: 'profiles.list', profiles: profileManager.list() });
        healthChecker.start(profileManager.list());
      }
      break;
    }

    case 'profile.delete': {
      profileManager.delete(message.profileId);
      broadcastToAuthenticated({ type: 'profiles.list', profiles: profileManager.list() });
      healthChecker.start(profileManager.list());
      break;
    }

    case 'profile.reorder': {
      profileManager.reorder(message.profileIds);
      broadcastToAuthenticated({ type: 'profiles.list', profiles: profileManager.list() });
      break;
    }

    case 'profile.discover': {
      const discovered = await profileManager.discover();
      send(client, { type: 'profiles.discovered', profiles: discovered });
      audit('profiles_discovered', { ip: client.ip, count: discovered.length });
      break;
    }

    // ---- Health ----
    case 'health.status': {
      send(client, { type: 'health.status', statuses: healthChecker.getStatuses() });
      break;
    }

    // ---- Token management ----
    case 'token.list': {
      const tokens = tokenStore.list().map(t => ({
        id: t.id, name: t.name, createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt,
      }));
      send(client, { type: 'token.list', tokens });
      break;
    }

    case 'token.create': {
      const name = (message.name || '').slice(0, 100) || `Token (${client.ip})`;
      const { stored, plaintext } = tokenStore.createAccessToken(name, message.ttlDays);
      send(client, {
        type: 'token.created', token: plaintext, tokenId: stored.id,
        name: stored.name, expiresAt: stored.expiresAt,
      });
      audit('token_created', { ip: client.ip, name: stored.name, tokenId: stored.id });
      break;
    }

    case 'token.revoke': {
      const revoked = tokenStore.revoke(message.tokenId);
      if (revoked) {
        send(client, { type: 'token.revoked', tokenId: message.tokenId });
        audit('token_revoked', { ip: client.ip, tokenId: message.tokenId });
      }
      break;
    }

    // ---- Password management ----
    case 'password.change': {
      if (!config.passwordHash) {
        send(client, { type: 'error', message: 'No password set' });
        break;
      }
      const valid = await verifyPassword(message.currentPassword, config.passwordHash);
      if (!valid) {
        send(client, { type: 'error', message: 'Current password is incorrect' });
        break;
      }
      const validationError = validatePassword(message.newPassword);
      if (validationError) {
        send(client, { type: 'error', message: validationError });
        break;
      }
      config.passwordHash = await hashPassword(message.newPassword);
      saveConfig(config);
      tokenStore.revokeAll();
      const name = client.tokenName || client.ip;
      const { plaintext } = tokenStore.createAccessToken(name, 365);
      send(client, { type: 'password.changed', token: plaintext });
      for (const c of clients.values()) {
        if (c.id !== client.id && c.authenticated) {
          send(c, { type: 'auth.failed', message: 'Password changed — please re-authenticate' });
          c.ws.close(4001, 'Password changed');
        }
      }
      audit('password_changed', { ip: client.ip });
      break;
    }

    // ---- Keepalive ----
    case 'ping': {
      send(client, { type: 'pong' });
      break;
    }

    default: {
      send(client, { type: 'error', message: `Unknown message type: ${(message as any).type}` });
    }
  }
}

// ---------------------------------------------------------------------------
// Tmux Attach Bridge
// ---------------------------------------------------------------------------

async function attachToSession(
  client: ConnectedClient,
  sessionName: string,
  cols: number,
  rows: number,
  scrollbackLines: number = 0,
): Promise<void> {
  // Tmux can need a tick to register a freshly-created session under load.
  // Retry briefly before declaring it gone — fixes the phantom-session bug
  // where session.create succeeded but the immediate attach failed.
  let exists = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    exists = await tmuxManager.sessionExists(sessionName);
    if (exists) break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 50));
  }
  if (!exists) {
    throw new Error(`Session ${sessionName} does not exist`);
  }

  let bridge: ReturnType<typeof tmuxManager.attachBridge> | null = null;
  try {
    // Set aggressive resize so our PTY size wins
    await tmuxManager.resizeSession(sessionName);

    // Capture only what the client asked for. 0 = skip the tmux call entirely.
    const scrollback = scrollbackLines > 0
      ? await tmuxManager.captureScrollback(sessionName, scrollbackLines)
      : '';

    // Create PTY bridge
    bridge = tmuxManager.attachBridge(
      sessionName,
      cols,
      rows,
      // onData: relay terminal output to client (tagged so client routes to correct terminal)
      (data: string) => {
        if (bridge!.intentionalDetach) return; // bridge is dying, don't send stale output
        send(client, { type: 'session.output', data, sessionId: sessionName });
      },
      // onExit: tmux attach exited (session killed or detached externally)
      () => {
        const wasIntentional = bridge!.intentionalDetach;
        client.bridge = null;
        client.attachedSession = null;
        if (!wasIntentional) {
          send(client, { type: 'session.ended', sessionId: sessionName });
          broadcastSessionsList();
        }
      },
    );

    client.bridge = bridge;
    client.attachedSession = sessionName;

    // Get session info
    const sessions = await tmuxManager.listSessions(profileManager.getMap());
    const session = sessions.find(s => s.id === sessionName);

    if (session) {
      send(client, { type: 'session.attached', session, scrollback: scrollback || undefined });
    }

    audit('tmux_session_attached', { ip: client.ip, sessionId: sessionName });
  } catch (err) {
    // Bridge spawned but a downstream step (listSessions, etc.) failed.
    // Without this cleanup, the PTY would stay alive holding a tmux client slot
    // while the UI thinks attach failed.
    if (bridge) {
      bridge.intentionalDetach = true;
      try { bridge.ptyProcess.kill(); } catch { /* best-effort */ }
      client.bridge = null;
      client.attachedSession = null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

function setupWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const ip = config.security.trustProxy
      ? (req.headers['x-forwarded-for'] as string || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
      : req.socket.remoteAddress || 'unknown';

    const clientId = crypto.randomUUID();
    const client: ConnectedClient = {
      id: clientId,
      ws,
      authenticated: false,
      ip,
      authTimeout: null,
      tokenName: null,
      bridge: null,
      attachedSession: null,
    };

    clients.set(clientId, client);
    audit('ws_connected', { ip, clientId });

    // Auth timeout: 30 seconds
    client.authTimeout = setTimeout(() => {
      if (!client.authenticated) {
        send(client, { type: 'auth.failed', message: 'Authentication timeout' });
        ws.close(4000, 'Auth timeout');
      }
    }, 30_000);

    send(client, {
      type: 'auth.required',
      setupMode: !config.passwordHash,
      protocolVersion: PROTOCOL_VERSION,
    });

    ws.on('message', async (raw: Buffer | string) => {
      try {
        const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
        if (str.length > 1_000_000) {
          send(client, { type: 'error', message: 'Message too large' });
          return;
        }

        const message: ClientMessage = JSON.parse(str);

        if (!client.authenticated) {
          if (message.type === 'auth' || message.type === 'auth.token') {
            await handleAuth(client, message);
          } else if (message.type === 'ping') {
            send(client, { type: 'pong' });
          } else {
            send(client, { type: 'error', message: 'Not authenticated' });
          }
          return;
        }

        await handleMessage(client, message);
      } catch {
        send(client, { type: 'error', message: 'Invalid message' });
      }
    });

    ws.on('close', () => {
      if (client.authTimeout) clearTimeout(client.authTimeout);
      detachClient(client);
      clients.delete(clientId);
      audit('ws_disconnected', { ip, clientId });
    });

    ws.on('error', () => { /* handled by close */ });
  });
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

function startWatchdog(): void {
  setInterval(async () => {
    tokenStore.purgeExpired();

    // Skip the tmux fan-out entirely when nobody is connected — saves
    // N tmux invocations every 60s on an idle server.
    if (clients.size === 0) return;

    // Broadcast updated sessions list periodically (picks up externally created/killed sessions)
    await broadcastSessionsList();

    const mem = process.memoryUsage();
    const sessions = await tmuxManager.listSessions();
    audit('watchdog', {
      heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      sessions: sessions.length,
      clients: clients.size,
    });
  }, 60_000).unref();
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  config = loadConfig();
  tmuxManager = new TmuxManager();
  await tmuxManager.init();

  profileManager = new ProfileManager();

  healthChecker = new HealthChecker(tmuxManager);
  healthChecker.start(profileManager.list());

  tokenStore = new TokenStore();
  rateLimiter = new RateLimiter();

  // Use cwd (PM2 sets it to project root via ecosystem.config.js)
  const staticDir = path.join(process.cwd(), 'apps', 'client', 'dist');

  const getServerInfo = (): ServerInfo => ({
    serverName: config.serverName,
    port: config.port,
    tmuxVersion: tmuxManager.getVersion(),
    activeSessions: 0, // Will be populated async
  });

  const validateAuthToken = (token: string): boolean => {
    return tokenStore.validateToken(token) !== null;
  };

  const server = http.createServer(
    createHttpHandler(staticDir, getServerInfo, validateAuthToken),
  );

  setupWebSocket(server);
  startWatchdog();

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[PersaLink] Server running on port ${config.port}`);
    console.log(`[PersaLink] Config dir: ~/.persalink/`);
    console.log(`[PersaLink] ${profileManager.list().length} profiles loaded`);
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`[PersaLink] Shutting down (${signal})...`);
    healthChecker.dispose();
    rateLimiter.dispose();
    for (const client of clients.values()) {
      detachClient(client);
      try { client.ws.close(1001, 'Server shutting down'); } catch { /* best effort */ }
    }
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printTmuxMissingHelp(): void {
  console.error('\n  ✗ PersaLink cannot start — tmux is not installed.\n');
  console.error('    PersaLink bridges tmux sessions to your browser, so tmux must');
  console.error('    be installed on this machine. Install it with:\n');
  console.error('      Debian/Ubuntu:  sudo apt install tmux');
  console.error('      macOS:          brew install tmux');
  console.error('      Arch:           sudo pacman -S tmux');
  console.error('      Fedora/RHEL:    sudo dnf install tmux\n');
  console.error('    Then run `persalink` again.\n');
}

main().catch((err) => {
  if (err instanceof Error && /tmux is not installed/i.test(err.message)) {
    printTmuxMissingHelp();
    process.exit(1);
  }
  console.error('[PersaLink] Fatal error:', err);
  process.exit(1);
});
