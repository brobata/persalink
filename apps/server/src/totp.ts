/**
 * @file TOTP (RFC 6238) for the public door's second step
 * @description Google Authenticator-compatible codes: HMAC-SHA1, 6 digits,
 *   30-second steps, ±1 step of clock drift. Callers pass the last accepted
 *   step so a code can't be replayed inside its window.
 */

import * as crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function isValidSecret(secret: unknown): secret is string {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{16,}$/.test(secret)) return false;
  return base32Decode(secret).length >= 10;
}

/** 20 random bytes, base32 — what authenticator apps expect. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Returns the matched step, or null. A step at or before `lastStep` is
 * refused (replay). Comparison is constant-time per candidate.
 */
export function verifyCode(secret: string, code: string, nowMs: number = Date.now(), lastStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** True when the code is genuine but its step was already used (a replay, or
 *  the same code typed on a second device inside its 30s): not a guess. */
export function isUsedCode(secret: string, code: string, nowMs: number, lastStep: number): boolean {
  if (!/^\d{6}$/.test(code) || lastStep < 0) return false;
  const current = Math.floor(nowMs / 1000 / STEP_SECONDS);
  return [current - 1, current, current + 1].some((step) => step <= lastStep
    && crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code)));
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
