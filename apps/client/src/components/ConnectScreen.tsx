/**
 * @file ConnectScreen — the Servers screen
 * @description Multi-server manager: saved server list with live health dots,
 *   tap to switch, add/remove entries. First run auto-creates an entry for the
 *   server that served this page. Also explains WS origin rejections (server
 *   reachable but connection refused) instead of leaving a silent spinner.
 */
import { useState, useEffect } from 'react';
import { useAppStore, type ServerEntry } from '../stores/appStore';

/** Probe a server's /health. no-cors: an opaque response still proves the
 *  host is up, and it works cross-origin without the server sending CORS
 *  headers. Rejection/timeout = unreachable. */
async function probeHealth(host: string): Promise<boolean> {
  const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https:' : 'http:';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`${proto}//${host}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resolveHost(entry: ServerEntry): string {
  const pageHost = typeof window !== 'undefined' ? window.location.host : '';
  return entry.useOrigin && pageHost ? pageHost : entry.host;
}

// One-shot per page load, module-level ON PURPOSE. A per-mount ref re-fires on
// every navigation here, so tapping Disconnect (or the server chip) mounted the
// screen, auto-reconnected, hit auth.required, and bounced the user straight
// to the auth view — the Servers screen was unreachable as a destination.
let didAutoConnect = false;

function ServerRow({ entry, isActive, reachable, connState, onRemove }: {
  entry: ServerEntry;
  isActive: boolean;
  reachable: boolean | undefined;
  connState: string;
  onRemove: () => void;
}) {
  const selectServer = useAppStore((s) => s.selectServer);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const host = resolveHost(entry);
  const pageOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const crossOrigin = !entry.useOrigin && typeof window !== 'undefined' && entry.host !== window.location.host;
  // Reachable over HTTP but the WS never authenticates → almost certainly the
  // server's origin allowlist. Say so, with the exact fix.
  const likelyOriginBlocked = isActive && crossOrigin && reachable === true && connState === 'disconnected';

  return (
    <div className={`rounded-xl border ${isActive ? 'border-zinc-600 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/50'}`}>
      <div className="flex items-center">
        <button
          onClick={() => selectServer(entry.id)}
          className="flex items-center gap-3 flex-1 min-w-0 px-4 py-3.5 text-left active:bg-zinc-800/60 rounded-l-xl transition-colors"
        >
          <span
            className={`shrink-0 w-2.5 h-2.5 rounded-full ${
              reachable === undefined ? 'bg-zinc-700 animate-pulse' : reachable ? 'bg-emerald-500' : 'bg-zinc-600'
            }`}
            title={reachable === undefined ? 'Checking…' : reachable ? 'Reachable' : 'Unreachable'}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-100 truncate">
              {entry.serverName || entry.label}
              {isActive && connState === 'authenticated' && (
                <span className="ml-2 text-[10px] text-emerald-400">connected</span>
              )}
              {isActive && (connState === 'connecting' || connState === 'reconnecting' || connState === 'connected') && (
                <span className="ml-2 text-[10px] text-amber-300">connecting…</span>
              )}
            </div>
            <div className="text-xs text-zinc-600 font-mono truncate">{host}</div>
          </div>
        </button>
        {confirmRemove ? (
          <button
            onClick={onRemove}
            onBlur={() => setConfirmRemove(false)}
            className="shrink-0 px-3 py-3.5 text-xs font-medium text-red-400 active:text-red-300 border-l border-zinc-800 rounded-r-xl"
          >
            Remove?
          </button>
        ) : (
          <button
            onClick={() => setConfirmRemove(true)}
            className="shrink-0 px-3 py-3.5 text-zinc-600 active:text-red-400 border-l border-zinc-800 rounded-r-xl transition-colors"
            title="Remove server"
          >
            &times;
          </button>
        )}
      </div>
      {likelyOriginBlocked && (
        <div className="px-4 pb-3 text-[11px] leading-snug text-amber-300/90">
          Server is up but refused the connection — likely its origin allowlist.
          On <span className="font-mono">{entry.host}</span>, add to{' '}
          <span className="font-mono">~/.persalink/config.json</span>:{' '}
          <span className="font-mono text-amber-200">{`"security": { "allowedOrigins": ["${pageOrigin}"] }`}</span>{' '}
          and restart PersaLink there.
        </div>
      )}
    </div>
  );
}

