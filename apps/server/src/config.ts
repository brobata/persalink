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
  localhostTrusted: boolean;
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

const DEFAULT_SECURITY: SecurityConfig = {
  localhostTrusted: false,
  tokenTtlDays: 365,
  allowedOrigins: [],
  maxConnectionsPerIp: 10,
  trustProxy: false,
  maxTotalSessions: 50,
  allowRemoteSetup: false,
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

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const aside = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(CONFIG_FILE, aside); } catch { /* best-effort */ }
    throw new Error(`config.json was corrupt (saved aside as ${aside}): ${(err as Error).message}`);
  }

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    security: { ...DEFAULT_SECURITY, ...((parsed.security as Record<string, unknown>) || {}) },
  };
}

export function saveConfig(config: ServerConfig): void {
  ensureConfigDir();
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 0o600);
}

export function detectShell(): string {
  return process.env.SHELL || '/bin/bash';
}
