/**
 * Expo config-plugin entry point for `@oxy.so/expo-splash`.
 *
 * Expo resolves `"@oxy.so/expo-splash"` in an app's `plugins` array to this
 * `app.plugin.js` at the package root. It re-exports the branding config plugin
 * so an app adopts the shared Oxy bottom branding with a single entry:
 *
 *   plugins: ["@oxy.so/expo-splash"]           // defaults (bundled Oxy asset)
 *   plugins: [["@oxy.so/expo-splash", { imageWidth: 56 }]]  // with options
 *
 * MUST be listed AFTER the `expo-splash-screen` plugin (which generates the
 * Android splash theme + iOS LaunchScreen storyboard this plugin augments).
 */
module.exports = require('./plugin/withOxySplashBranding');
