/**
 * @file door.ts
 * @description Which entrance this page was loaded through. The server's
 *   public door (Cloudflare Access + tunnel, used from borrowed/work
 *   computers) sets a `pl_door=public` cookie on every response; the tailnet
 *   door never does. Read once, synchronously, before the store hydrates, so
 *   the login can be kept in session storage only on that machine. The server
 *   enforces the real limits (door-bound short tokens, files off) — this only
 *   shapes what the page stores and shows.
 */

export const isPublicDoor: boolean =
  typeof document !== 'undefined' && /(?:^|;\s*)pl_door=public(?:;|$)/.test(document.cookie);
