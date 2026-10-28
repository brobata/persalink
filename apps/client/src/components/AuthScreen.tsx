import { useState } from 'react';
import { useAppStore } from '../stores/appStore';

export function AuthScreen() {
  const { authenticate, authError, setupMode, disconnect, biometricAvailable, secondFactor, approvalNumber } = useAppStore();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  // Public door: the password alone is never enough. A typed authenticator
  // code wins; otherwise ask the phone (when it has notifications on).
  const codeReady = /^\d{6}$/.test(code);
  // A half-typed code must not silently turn into a phone request.
  const codePartial = code.length > 0 && !codeReady;
  // Code-only public door: no password at all, the code is the login.
  // (Never in setup mode: that screen creates the password.)
  const codeOnly = !!secondFactor?.codeOnly && !setupMode;
  const canSubmit = (codeOnly || !!password) && !codePartial
    && (!secondFactor || codeReady || secondFactor.push || !secondFactor.totp);
  const handleSubmit = () => {
    if (!canSubmit) return;
    if (!secondFactor) authenticate(password);
    else if (codeReady) authenticate(password, undefined, { totp: code });
    else authenticate(password, undefined, { approval: true });
    setCode('');
  };

  if (approvalNumber) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6">
        <div className="w-full max-w-sm space-y-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Check your phone</h1>
          <p className="text-zinc-400 text-sm">Tap Approve on the PersaLink notification if it shows this number:</p>
          <div className="text-6xl font-bold tabular-nums">{approvalNumber}</div>
          <p className="text-zinc-500 text-xs">Waiting up to a minute…</p>
        </div>
      </div>
    );
  }

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
              : codeOnly
                ? 'Enter the code from your authenticator app'
                : 'Enter your server password'}
          </p>
        </div>

        <div className="space-y-3">
          {!codeOnly && <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder={setupMode ? 'Create password (8+ chars)' : 'Password'}
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl
                       text-zinc-100 placeholder-zinc-600 text-center text-lg
                       focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
            autoFocus
          />}

          {secondFactor?.totp && (
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder={secondFactor.push ? 'Authenticator code (or leave blank)' : 'Authenticator code'}
              autoFocus={codeOnly}
              className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl
                         text-zinc-100 placeholder-zinc-600 text-center text-lg tracking-widest
                         focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600"
            />
          )}

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
            disabled={!canSubmit}
            className="w-full py-3 bg-zinc-100 text-zinc-900 font-semibold rounded-xl
                       hover:bg-zinc-200 active:bg-zinc-300
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
          >
            {setupMode ? 'Set Password'
              : secondFactor?.push && !codeReady ? 'Unlock — approve on my phone' : 'Unlock'}
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