export function ConnectScreen() {
  const {
    servers, activeServerId, connectionState, connect, addServer, removeServer,
  } = useAppStore();
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newHost, setNewHost] = useState('');
  const [reachability, setReachability] = useState<Record<string, boolean>>({});

  // First app load only: served by a PersaLink server with nothing saved →
  // that server becomes entry #1, no typing. With saved servers, resume the
  // active one. Later mounts (user navigated here) do NOT auto-connect — this
  // screen is then a destination, not a bootstrapper.
  useEffect(() => {
    if (didAutoConnect) return;
    didAutoConnect = true;
    const pageHost = typeof window !== 'undefined' ? window.location.host : '';
    const isDev = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
    if (servers.length === 0 && pageHost && !isDev) {
      addServer('This server', pageHost);
    } else if (servers.length > 0 && connectionState === 'disconnected') {
      connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Health dots — probe all saved servers on mount and every 5s while visible.
  useEffect(() => {
    let cancelled = false;
    const sweep = async () => {
      const results = await Promise.all(servers.map(async (e) => [e.id, await probeHealth(resolveHost(e))] as const));
      if (!cancelled) setReachability(Object.fromEntries(results));
    };
    void sweep();
    const t = setInterval(sweep, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [servers]);

  const connected = connectionState === 'authenticated';
  const handleAdd = () => {
    if (!newHost.trim()) return;
    addServer(newLabel, newHost);
    setNewLabel('');
    setNewHost('');
    setShowAdd(false);
  };

  return (
    <div className="flex flex-col h-full">
      <header className="shrink-0 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {connected && (
              <button
                onClick={() => useAppStore.setState({ view: 'home' })}
                className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded-md active:bg-zinc-700 transition-colors"
              >
                &larr; Back
              </button>
            )}
            <h1 className="text-lg font-bold">Servers</h1>
          </div>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="px-3 py-1.5 text-sm bg-zinc-800 text-zinc-300 rounded-lg active:bg-zinc-700 transition-colors"
          >
            + Add
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {servers.length === 0 && !showAdd && (
          <div className="text-center pt-16 space-y-3">
            <div className="text-5xl">&#x1F517;</div>
            <h2 className="text-xl font-bold">PersaLink</h2>
            <p className="text-sm text-zinc-500">Add a server to get started.</p>
            <button
              onClick={() => setShowAdd(true)}
              className="px-6 py-2.5 bg-zinc-100 text-zinc-900 font-semibold rounded-xl active:bg-zinc-300 transition-colors"
            >
              Add server
            </button>
          </div>
        )}

        {showAdd && (
          <div className="space-y-2 p-4 bg-zinc-900 border border-zinc-700 rounded-xl">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label (e.g. Laptop)"
              className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
            />
            <input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="hostname:9877"
              className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-mono text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
              autoFocus
            />
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleAdd}
                disabled={!newHost.trim()}
                className="flex-1 py-2.5 bg-zinc-100 text-zinc-900 text-sm font-semibold rounded-lg active:bg-zinc-300 disabled:opacity-40 transition-colors"
              >
                Add &amp; connect
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="px-4 py-2.5 text-sm text-zinc-500 active:text-zinc-300"
              >
                Cancel
              </button>
            </div>
            <p className="text-[11px] text-zinc-600 leading-snug pt-1">
              Any machine running the PersaLink server (<span className="font-mono">npm i -g persalink</span>).
              You&apos;ll log in once; the token is saved per server.
            </p>
          </div>
        )}

        {servers.map((entry) => (
          <ServerRow
            key={entry.id}
            entry={entry}
            isActive={entry.id === activeServerId}
            reachable={reachability[entry.id]}
            connState={entry.id === activeServerId ? connectionState : 'idle'}
            onRemove={() => removeServer(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}
