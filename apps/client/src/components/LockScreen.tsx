import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

export function LockScreen() {
  const { unlockWithBiometric, disconnect, connect, serverUrl } = useAppStore();
  const [unlocking, setUnlocking] = useState(false);
  const [failed, setFailed] = useState(false);

  // Auto-prompt biometric on mount
  useEffect(() => {
    handleUnlock();
  }, []);

  const handleUnlock = async () => {
    setUnlocking(true);
    setFailed(false);
    const ok = await unlockWithBiometric();
    setUnlocking(false);
    if (ok) {
      // Token restored from keychain, now connect
      if (serverUrl) {
        // Go to connect view and trigger connection
        useAppStore.setState({ view: 'connect' });
        setTimeout(() => useAppStore.getState().connect(), 0);
      }
    } else {
      setFailed(true);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="text-5xl">&#x1F512;</div>
          <h1 className="text-2xl font-bold tracking-tight">PersaLink</h1>
          <p className="text-zinc-500 text-sm">Unlock with biometrics to continue</p>
        </div>

        <div className="space-y-3">
          <button
            onClick={handleUnlock}
            disabled={unlocking}
            className="w-full py-3 bg-zinc-100 text-zinc-900 font-semibold rounded-xl
                       hover:bg-zinc-200 active:bg-zinc-300
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
          >
            {unlocking ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-zinc-400 border-t-zinc-900 rounded-full animate-spin" />
                Verifying...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 11c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2m-6-2c0-3.3 2.7-6 6-6s6 2.7 6 6m-2 0c0-2.2-1.8-4-4-4s-4 1.8-4 4m-2 0c0 1.5.5 2.8 1.3 3.8" />
                </svg>
                Unlock with Fingerprint
              </span>
            )}
          </button>

          {failed && (
            <p className="text-amber-400 text-sm text-center">
              Biometric verification failed. Try again or disconnect.
            </p>
          )}

          <button
            onClick={disconnect}
            className="w-full py-2 text-zinc-500 text-sm hover:text-zinc-300 transition-colors"
          >
            Disconnect &amp; Use Password
          </button>
        </div>
      </div>
    </div>
  );
}
