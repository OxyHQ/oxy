/**
 * `@oxy.so/expo-splash` — shared native-splash toolkit for Oxy Expo apps.
 *
 * Generalizes the on-device-verified Mention splash pattern so every Oxy Expo
 * app adopts the same "Instagram, from Meta" splash: the app's OWN logo centered
 * on the shared dark brand background, with the Oxy "from Oxy" symbol pinned to
 * the bottom of the native OS splash.
 *
 * This entry (`@oxy.so/expo-splash`) exports the RUNTIME lifecycle helpers used
 * in an app's root `_layout`. The two BUILD-TIME pieces are separate,
 * CommonJS-only entry points (so they resolve in `app.config.js` / at prebuild
 * without a bundler):
 *
 *   - `@oxy.so/expo-splash`         (in `plugins`)  → the Oxy bottom-branding
 *                                                     config plugin (app.plugin.js)
 *   - `@oxy.so/expo-splash/config`  (in app.config) → `oxySplashScreenPlugin(...)`
 *                                                     builds the expo-splash-screen tuple
 */
export {
  preventNativeSplashAutoHide,
  hideNativeSplash,
  useHideNativeSplashWhenReady,
} from './lifecycle';
