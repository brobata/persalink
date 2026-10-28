/**
 * @file Push sign-in approvals ("Duo-style")
 * @description A public-door password login can be confirmed from the owner's
 *   phone: the server pushes {id, secret, number} to the subscribed devices
 *   (Web Push payloads are encrypted to each subscription, so only those
 *   devices ever see the secret). The phone posts the secret back with
 *   approve/deny; the login screen shows the same 2-digit number so a stray
 *   or unexpected request is easy to spot. Unanswered requests deny on expiry.
 */

import * as crypto from 'crypto';

export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'cancelled';

interface Pending {
  secretHash: Buffer;
  timer: ReturnType<typeof setTimeout>;
  settle: (o: ApprovalOutcome) => void;
}

export interface ApprovalRequest {
  id: string;
  secret: string;
  number: string;
  outcome: Promise<ApprovalOutcome>;
  cancel: () => void;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

export class ApprovalManager {
  private pending = new Map<string, Pending>();

  constructor(private readonly ttlMs = 60_000) {}

  create(): ApprovalRequest {
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const number = String(crypto.randomInt(10, 100));
    let settle!: (o: ApprovalOutcome) => void;
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      settle = (o) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        resolve(o);
      };
    });
    const timer = setTimeout(() => settle('expired'), this.ttlMs);
    this.pending.set(id, { secretHash: sha256(secret), timer, settle });
    return { id, secret, number, outcome, cancel: () => settle('cancelled') };
  }

  /** Answer from the phone. False if unknown/expired/wrong secret. Single use. */
  answer(id: string, secret: string, decision: 'approve' | 'deny'): boolean {
    const p = this.pending.get(id);
    if (!p || typeof secret !== 'string') return false;
    if (!crypto.timingSafeEqual(p.secretHash, sha256(secret))) return false;
    p.settle(decision === 'approve' ? 'approved' : 'denied');
    return true;
  }
}
