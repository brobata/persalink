import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';

export function ConnectScreen() {
  const { serverUrl, setServerUrl, connect, connectionState } = useAppStore();
  const [input, setInput] = useState(serverUrl || '');
  const [showEditor, setShowEditor] = useState(false);
  const failCount = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (serverUrl && connectionState === 'disconnected') {
      connect();
    }
  }, []);

  // Track connection failures — show editor after 2 failed attempts
  useEffect(() => {
    if (connectionState === 'disconnected' && started.current) {
      failCount.current++;
      if (failCount.current >= 2) {
        setShowEditor(true);
      }
    }
    if (connectionState === 'connected' || connectionState === 'authenticated') {
      failCount.current = 0;
    }
  }, [connectionState]);

  const handleConnect = () => {
    if (!input.trim()) return;
    setServerUrl(input.trim());
    failCount.current = 0;
    setTimeout(() => useAppStore.getState().connect(), 0);
  };

  const isConnecting = connectionState === 'connecting';

  // Show editor if connection failed or no server URL
  if (showEditor || !serverUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6">
        <div className="w-full max-w-sm space-y-8">
          <div className="text-center space-y-2">
            <div className="text-5xl">&#x1F517;</div>
            <h1 className="text-2xl font-bold tracking-tight">PersaLink</h1>
            <p className="text-zinc-500 text-sm">
              {serverUrl ? `Can't reach ${serverUrl}` : 'Enter server address'}
            </p>
          </div>

          <div className="space-y-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              placeholder="hostname:9877"
              className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl
                         text-zinc-100 placeholder-zinc-600 text-center text-lg
                         focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600
                         transition-colors"
              autoFocus
              disabled={isConnecting}
            />

            <button
              onClick={handleConnect}
              disabled={!input.trim() || isConnecting}
              className="w-full py-3 bg-zinc-100 text-zinc-900 font-semibold rounded-xl
                         hover:bg-zinc-200 active:bg-zinc-300
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors"
            >
              {isConnecting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-zinc-400 border-t-zinc-900 rounded-full animate-spin" />
                  Connecting...
                </span>
              ) : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Default: show spinner while auto-connecting
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="text-5xl">&#x1F517;</div>
        <h1 className="text-2xl font-bold tracking-tight">PersaLink</h1>
        <div className="flex items-center justify-center gap-2 text-zinc-500 text-sm">
          <span className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
          Connecting to {serverUrl}...
        </div>
      </div>
    </div>
  );
}
