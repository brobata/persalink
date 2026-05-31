/**
 * @file pushManager.ts
 * @description Web Push (VAPID) delivery for agent notifications. Generates and
 *   persists a VAPID keypair, stores browser push subscriptions, and pushes
 *   notifications to all of them — pruning subscriptions the push service has
 *   expired (404/410). No third-party/Firebase account required: VAPID + the
 *   browser's own push endpoint is enough.
 */
import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWriteFileSync } from './atomicWrite';

const CONFIG_DIR = path.join(os.homedir(), '.persalink');
const VAPID_FILE = path.join(CONFIG_DIR, 'vapid.json');
const SUBS_FILE = path.join(CONFIG_DIR, 'push-subscriptions.json');

export interface PushNotification {
  title: string;
  body: string;
  /** Collapse key — a newer notification replaces an older one with same tag. */
  tag?: string;
  /** Session to open when the notification is tapped. */
  sessionId?: string;
}

interface StoredSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class PushManager {
  private publicKey = '';
  private privateKey = '';
  private subs: StoredSub[] = [];

  init(): void {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

    // VAPID keypair — load existing or generate once and persist.
    try {
      const k = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
      this.publicKey = k.publicKey;
      this.privateKey = k.privateKey;
    } catch {
      const k = webpush.generateVAPIDKeys();
      this.publicKey = k.publicKey;
      this.privateKey = k.privateKey;
      try { atomicWriteFileSync(VAPID_FILE, JSON.stringify(k, null, 2), 0o600); }
      catch (err) { console.error('[push] could not persist VAPID keys:', err); }
    }
    webpush.setVapidDetails('mailto:persalink@localhost', this.publicKey, this.privateKey);

    // Stored subscriptions.
    try {
      const parsed = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'));
      this.subs = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.subs = [];
    }
  }

  getPublicKey(): string { return this.publicKey; }
  get count(): number { return this.subs.length; }

  subscribe(sub: StoredSub): void {
    if (!sub?.endpoint) return;
    if (this.subs.some((s) => s.endpoint === sub.endpoint)) return;
    this.subs.push({ endpoint: sub.endpoint, keys: sub.keys });
    this.persist();
  }

  unsubscribe(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.persist();
  }

  /** Deliver to every subscription; prune any the push service has expired. */
  async send(n: PushNotification): Promise<void> {
    if (this.subs.length === 0) return;
    const payload = JSON.stringify(n);
    const dead: string[] = [];
    await Promise.all(
      this.subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload, { TTL: 600 });
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) dead.push(sub.endpoint);
        }
      }),
    );
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
      this.persist();
    }
  }

  private persist(): void {
    try { atomicWriteFileSync(SUBS_FILE, JSON.stringify(this.subs, null, 2), 0o600); }
    catch (err) { console.error('[push] could not persist subscriptions:', err); }
  }
}
