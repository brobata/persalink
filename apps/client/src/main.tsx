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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
