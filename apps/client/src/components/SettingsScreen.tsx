import { useAppStore } from '../stores/appStore';

export function SettingsScreen() {
  const { closeOverlay, disconnect, serverName, serverUrl, sessions, profiles } = useAppStore();

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
    </div>
  );
}
