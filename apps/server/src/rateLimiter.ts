/**
 * @file Auth rate limiter with tiered backoff and permanent-lock cliff.
 * @description Per-IP failure tracking with iPad-style escalating lockout.
 *   Failures from one IP do not affect other IPs — prevents trivial
 *   lockout-DoS where a hostile IP bricks the legitimate owner's access.
 *   After MAX_FAILURES from a single IP that bucket permanently locks.
 *   Bucket count is capped to bound memory; oldest active bucket is evicted.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from './config';
import { atomicWriteFileSync } from './atomicWrite';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const SCHEDULE: readonly number[] = [
  0,           // 0: n/a (never read)
  0,           // 1: no lockout
  0,           // 2: no lockout
  1 * MINUTE,  // 3
  5 * MINUTE,  // 4
  15 * MINUTE, // 5
  30 * MINUTE, // 6
  1 * HOUR,    // 7
  4 * HOUR,    // 8
  24 * HOUR,   // 9
  -1,          // 10+: permanent
];

const MAX_FAILURES = SCHEDULE.length - 1;
const MAX_BUCKETS = 1024;

const STATE_FILE = path.join(CONFIG_DIR, 'rate-limits.json');

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  permanentLock?: boolean;
  failures?: number;
}

interface IpState {
  failures: number;
  lockedUntil: number;
  permanentLock: boolean;
  lastSeen: number;
}

interface PersistedState {
  ips: Record<string, IpState>;
  _version: 2;
}

function lockoutDurationFor(failureCount: number): number {
  if (failureCount >= MAX_FAILURES) return -1;
  return SCHEDULE[failureCount] ?? 0;
}

function newIpState(): IpState {
  return { failures: 0, lockedUntil: 0, permanentLock: false, lastSeen: Date.now() };
}

export class RateLimiter {
  private buckets = new Map<string, IpState>();

  constructor() {
    this.load();
  }

  check(ip: string): RateLimitResult {
    const bucket = this.buckets.get(ip);
    if (!bucket) return { allowed: true, failures: 0 };
    bucket.lastSeen = Date.now();
    if (bucket.permanentLock) {
      return { allowed: false, permanentLock: true, failures: bucket.failures };
    }
    if (bucket.lockedUntil > Date.now()) {
      return {
        allowed: false,
        retryAfterMs: bucket.lockedUntil - Date.now(),
        failures: bucket.failures,
      };
    }
    return { allowed: true, failures: bucket.failures };
  }

  recordFailure(ip: string): RateLimitResult {
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      this.evictIfFull();
      bucket = newIpState();
      this.buckets.set(ip, bucket);
    }
    bucket.failures++;
    bucket.lastSeen = Date.now();
    const duration = lockoutDurationFor(bucket.failures);
    if (duration === -1) {
      bucket.permanentLock = true;
      bucket.lockedUntil = 0;
    } else if (duration > 0) {
      bucket.lockedUntil = Date.now() + duration;
    }
    this.save();
    return this.check(ip);
  }

  recordSuccess(ip: string): void {
    if (!this.buckets.has(ip)) return;
    this.buckets.delete(ip);
    this.save();
  }

  getFailureCount(ip: string): number {
    return this.buckets.get(ip)?.failures ?? 0;
  }

  isPermanentlyLocked(ip: string): boolean {
    return this.buckets.get(ip)?.permanentLock ?? false;
  }

  dispose(): void { /* writes are synchronous */ }

  private evictIfFull(): void {
    if (this.buckets.size < MAX_BUCKETS) return;
    // Evict the oldest non-permanent-locked bucket; permanent locks stay
    // until manually cleared (deleting the state file).
    let oldestKey: string | null = null;
    let oldestSeen = Infinity;
    for (const [k, v] of this.buckets) {
      if (v.permanentLock) continue;
      if (v.lastSeen < oldestSeen) {
        oldestSeen = v.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(STATE_FILE, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // State persistence is best-effort, but a read error here means we
      // start with a clean map — log and continue rather than crashing.
      console.error('[RateLimiter] failed to read state, starting empty:', err);
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.ips) {
        for (const [ip, state] of Object.entries(parsed.ips as Record<string, Partial<IpState>>)) {
          this.buckets.set(ip, {
            failures: state.failures ?? 0,
            lockedUntil: state.lockedUntil ?? 0,
            permanentLock: state.permanentLock ?? false,
            lastSeen: state.lastSeen ?? Date.now(),
          });
        }
      }
    } catch (err) {
      console.error('[RateLimiter] state file unparseable, starting empty:', err);
    }
  }

  private save(): void {
    try {
      const persisted: PersistedState = { ips: Object.fromEntries(this.buckets), _version: 2 };
      atomicWriteFileSync(STATE_FILE, JSON.stringify(persisted, null, 2), 0o600);
    } catch {
      // best-effort persistence
    }
  }
}
