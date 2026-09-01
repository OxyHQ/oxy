import { resolve } from "path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import reactNativeWeb from "vite-plugin-react-native-web";

const emptyModule = resolve(__dirname, "src/empty-module.js");
const require = createRequire(import.meta.url);
const reactNativeCssBabel = require("react-native-css/babel");

// The IdP runs on rolldown-vite (`"vite": "npm:rolldown-vite@^7"`) so the
// `@oxyhq/services` React Native graph bundles through the maintained
// `vite-plugin-react-native-web` plugin instead of hand-rolled empty-module
// stubs: it aliases react-native→react-native-web, applies `.web.*` platform
// extension priority in dev AND build, treats RN packages' JSX-in-.js via
// rolldown moduleTypes, strips Flow types, keeps expo-modules-core's
// side-effectful web polyfill (`globalThis.expo`) from being tree-shaken, and
// defines the RN globals.
export default defineConfig(({ mode }) => ({
  plugins: [
    reactNativeWeb(),
    react({
      babel: {
        presets: [reactNativeCssBabel],
      },
    }),
  ],
  resolve: {
    alias: [
      // Auth's `@/*` maps to the package ROOT (see tsconfig `paths`), not src.
      { find: "@", replacement: resolve(__dirname, ".") },
      // Deep native-only internals that monorepo hoisting can pull in
      // transitively and that have no web implementation.
      { find: /^react-native\/Libraries\/.*/, replacement: emptyModule },
      // react-native-svg asset resolution reaches for RN's Flow-typed CJS asset
      // registry; on web the one true registry is react-native-web's (ESM, same
      // registerAsset/getAssetByID API).
      {
        find: "@react-native/assets-registry/registry",
        replacement: "react-native-web/dist/modules/AssetRegistry",
      },
    ],
  },
  define: {
    // vite-plugin-react-native-web pins __DEV__=false and NODE_ENV=production
    // unconditionally; re-assert the mode-aware values (user config wins over
    // plugin config in Vite's merge).
    __DEV__: JSON.stringify(mode !== "production"),
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  server: {
    port: 8105,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
}));
