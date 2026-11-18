import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';

// Stamped into the bundle AND emitted as /version.json in the same build, so
// a running client can ask the server "what build are you serving?" and know
// whether it's stale (the update pill). Same source, same build — the two can
// only diverge when the client really is out of date.
const BUILD_ID = Date.now().toString(36);

// Captured from the resolved config by the manifest plugin below.
let baseForManifest = '/';
let outDirForManifest = '';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // A preview build (vite --base /beta/) gets its own install identity:
      // start_url, scope and the share target stay inside the base, so an
      // installed preview, its deep links (?profile=, ?session=) and shares
      // never open the live app — and vice versa. Icons stay at the origin
      // root, where the live build serves them. The live build is untouched.
      name: 'persalink-base-manifest',
      apply: 'build',
      configResolved(config) { baseForManifest = config.base; outDirForManifest = path.resolve(config.root, config.build.outDir); },
      closeBundle() {
        if (baseForManifest === '/' || !outDirForManifest) return;
        const file = path.join(outDirForManifest, 'manifest.webmanifest');
        if (!fs.existsSync(file)) return;
        const m = JSON.parse(fs.readFileSync(file, 'utf-8'));
        m.id = baseForManifest;
        m.start_url = baseForManifest;
        m.scope = baseForManifest;
        if (m.share_target) m.share_target.action = baseForManifest;
        m.name = `${m.name} Beta`;
        m.short_name = `${m.short_name} Beta`;
        fs.writeFileSync(file, JSON.stringify(m, null, 2));
      },
    },
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
    rollupOptions: {
      output: {
        // Split rarely-changing dependencies from app code so a deploy only
        // invalidates the small app chunk. Before this, every deploy forced
        // clients to re-pull one ~810KB bundle — painful through a cold or
        // DERP-relayed Tailscale tunnel (the "slow to connect after updates"
        // report, 2026-08-19).
        manualChunks: (id: string) =>
          id.includes('node_modules') ? 'vendor' : undefined,
      },
    },
  },
});
