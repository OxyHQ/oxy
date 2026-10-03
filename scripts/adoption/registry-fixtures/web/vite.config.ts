import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import reactNativeWeb from 'vite-plugin-react-native-web';
const require = createRequire(import.meta.url);
const reactNativeCssBabel = require('react-native-css/babel');
const root = realpathSync(__dirname);
function registryGraph(): Plugin {
  return {
    name: 'registry-fixture-graph',
    generateBundle() {
      const files = [...this.getModuleIds()].filter((id) => id.includes('/node_modules/@oxy.so/') || id.includes('/@oxy.so/')).map((id) => id.split('?')[0]);
      const paths = [...new Set(files.filter((id) => !id.startsWith('\0')).map((id) => realpathSync(id)))];
      if (!paths.length || paths.some((id) => !id.startsWith(root + '/node_modules/'))) throw new Error('Registry fixture escaped installed SDK graph');
      this.emitFile({ type: 'asset', fileName: 'registry-modules.json', source: JSON.stringify(paths, null, 2) });
    },
  };
}
export default defineConfig(({ mode }) => ({
  // Same maintained RN web transform as the accepted IdP/RP. No SDK aliases.
  plugins: [reactNativeWeb(), react({ babel: { presets: [reactNativeCssBabel] } }), registryGraph()],
  resolve: {
    dedupe: ['react', 'react-dom', '@oxy.so/bloom', '@oxy.so/core', '@oxy.so/contracts', '@oxy.so/services'],
    alias: [
      { find: /^react-native\/Libraries\/.*/, replacement: resolve(__dirname, 'empty-module.js') },
      { find: '@react-native/assets-registry/registry', replacement: 'react-native-web/dist/modules/AssetRegistry' },
    ],
  },
  define: { __DEV__: JSON.stringify(mode !== 'production'), 'process.env.NODE_ENV': JSON.stringify(mode) },
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: 'dist', rollupOptions: { input: resolve(__dirname, 'index.html') } },
}));
