// Use the real IdP's maintained React Native Web build configuration for the
// SDK graph. Only the disposable RP input, output, aliases and cache differ.
import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import authConfig from '../../../packages/auth/vite.config';

export default defineConfig((environment) => mergeConfig(authConfig(environment), {
  cacheDir: resolve(process.cwd(), '.integration-evidence', `vite-rp-${process.env.VITE_FIXTURE_LANE}`),
  resolve: { alias: [
    { find: 'react-dom', replacement: resolve(process.cwd(), 'packages/services/node_modules/react-dom') },
    { find: 'react', replacement: resolve(process.cwd(), 'packages/services/node_modules/react') },
    { find: /^@oxy\.so\/services$/, replacement: resolve(process.cwd(), 'packages/services/lib/module/index.js') },
  ] },
  build: {
    outDir: resolve(process.cwd(), '.integration-evidence', 'browser-build'),
    rollupOptions: { input: resolve(process.cwd(), 'scripts/rehearsal/real-oauth-browser/index.html') },
  },
  server: { host: '127.0.0.1', port: 17962, strictPort: true },
}));
