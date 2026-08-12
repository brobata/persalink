/**
 * @file Build ID global
 * @description Injected by vite.config.ts `define` — the id of the bundle the
 *   user is currently running. Compared against /version.json (emitted by the
 *   same build) to detect that the server is serving a newer client.
 */
declare const __BUILD_ID__: string;
