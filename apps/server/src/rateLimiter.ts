/**
 * @file Per-IP Auth Rate Limiter
 * @description In-memory sliding window rate limiter for authentication attempts.
 */

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export class RateLimiter {
  private entries = new Map<string, Entry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxFailures: number = 5,
    private windowMs: number = 15 * 60 * 1000,
    private lockoutMs: number = 15 * 60 * 1000,
  ) {
    this.cleanupTimer = setInterval(() => this.purgeStale(), 5 * 60 * 1000);
  }

  check(ip: string): RateLimitResult {
    const entry = this.entries.get(ip);
    if (!entry) return { allowed: true };

    const now = Date.now();
    if (entry.lockedUntil > now) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - now };
    }
    if (now - entry.windowStart > this.windowMs) {
      this.entries.delete(ip);
      return { allowed: true };
    }
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = now + this.lockoutMs;
      return { allowed: false, retryAfterMs: this.lockoutMs };
    }
    return { allowed: true };
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.entries.get(ip);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(ip, { failures: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    entry.failures++;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = now + this.lockoutMs;
    }
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }

  private purgeStale(): void {
    const now = Date.now();
    for (const [ip, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs && entry.lockedUntil <= now) {
        this.entries.delete(ip);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }
}
