import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

// Self-hosted terminal fonts — variable where available so a single file
// covers all weights the TerminalSettings UI exposes (300-600).
import '@fontsource-variable/cascadia-code';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/fira-code';
import '@fontsource-variable/source-code-pro';
import '@fontsource/ibm-plex-mono/300.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';

// Insecure-origin → HTTPS bounce.
//
// The Node server listens on plain HTTP :9877, so reaching it via a LAN IP
// (http://192.168.1.44:9877) or the raw Tailscale IP yields an *insecure*
// context. That silently strips every secure-context-only feature — most
// visibly the voice-dictation mic (Web Speech API), but also service workers
// and async clipboard. `tailscale serve` fronts the same server with TLS at
// the MagicDNS hostname, so bounce insecure non-localhost loads there before
// React mounts (avoids flashing the feature-stripped UI).
//
// Override the target per-deployment with VITE_PERSALINK_HTTPS_URL at build
// time; the default is this box's MagicDNS hostname.
const HTTPS_ORIGIN =
  (import.meta as { env?: { VITE_PERSALINK_HTTPS_URL?: string } }).env
    ?.VITE_PERSALINK_HTTPS_URL || 'https://x570d4u.azules-duck.ts.net';

function redirectToSecureOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) {
    // Already secure (https, or localhost which browsers treat as secure).
    // Clear the loop guard so a later insecure load this session re-bounces.
    try { sessionStorage.removeItem('pl_https_redirect'); } catch { /* ignore */ }
    return false;
  }
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;

  let target: URL;
  try { target = new URL(HTTPS_ORIGIN); } catch { return false; }
  if (target.hostname === host) return false; // would loop — TLS not actually there

  // One bounce per session: if the secure host turns out to redirect back to
  // us (misconfig), don't ping-pong forever.
  try {
    if (sessionStorage.getItem('pl_https_redirect') === '1') return false;
    sessionStorage.setItem('pl_https_redirect', '1');
  } catch { /* private mode — proceed without the guard */ }

  target.pathname = window.location.pathname;
  target.search = window.location.search;
  target.hash = window.location.hash;
  window.location.replace(target.toString());
  return true;
}

if (!redirectToSecureOrigin()) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  // Service worker registration — needed for PWA install prompts. Only
  // registers in secure contexts (https or localhost); the browser blocks
  // SW registration on insecure HTTP origins anyway.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[PersaLink] SW registration failed:', err);
      });
    });
  }
}
