import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { isPushSupported, notificationPermission } from '../lib/push';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Full-screen log viewer with a grep-style line filter — the point of session
// logs is answering "what did that overnight run print", so filtering beats
// scrolling half a megabyte of output.
function LogViewer() {
  const { logView, closeLogView } = useAppStore();
  const [filter, setFilter] = useState('');
  const lines = useMemo(() => {
    if (!logView) return [];
    const all = logView.data.split('\n');
    if (!filter.trim()) return all;
    const q = filter.toLowerCase();
    return all.filter((l) => l.toLowerCase().includes(q));
  }, [logView, filter]);
  if (!logView) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 bg-zinc-900 border-b border-zinc-800 pt-[max(12px,env(safe-area-inset-top))]">
        <span className="flex-1 min-w-0 text-sm font-mono text-zinc-300 truncate">{logView.name}</span>
        <button onClick={closeLogView} className="px-3 py-1.5 text-sm text-zinc-300 bg-zinc-800 active:bg-zinc-700 rounded-lg">Close</button>
      </div>
      <div className="shrink-0 px-4 py-2 bg-zinc-900/60 border-b border-zinc-800 flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter lines…"
          className="flex-1 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
        <span className="shrink-0 text-[10px] text-zinc-600">{lines.length} lines{logView.truncated ? ' · tail' : ''}</span>
      </div>
      <pre className="flex-1 overflow-auto p-4 text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
        {lines.join('\n')}
      </pre>
    </div>
  );
}

export function SettingsScreen() {
  const {
    closeOverlay, disconnect, serverName, serverUrl, sessions, profiles,
    notificationsEnabled, enableNotifications, disableNotifications, testNotification,
    sessionLogs, requestLogs, readLog, logView,
  } = useAppStore();

  const [busy, setBusy] = useState(false);

  // Session logs live server-side; ask once when Settings opens.
  useEffect(() => { requestLogs(); }, [requestLogs]);
  const pushSupported = isPushSupported();
  const perm = notificationPermission();

  const toggleNotifications = async () => {
    setBusy(true);
    try {
      if (notificationsEnabled) await disableNotifications();
      else await enableNotifications();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <header className="shrink-0 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <button
            onClick={closeOverlay}
            className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded-md
                       hover:bg-zinc-700 transition-colors"
          >
            &larr; Back
          </button>
          <h1 className="text-lg font-bold">Settings</h1>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {/* Server Info */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400">Server</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Name</span>
              <span>{serverName || 'Unknown'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">URL</span>
              <span className="text-zinc-400 font-mono text-xs">{serverUrl}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Sessions</span>
              <span>{sessions.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Profiles</span>
              <span>{profiles.length}</span>
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400">Notifications</h2>
          {!pushSupported ? (
            <p className="text-xs text-zinc-500">
              Not available here. Web Push needs HTTPS, and on iOS the app must be added to your home screen.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200">Agent alerts</p>
                  <p className="text-xs text-zinc-500">
                    Get notified when a session finishes, needs your input, or errors — even when the app is closed.
                  </p>
                </div>
                <button
                  onClick={toggleNotifications}
                  disabled={busy || perm === 'denied'}
                  aria-pressed={notificationsEnabled}
                  className={`shrink-0 relative w-12 h-7 rounded-full transition-colors ${
                    notificationsEnabled ? 'bg-emerald-500' : 'bg-zinc-700'
                  } ${busy || perm === 'denied' ? 'opacity-50' : ''}`}
                >
                  <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${
                    notificationsEnabled ? 'left-6' : 'left-1'
                  }`} />
                </button>
              </div>
              {perm === 'denied' && (
                <p className="text-xs text-amber-400">
                  Blocked in your browser settings — allow notifications for this site, then toggle again.
                </p>
              )}
              {notificationsEnabled && (
                <button
                  onClick={testNotification}
                  className="text-xs text-zinc-400 underline underline-offset-2 active:text-zinc-200"
                >
                  Send a test notification
                </button>
              )}
            </>
          )}
        </section>

        {/* Session logs (server-side, per-profile opt-in) */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400">Session logs</h2>
          {(!sessionLogs || sessionLogs.length === 0) ? (
            <p className="text-xs text-zinc-500">
              No logs yet. Turn on &ldquo;Log session output&rdquo; in a profile&apos;s Advanced
              settings — output is captured on the server (14 days / 200 MB cap) and
              searchable here even after the session ends.
            </p>
          ) : (
            <div className="space-y-1">
              {sessionLogs.map((log) => (
                <button
                  key={log.name}
                  onClick={() => readLog(log.name)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-800/60 active:bg-zinc-700 transition-colors text-left"
                >
                  <span className="flex-1 min-w-0 text-xs font-mono text-zinc-200 truncate">{log.name}</span>
                  <span className="shrink-0 text-[10px] text-zinc-500">{fmtSize(log.size)}</span>
                  <span className="shrink-0 text-[10px] text-zinc-600">{new Date(log.mtime).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Danger Zone */}
        <section className="space-y-3">
          <button
            onClick={() => { disconnect(); }}
            className="w-full py-3 bg-red-900/20 border border-red-900/30 text-red-400
                       rounded-xl text-sm font-medium hover:bg-red-900/30 transition-colors"
          >
            Disconnect
          </button>
        </section>
      </div>

      {logView && <LogViewer />}
    </div>
  );
}
