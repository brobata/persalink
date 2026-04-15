import { useState } from 'react';
import { useAppStore } from '../stores/appStore';

export function AuthScreen() {
  const { authenticate, authError, setupMode, disconnect, biometricAvailable } = useAppStore();
  const [password, setPassword] = useState('');

  const handleSubmit = () => {
    if (!password) return;
    authenticate(password);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="text-5xl">{setupMode ? '\uD83D\uDD10' : '\uD83D\uDD12'}</div>
          <h1 className="text-2xl font-bold tracking-tight">
            {setupMode ? 'Set Password' : 'Authenticate'}
          </h1>
          <p className="text-zinc-500 text-sm">
            {setupMode
              ? 'Create a password for your server'
              : 'Enter your server password'}
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder={setupMode ? 'Create password (8+ chars)' : 'Password'}
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl
                       text-zinc-100 placeholder-zinc-600 text-center text-lg
                       focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
            autoFocus
          />

          {biometricAvailable && (
            <p className="text-zinc-500 text-xs text-center">
              Your fingerprint will protect future logins
            </p>
          )}

          {authError && (
            <p className="text-red-400 text-sm text-center">{authError}</p>
          )}

          <button
            onClick={handleSubmit}
            disabled={!password}
            className="w-full py-3 bg-zinc-100 text-zinc-900 font-semibold rounded-xl
                       hover:bg-zinc-200 active:bg-zinc-300
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
          >
            {setupMode ? 'Set Password' : 'Unlock'}
          </button>

          <button
            onClick={disconnect}
            className="w-full py-2 text-zinc-500 text-sm hover:text-zinc-300 transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
