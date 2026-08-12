import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Stamped into the bundle AND emitted as /version.json in the same build, so
// a running client can ask the server "what build are you serving?" and know
// whether it's stale (the update pill). Same source, same build — the two can
// only diverge when the client really is out of date.
const BUILD_ID = Date.now().toString(36);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'persalink-emit-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ build: BUILD_ID }),
        });
      },
    },
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@persalink/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
