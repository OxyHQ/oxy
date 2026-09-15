import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * id.oxy.so is deliberately plain React: no React Native Web, no design-system
 * runtime, no analytics. The page that unseals an identity carries the least
 * code the job needs, all of it first-party (see `worker/headers.mjs` for the
 * policy that enforces it).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // One predictable asset set, so its hashes can be published per release.
    assetsInlineLimit: 0,
  },
});
