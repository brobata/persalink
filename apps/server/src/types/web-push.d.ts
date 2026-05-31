/**
 * @file web-push.d.ts
 * @description Minimal ambient types for the slice of `web-push` we use.
 *   The published @types/web-push wouldn't reliably install in this workspace,
 *   and we only touch three functions — declaring them here keeps the build
 *   self-contained.
 */
declare module 'web-push' {
  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }
  export interface PushSubscriptionLike {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface RequestOptions {
    TTL?: number;
    [key: string]: unknown;
  }
  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  export function generateVAPIDKeys(): VapidKeys;
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: PushSubscriptionLike,
    payload?: string | Buffer,
    options?: RequestOptions,
  ): Promise<SendResult>;

  const _default: {
    generateVAPIDKeys: typeof generateVAPIDKeys;
    setVapidDetails: typeof setVapidDetails;
    sendNotification: typeof sendNotification;
  };
  export default _default;
}
