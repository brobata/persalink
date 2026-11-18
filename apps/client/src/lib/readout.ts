/**
 * @file Connection readout rule
 * @description What the connection readout says for a socket state and the
 *   last ping round trip: "18 ms", "312 ms slow", "reconnecting", "offline",
 *   or "connected" before the first round trip lands. Over 250ms is slow.
 *   Pure, so every surface and the tests share one rule.
 */

export const SLOW_MS = 250;

export type ReadoutKind = 'ok' | 'slow' | 'off';

export function readout(state: string, rttMs: number | null): { kind: ReadoutKind; text: string } {
  if (state === 'reconnecting' || state === 'connecting') return { kind: 'off', text: 'reconnecting' };
  if (state === 'disconnected') return { kind: 'off', text: 'offline' };
  if (rttMs == null) return { kind: 'ok', text: 'connected' };
  const ms = `${Math.max(1, Math.round(rttMs))} ms`;
  return rttMs > SLOW_MS ? { kind: 'slow', text: `${ms} slow` } : { kind: 'ok', text: ms };
}
