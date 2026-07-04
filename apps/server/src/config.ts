/**
 * @file PersaLink Server Configuration
 * @description Load/save config from ~/.persalink/config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PasswordHash } from './auth';
import { atomicWriteFileSync } from './atomicWrite';

export interface SecurityConfig {
  tokenTtlDays: number | null;
  allowedOrigins: string[];
  maxConnectionsPerIp: number;
  trustProxy: boolean;
  maxTotalSessions: number;
  // When false (default), the first-run password can only be set from a
  // localhost connection. Prevents a network attacker from racing to claim
  // the password between server start and operator setup. Set true if you
  // need to set the password from the LAN.
  allowRemoteSetup: boolean;
  // Interface the HTTP/WS server binds to. Default '0.0.0.0' (all interfaces,
  // reachable from the LAN over plaintext HTTP). Set to '127.0.0.1' to accept
  // only loopback — recommended when a TLS front door (e.g. `tailscale serve`)
  // already proxies from localhost, so credentials never cross the LAN in the
  // clear. Direct http://<lan-ip>:<port> access stops working when set to
  // loopback; tailnet/HTTPS access is unaffected.
  bindHost: string;
}

export interface ServerConfig {
  passwordHash: PasswordHash | null;
  port: number;
  serverName: string;
  defaultShell: string | null;
  security: SecurityConfig;
  _version: number;
}

export const CONFIG_DIR = process.env.PERSALINK_CONFIG_DIR || path.join(os.homedir(), '.persalink');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// Last-known-good mirror. config.json holds the password hash; if it is ever
// corrupted (external tooling, a bad disk), restoring from this backup lets the
// server come back up authenticated instead of silently resetting to a
// passwordless first-run setup after pm2 auto-restarts it.
const CONFIG_BAK = path.join(CONFIG_DIR, 'config.json.bak');

function hydrate(parsed: Record<string, unknown>): ServerConfig {
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    security: { ...DEFAULT_SECURITY, ...((parsed.security as Record<string, unknown>) || {}) },
  };
}

const DEFAULT_SECURITY: SecurityConfig = {
  tokenTtlDays: 365,
  allowedOrigins: [],
  maxConnectionsPerIp: 10,
  trustProxy: false,
  maxTotalSessions: 50,
  allowRemoteSetup: false,
  bindHost: '0.0.0.0',
};

const DEFAULT_CONFIG: ServerConfig = {
  passwordHash: null,
  port: 9877,
  serverName: os.hostname(),
  defaultShell: null,
  security: { ...DEFAULT_SECURITY },
  _version: 1,
};

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): ServerConfig {
  ensureConfigDir();

  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      saveConfig(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG, security: { ...DEFAULT_SECURITY } };
    }
    // SECURITY: silently falling back to DEFAULT_CONFIG would set passwordHash
    // to null, putting the server back in "first-run, anyone can claim it"
    // mode. Refuse to start instead.
    throw new Error(`Failed to read config at ${CONFIG_FILE}: ${(err as Error).message}`);
  }

  try {
    return hydrate(JSON.parse(raw));
  } catch (err) {
    // config.json is unparseable. Before giving up (which would land us in
    // passwordless setup mode on the next restart), try the last-known-good
    // backup so the password/config survive the corruption.
    try {
      const bak = fs.readFileSync(CONFIG_BAK, 'utf-8');
      const recovered = hydrate(JSON.parse(bak));
      console.error(`[PersaLink] config.json was corrupt — recovered from ${CONFIG_BAK}`);
      saveConfig(recovered); // rewrite a clean primary from the backup
      return recovered;
    } catch { /* no usable backup — fall through to rename-aside */ }

    const aside = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(CONFIG_FILE, aside); } catch { /* best-effort */ }
    throw new Error(`config.json was corrupt and no valid backup existed (saved aside as ${aside}): ${(err as Error).message}`);
  }
}

export function saveConfig(config: ServerConfig): void {
  ensureConfigDir();
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 0o600);
  // Mirror to the last-known-good backup after the primary write succeeds.
  try {
    atomicWriteFileSync(CONFIG_BAK, JSON.stringify(config, null, 2), 0o600);
  } catch (err) {
    console.error('[PersaLink] could not write config backup:', err);
  }
}

export function detectShell(): string {
  return process.env.SHELL || '/bin/bash';
}
