/**
 * @file Remote server helpers
 * @description Short-lived, single-purpose WebSocket calls to a NON-active
 *   server from the registry (multi-server phase 2). Used by the desktop pane
 *   picker to list another machine's sessions/profiles and to start a session
 *   there without switching the whole app over. Plain WebSocket on purpose —
 *   no reconnect/liveness machinery; open, auth, ask, close.
 */

import type { SessionInfo, Profile, ServerMessage } from '@persalink/shared/protocol';
import type { ServerEntry } from '../stores/appStore';
import { pageHost, schemesFor } from './platform';

export function resolveEntryHost(entry: ServerEntry): string {
  const ph = pageHost();
  return entry.useOrigin && ph ? ph : entry.host;
}

function wsUrlFor(entry: ServerEntry): string {
  return `${schemesFor(entry.tls).ws}${resolveEntryHost(entry)}`;
}

interface RemoteCallOpts<T> {
  entry: ServerEntry;
  timeoutMs?: number;
  /** Called once authenticated — send the request(s). */
  onReady: (send: (msg: object) => void) => void;
  /** Return a value to resolve with, or undefined to keep waiting. */
  onMessage: (msg: ServerMessage, send: (msg: object) => void) => T | undefined;
}

function remoteCall<T>({ entry, timeoutMs = 8000, onReady, onMessage }: RemoteCallOpts<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!entry.authToken) {
      reject(new Error('no-token'));
      return;
    }
    let settled = false;
    const ws = new WebSocket(wsUrlFor(entry));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), timeoutMs);
    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    ws.onerror = () => finish(() => reject(new Error('unreachable')));
    ws.onclose = () => finish(() => reject(new Error('closed')));
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data as string); } catch { return; }
      if (msg.type === 'auth.required') {
        send({ type: 'auth.token', token: entry.authToken });
        return;
      }
      if (msg.type === 'auth.failed') {
        finish(() => reject(new Error('auth')));
        return;
      }
      if (msg.type === 'auth.ok') {
        onReady(send);
        return;
      }
      const result = onMessage(msg, send);
      if (result !== undefined) finish(() => resolve(result));
    };
  });
}

/** Sessions + profiles snapshot from a remote server (for the pane picker). */
export function remoteSnapshot(entry: ServerEntry): Promise<{ sessions: SessionInfo[]; profiles: Profile[] }> {
  let sessions: SessionInfo[] | null = null;
  let profiles: Profile[] | null = null;
  return remoteCall({
    entry,
    onReady: (send) => {
      send({ type: 'sessions.list' });
      send({ type: 'profiles.list' });
    },
    onMessage: (msg) => {
      if (msg.type === 'sessions.list') sessions = msg.sessions;
      if (msg.type === 'profiles.list') profiles = msg.profiles;
      if (sessions && profiles) return { sessions, profiles };
      return undefined;
    },
  });
}

/** Run a command detached on a remote server (multi-server snippet run). */
export function remoteExec(entry: ServerEntry, command: string): Promise<{ output: string; exitCode: number }> {
  const tag = `remote-${Math.abs(Date.now() % 1e9)}`;
  return remoteCall({
    entry,
    timeoutMs: 35000, // server-side exec timeout is 30s
    onReady: (send) => {
      send({ type: 'exec.run', command, tag });
    },
    onMessage: (msg) => {
      if (msg.type === 'exec.result' && msg.tag === tag) {
        return { output: msg.output, exitCode: msg.exitCode };
      }
      return undefined;
    },
  });
}

/** Create a session from a profile on a remote server; resolves its id.
 *  The server auto-attaches the creating client; we detach before closing so
 *  the session keeps running for the pane that's about to attach to it. */
export function remoteCreateSession(entry: ServerEntry, profileId: string): Promise<string> {
  return remoteCall({
    entry,
    timeoutMs: 15000, // profile on-connect commands can make creation slow
    onReady: (send) => {
      send({ type: 'session.create', profileId });
    },
    onMessage: (msg, send) => {
      if (msg.type === 'session.attached') {
        send({ type: 'session.detach' });
        return msg.session.id;
      }
      return undefined;
    },
  });
}
