/**
 * @file Password Hashing + Token Store
 * @description scrypt-based password hashing (NIST 800-63B aligned) and
 *   cryptographic token management for PersaLink.
 */

import * as crypto from 'crypto';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from './atomicWrite';

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

// ============================================================================
// Password Hashing
// ============================================================================

export interface PasswordHash {
  salt: string;
  hash: string;
  algorithm: 'scrypt';
  params: { N: number; r: number; p: number; keylen: number };
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return {
    salt,
    hash: derived.toString('hex'),
    algorithm: 'scrypt',
    params: { ...SCRYPT_PARAMS },
  };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const derived = await scryptAsync(password, stored.salt, stored.params.keylen, {
    N: stored.params.N,
    r: stored.params.r,
    p: stored.params.p,
  });
  const storedBuf = Buffer.from(stored.hash, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', '12345678', '123456789', '1234567890',
  'qwerty123', 'abcdefgh', 'abcd1234', 'letmein01', 'iloveyou',
  'trustno1', 'sunshine1', 'princess1', 'football1', 'charlie1',
  'passw0rd', 'admin123', 'welcome1', 'p@ssw0rd', 'changeme',
]);

export function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be 128 characters or fewer';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'This password is too common. Please choose a stronger password';
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigitOrSpecial = /[^a-zA-Z]/.test(password);
  if (!hasLetter || !hasDigitOrSpecial) {
    return 'Password must contain at least one letter and one number or special character';
  }
  return null;
}

// ============================================================================
// Token Generation
// ============================================================================

export interface GeneratedToken {
  plaintext: string;
  hash: string;
}

export function generateToken(): GeneratedToken {
  const raw = crypto.randomBytes(32);
  const plaintext = raw.toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { plaintext, hash };
}

export function hashToken(plaintext: string): string {
  const raw = Buffer.from(plaintext, 'base64url');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ============================================================================
// Token Store (file-backed)
// ============================================================================

export interface StoredToken {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
}

const CONFIG_DIR = process.env.PERSALINK_CONFIG_DIR || path.join(os.homedir(), '.persalink');
const TOKENS_FILE = path.join(CONFIG_DIR, 'tokens.json');

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export class TokenStore {
  private tokens: StoredToken[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.tokens = [];
        return;
      }
      // Token store is auth-critical — silently resetting on transient FS errors
      // would revoke all sessions AND clobber the on-disk record on next save.
      // Fail closed: refuse to start so the operator can investigate.
      throw new Error(`Failed to read tokens at ${TOKENS_FILE}: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const aside = `${TOKENS_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(TOKENS_FILE, aside); } catch { /* best-effort */ }
      throw new Error(`tokens.json was corrupt (saved aside as ${aside}): ${(err as Error).message}`);
    }

    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tokens?: unknown }).tokens)) {
      this.tokens = (parsed as { tokens: StoredToken[] }).tokens;
      return;
    }
    // Schema mismatch — also rename aside rather than overwrite.
    const aside = `${TOKENS_FILE}.malformed-${Date.now()}`;
    try { fs.renameSync(TOKENS_FILE, aside); } catch { /* best-effort */ }
    throw new Error(`tokens.json had unexpected shape (saved aside as ${aside})`);
  }

  validateToken(plaintext: string): StoredToken | null {
    const tokenHash = hashToken(plaintext);
    for (const token of this.tokens) {
      if (token.tokenHash !== tokenHash) continue;
      if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
        return null;
      }
      return token;
    }
    return null;
  }

  touch(tokenHash: string): void {
    const token = this.tokens.find((t) => t.tokenHash === tokenHash);
    if (token) {
      token.lastUsedAt = new Date().toISOString();
      this.save();
    }
  }

  add(stored: StoredToken): void {
    this.tokens.push(stored);
    this.save();
  }

  revoke(id: string): boolean {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  list(): Omit<StoredToken, 'tokenHash'>[] {
    return this.tokens.map(({ id, name, createdAt, lastUsedAt, expiresAt }) => ({
      id, name, createdAt, lastUsedAt, expiresAt,
    }));
  }

  purgeExpired(): number {
    const now = new Date();
    const before = this.tokens.length;
    this.tokens = this.tokens.filter(
      (t) => !t.expiresAt || new Date(t.expiresAt) >= now
    );
    const removed = before - this.tokens.length;
    if (removed > 0) this.save();
    return removed;
  }

  revokeAll(): number {
    const count = this.tokens.length;
    this.tokens = [];
    this.save();
    return count;
  }

  createAccessToken(name: string, ttlDays?: number | null): { stored: StoredToken; plaintext: string } {
    const MAX_TTL_DAYS = 365;
    const effectiveTtl = ttlDays != null ? Math.min(ttlDays, MAX_TTL_DAYS) : MAX_TTL_DAYS;
    const { plaintext, hash } = generateToken();
    const now = new Date();
    const stored: StoredToken = {
      id: crypto.randomUUID(),
      name,
      tokenHash: hash,
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + effectiveTtl * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.add(stored);
    return { stored, plaintext };
  }

  private save(): void {
    ensureConfigDir();
    const data = { _version: 1, tokens: this.tokens };
    atomicWriteFileSync(TOKENS_FILE, JSON.stringify(data, null, 2), 0o600);
  }
}
