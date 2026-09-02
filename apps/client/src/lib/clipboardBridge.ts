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

// Success is SILENT — copy-confirmation toasts were noise (user call,
// 2026-08-14). Only a blocked write speaks, because that one needs a tap.
async function writeSessionClipboard(text: string): Promise<void> {
  const push = useAppStore.getState().pushNotification;
  try {
    if (!navigator.clipboard?.writeText || !window.isSecureContext) throw new Error('unavailable');
    await navigator.clipboard.writeText(text);
    pendingCopy = null;
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
  } catch {
    push('error', 'Clipboard still blocked — use the selection menu to copy instead.', 'copy');
  }
}

/** Copy arbitrary text from inside a user gesture (a tap on our selection
 *  bar). Modern API on secure origins; execCommand('copy') through a scratch
 *  textarea on plain http. Resolves false only when both refused. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the legacy path */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
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
