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

  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, security: { ...DEFAULT_SECURITY } };
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      security: { ...DEFAULT_SECURITY, ...(parsed.security || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG, security: { ...DEFAULT_SECURITY } };
  }
}

export function saveConfig(config: ServerConfig): void {
  ensureConfigDir();
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 0o600);
}

export function detectShell(): string {
  return process.env.SHELL || '/bin/bash';
}
