#!/usr/bin/env node
/**
 * oxy-web-pwa: makes an Expo web export installable. Run it right after
 * `expo export --platform web`, in the app's `build` script:
 *
 *   expo export --platform web --output-dir dist && oxy-web-pwa dist
 *
 *   oxy-web-pwa [dist] [--no-sw | --remove-sw] [--theme-color=<light>,<dark>]
 *
 * `dist` defaults to `dist`. The step checks the exported manifest
 * (public/manifest.json) against what browsers need to offer installation,
 * adds the manifest link, theme colour, Apple tags and the worker registration
 * to every exported page that lacks them, and ships the Oxy base service
 * worker (`/oxy-sw-base.js`, plus `/sw.js` when the app has none).
 * `--no-sw` skips the worker. `--remove-sw` ships a `/sw.js` that retires a
 * worker shipped before (deletes its caches and unregisters it). `--theme-color=<light>,<dark>` writes the
 * startup `theme-color` as a light/dark pair (the one Bloom adopts at runtime)
 * instead of the manifest's single `theme_color`.
 *
 * Exits 0 when the export is installable, 1 when it is not, 2 on bad usage.
 * See README "Installable web apps".
 */
const { resolve } = require('node:path');
const { PwaError, makeInstallable } = require('../web/pwa');

const usage = 'oxy-web-pwa [dist] [--no-sw | --remove-sw] [--theme-color=<light>,<dark>]';
const args = process.argv.slice(2);
let dist = 'dist';
let serviceWorker = true;
let removeServiceWorker = false;
let themeColors;
for (const arg of args) {
  if (arg === '--help' || arg === '-h') {
    console.log(usage);
    process.exit(0);
  } else if (arg === '--no-sw') serviceWorker = false;
  else if (arg === '--remove-sw') removeServiceWorker = true;
  else if (arg.startsWith('--theme-color='))
    themeColors = arg
      .slice('--theme-color='.length)
      .split(',')
      .map((color) => color.trim());
  else if (arg.startsWith('-')) {
    console.error(`Unknown option ${arg}\n${usage}`);
    process.exit(2);
  } else dist = arg;
}

try {
  const result = makeInstallable(resolve(dist), {
    serviceWorker,
    removeServiceWorker,
    themeColors,
  });
  for (const warning of result.warnings) console.warn(`oxy-web-pwa: warning: ${warning}`);
  console.log(
    `oxy-web-pwa: ${result.manifest} is installable; ${result.updated.length} of ${result.pages} pages updated` +
      (result.worker ? `; service worker: ${result.worker}` : '; no service worker'),
  );
} catch (error) {
  if (error instanceof PwaError) {
    console.error(`oxy-web-pwa: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
