import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {  defineConfig } from 'vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import reactNativeWeb from 'vite-plugin-react-native-web'
import type {Plugin} from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const reactNativeCssBabel = require('react-native-css/babel')

const emptyModule = resolve(__dirname, './src/empty-module.js')

// Single source of truth for the app display name: public/manifest.json
// `short_name`. Read once at config load, then injected both as a global
// constant (__APP_NAME__) for React code and as an `%APP_NAME%` token in
// index.html. The literal app name lives ONLY in manifest.json.
const manifestPath = resolve(__dirname, './public/manifest.json')
const appName = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { short_name: string }).short_name

const appNamePlugin: Plugin = {
  name: 'oxy-app-name',
  transformIndexHtml(html) {
    return html.replaceAll('%APP_NAME%', appName)
  },
}

// The console runs on rolldown-vite (`"vite": "npm:rolldown-vite@^7"`) so the
// `@oxyhq/services` React Native graph bundles through the maintained
// `vite-plugin-react-native-web` plugin instead of hand-rolled interop: it
// aliases react-native→react-native-web, applies `.web.*` platform extension
// priority in dev AND build, treats RN packages' JSX-in-.js via rolldown
// moduleTypes, strips Flow types, keeps expo-modules-core's side-effectful web
// polyfill (`globalThis.expo`) from being tree-shaken, and defines the RN
// globals.
const config = defineConfig(({ mode }) => ({
  plugins: [
    appNamePlugin,
    reactNativeWeb(),
    TanStackRouterVite(),
    tailwindcss(),
    viteReact({
      babel: {
        presets: [reactNativeCssBabel],
      },
    }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: resolve(__dirname, './src') },
      // Deep native-only internals that monorepo hoisting can pull in
      // transitively and that have no web implementation.
      { find: /^react-native\/Libraries\/.*/, replacement: emptyModule },
      // Native-only navigation primitives used by Bloom's overlay
      // FullWindowOverlay, which on web renders straight through (see shim).
      {
        find: 'react-native-screens',
        replacement: resolve(__dirname, './src/shims/react-native-screens.js'),
      },
      // react-native-svg asset resolution reaches for RN's Flow-typed CJS asset
      // registry; on web the one true registry is react-native-web's (ESM, same
      // registerAsset/getAssetByID API).
      {
        find: '@react-native/assets-registry/registry',
        replacement: 'react-native-web/dist/modules/AssetRegistry',
      },
    ],
  },
  define: {
    // vite-plugin-react-native-web pins __DEV__=false and NODE_ENV=production
    // unconditionally; re-assert the mode-aware values (user config wins over
    // plugin config in Vite's merge).
    __DEV__: JSON.stringify(mode !== 'production'),
    'process.env.NODE_ENV': JSON.stringify(mode),
    __APP_NAME__: JSON.stringify(appName),
  },
  build: {
    outDir: 'dist',
  },
}))

export default config
