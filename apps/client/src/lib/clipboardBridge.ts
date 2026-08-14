/**
 * @file Clipboard bridge
 * @description Robust device-clipboard writes for in-session copies (OSC 52),
 *   shared by TerminalScreen and TerminalPane. Android only allows clipboard
 *   writes when the page is focused AND has recent user activation — the
 *   first copy after a load often has neither, which made the "Copied" toast
 *   feel unreliable. Writes never fail silently now: a blocked write stashes
 *   the text and shows a TAPPABLE toast — the tap is a real user gesture, so
 *   the retry always succeeds.
 */

import { useAppStore } from '../stores/appStore';

let pendingCopy: string | null = null;

/** Distinct op so ToastStack knows this toast is a tap-to-finish action. */
export const COPY_PENDING_OP = 'copy-pending';

async function writeSessionClipboard(text: string): Promise<void> {
  const push = useAppStore.getState().pushNotification;
  try {
    if (!navigator.clipboard?.writeText || !window.isSecureContext) throw new Error('unavailable');
    await navigator.clipboard.writeText(text);
    pendingCopy = null;
    push('info', 'Copied from session', 'osc52');
  } catch {
    pendingCopy = text;
    push('info', 'Copy ready — tap here to put it on the clipboard', COPY_PENDING_OP);
  }
}

/** Toast tap handler: completes a blocked copy inside the tap's user gesture. */
export async function completePendingCopy(): Promise<void> {
  if (pendingCopy === null) return;
  const push = useAppStore.getState().pushNotification;
  try {
    await navigator.clipboard.writeText(pendingCopy);
    pendingCopy = null;
    push('info', 'Copied from session', 'osc52');
  } catch {
    push('error', 'Clipboard still blocked — use the selection menu to copy instead.', 'copy');
  }
}

/** OSC 52 handler for term.parser.registerOscHandler(52, ...). Write-only —
 *  clipboard READ queries ("?") are never answered. */
export function handleOsc52(data: string): boolean {
  const semi = data.indexOf(';');
  const payload = semi >= 0 ? data.slice(semi + 1) : data;
  if (!payload || payload === '?') return true;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (text) void writeSessionClipboard(text);
  } catch { /* malformed base64 — ignore */ }
  return true;
}
