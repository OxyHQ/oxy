import { dirname, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import reactNativeWeb from "vite-plugin-react-native-web"

const currentDir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const reactNativeCssBabel = require("react-native-css/babel")
const emptyModule = resolve(currentDir, "./src/empty-module.js")

// test-app-vite bundles the `@oxyhq/services` React Native graph on the web via
// rolldown-vite + `vite-plugin-react-native-web` (same pattern as packages/console):
// it aliases react-native → react-native-web, applies `.web.*` extension priority
// in dev AND build, strips Flow types, keeps expo-modules-core's side-effectful web
// polyfill from being tree-shaken, and defines the RN globals.
export default defineConfig(({ mode }) => ({
  plugins: [
    reactNativeWeb(),
    tailwindcss(),
    viteReact({
      babel: {
        presets: [reactNativeCssBabel],
      },
    }),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: resolve(currentDir, "./src") },
      // Deep native-only internals that monorepo hoisting can pull in
      // transitively and that have no web implementation.
      { find: /^react-native\/Libraries\/.*/, replacement: emptyModule },
      // Native-only navigation primitives used by Bloom's overlay
      // FullWindowOverlay, which on web renders straight through (see shim).
      {
        find: "react-native-screens",
        replacement: resolve(currentDir, "./src/shims/react-native-screens.js"),
      },
      // react-native-svg asset resolution reaches for RN's Flow-typed CJS asset
      // registry; on web the one true registry is react-native-web's.
      {
        find: "@react-native/assets-registry/registry",
        replacement: "react-native-web/dist/modules/AssetRegistry",
      },
    ],
  },
  define: {
    // vite-plugin-react-native-web pins __DEV__=false and NODE_ENV=production
    // unconditionally; re-assert the mode-aware values (user config wins).
    __DEV__: JSON.stringify(mode !== "production"),
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  build: {
    outDir: "dist",
  },
}))
