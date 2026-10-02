import { defineConfig, transformWithEsbuild } from 'vite';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  plugins: [
    // Metro resolves platform-specific directory entries before the generic index.
    { name: 'web-directory-entries', enforce: 'pre', resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return;
      for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
        const entry = resolve(dirname(importer), source, `index.web${extension}`);
        if (existsSync(entry)) return { id: entry, moduleSideEffects: true };
      }
    }, transform(code, id) {
      if (/\/expo-modules-core\/src\/index\.ts$/.test(id) || /\/index\.web\.[tj]sx?$/.test(id)) return { code, moduleSideEffects: true };
    } },
    { name: 'native-jsx', enforce: 'pre', async transform(code, id) {
      if (/node_modules\/.*\.js$/.test(id)) return transformWithEsbuild(code, id, { loader: 'jsx', jsx: 'automatic' });
    } },
  ],
  esbuild: { jsx: 'automatic' },
  build: { commonjsOptions: { transformMixedEsModules: true } },
  optimizeDeps: { esbuildOptions: { loader: { '.js': 'jsx' }, resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.mjs', '.js', '.ts', '.tsx', '.json'] } },
  resolve: { alias: [{ find: 'react-dom', replacement: resolve(process.cwd(), 'packages/services/node_modules/react-dom') }, { find: 'react', replacement: resolve(process.cwd(), 'packages/services/node_modules/react') }, { find: /^@oxy\.so\/services$/, replacement: resolve(process.cwd(), 'packages/services/lib/module/index.js') }, { find: /^react-native$/, replacement: 'react-native-web' }], dedupe: ['react','react-dom','react-native-web'], extensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.mjs', '.js', '.ts', '.tsx', '.json'] },
  define: { global: 'globalThis', __DEV__: JSON.stringify(mode !== 'production'), 'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development') },
  server: {
    port: 17857,
    host: 'localhost',
  },
}));
