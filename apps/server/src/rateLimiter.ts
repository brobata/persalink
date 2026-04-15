/**
 * @file Auth rate limiter with tiered backoff and permanent-lock cliff.
 * @description Single global counter of failed auth attempts since last success.
 *   Lockout duration escalates with each failure (iPad-style). After MAX_FAILURES
 *   the server permanently locks and requires manual reset (delete the persisted
 *   state file or reinitialize ~/.persalink/).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from './config';
import { atomicWriteFileSync } from './atomicWrite';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Failures -> lockout duration (ms). 0 = no lockout. -1 = permanent.
// Index = failure count. Failures 1..2 have no lockout; escalation starts at 3.
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

const MAX_FAILURES = SCHEDULE.length - 1; // 10

const STATE_FILE = path.join(CONFIG_DIR, 'rate-limits.json');

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  permanentLock?: boolean;
  failures?: number;
}

interface PersistedState {
  failures: number;
  lockedUntil: number;
  permanentLock: boolean;
  _version: 1;
}

const INITIAL_STATE: PersistedState = {
  failures: 0,
  lockedUntil: 0,
  permanentLock: false,
  _version: 1,
};

function lockoutDurationFor(failureCount: number): number {
  if (failureCount >= MAX_FAILURES) return -1;
  return SCHEDULE[failureCount] ?? 0;
}

export class RateLimiter {
  private state: PersistedState = { ...INITIAL_STATE };

  constructor() {
    this.load();
  }

  check(_ip: string): RateLimitResult {
    if (this.state.permanentLock) {
      return { allowed: false, permanentLock: true, failures: this.state.failures };
    }
    const now = Date.now();
    if (this.state.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterMs: this.state.lockedUntil - now,
        failures: this.state.failures,
      };
    }
    return { allowed: true, failures: this.state.failures };
  }

  recordFailure(_ip: string): RateLimitResult {
    this.state.failures++;
    const duration = lockoutDurationFor(this.state.failures);
    if (duration === -1) {
      this.state.permanentLock = true;
      this.state.lockedUntil = 0;
    } else if (duration > 0) {
      this.state.lockedUntil = Date.now() + duration;
    }
    this.save();
    return this.check('');
  }

  recordSuccess(_ip: string): void {
    if (this.state.failures === 0 && !this.state.permanentLock && this.state.lockedUntil === 0) return;
    this.state = { ...INITIAL_STATE };
    this.save();
  }

  getFailureCount(): number {
    return this.state.failures;
  }

  isPermanentlyLocked(): boolean {
    return this.state.permanentLock;
  }

  dispose(): void {
    // nothing to tear down — writes are synchronous and persisted
  }

  private load(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = {
        failures: parsed.failures ?? 0,
        lockedUntil: parsed.lockedUntil ?? 0,
        permanentLock: parsed.permanentLock ?? false,
        _version: 1,
      };
    } catch {
      this.state = { ...INITIAL_STATE };
    }
  }

  private save(): void {
    try {
      atomicWriteFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 0o600);
    } catch {
      // State persistence is best-effort — failure to write must not crash auth.
    }
  }
}
