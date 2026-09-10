import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

/**
 * Native-splash lifecycle helpers for an Expo app's root `_layout`.
 *
 * The Oxy splash pattern makes the NATIVE OS splash the single splash on native
 * (app logo centered by `expo-splash-screen` + Oxy branding pinned to the bottom
 * by the `@oxy.so/expo-splash` config plugin). The app HOLDS the OS splash at
 * module load and HIDES it once it is ready to paint real UI, so there is no
 * blank gap between the OS splash and the first real frame — and no duplicate
 * custom splash on native.
 *
 * On web these are no-ops: the OS splash was never held, and the app's own
 * `AppSplashScreen` React overlay handles the transition (gated to web).
 */

/**
 * Hold the native OS splash so it stays visible until the app calls
 * {@link hideNativeSplash}. Call this ONCE at module scope in `_layout`, before
 * any navigator mounts.
 *
 * No-op on web. `preventAutoHideAsync` can reject if called too late; the
 * rejection is swallowed because a failure here just means the OS splash hides
 * at the first JS frame — the web-only custom splash never depends on it.
 */
export function preventNativeSplashAutoHide(): void {
  if (Platform.OS === 'web') {
    return;
  }
  SplashScreen.preventAutoHideAsync().catch(() => {
    // Ignored on purpose — see the doc comment above.
  });
}

/**
 * Hide the held native OS splash. Call this once the app is ready to render real
 * UI (see {@link useHideNativeSplashWhenReady} for the common effect wiring).
 *
 * No-op on web. `hideAsync` rejection is swallowed (the splash may already be
 * hidden or was never held).
 */
export function hideNativeSplash(): void {
  if (Platform.OS === 'web') {
    return;
  }
  SplashScreen.hideAsync().catch(() => {
    // Ignored on purpose — the splash may already be hidden.
  });
}

/**
 * Hide the held native OS splash as soon as `appIsReady` flips to `true`.
 *
 * Wire this in the root `_layout` component so the OS splash stays up until the
 * app has finished loading fonts + running init, then hides at the exact moment
 * real UI is ready (no blank gap). No-op on web.
 *
 *   preventNativeSplashAutoHide(); // module scope
 *
 *   function RootLayout() {
 *     const [appIsReady, setAppIsReady] = useState(false);
 *     // ...set appIsReady when init completes
 *     useHideNativeSplashWhenReady(appIsReady);
 *     // ...
 *   }
 */
export function useHideNativeSplashWhenReady(appIsReady: boolean): void {
  useEffect(() => {
    if (appIsReady) {
      hideNativeSplash();
    }
  }, [appIsReady]);
}
