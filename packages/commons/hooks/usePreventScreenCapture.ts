import { useEffect, useId } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type ScreenCaptureApi = Pick<
  typeof import('expo-screen-capture'),
  'preventScreenCaptureAsync' | 'allowScreenCaptureAsync'
>;

/**
 * `expo-screen-capture`, or `null` when this binary does not link it.
 *
 * Commons ships JavaScript over the air to binaries that are already installed.
 * A binary built before the module was added has no `ExpoScreenCapture` native
 * module, and `expo-screen-capture` calls `requireNativeModule` when it is first
 * evaluated, which throws. So the package is required lazily, and only after
 * `requireOptionalNativeModule` says the native half is present: an old binary
 * keeps working (without the protection) and a new one is protected.
 */
function loadScreenCapture(): ScreenCaptureApi | null {
  if (Platform.OS === 'web') return null;
  if (!requireOptionalNativeModule('ExpoScreenCapture')) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-screen-capture') as ScreenCaptureApi;
}

/**
 * Blocks screenshots and screen recording while the calling component is
 * mounted and `active` is true: `FLAG_SECURE` on the Android window (which also
 * blanks the app in Recents) and the secure-layer capture guard on iOS.
 *
 * For any surface that shows or takes secret material: the recovery phrase and
 * a raw private key. It deliberately does NOT hide anything from the
 * accessibility tree; a TalkBack or VoiceOver user still needs to hear the words
 * in order to write them down.
 *
 * Each caller gets its own key (`useId`), so two protected surfaces mounted at
 * once cannot re-allow capture for each other: `expo-screen-capture` only lifts
 * the flag once every key has been released.
 */
export function usePreventScreenCapture(active: boolean = true): void {
  const key = `commons-secret-${useId()}`;

  useEffect(() => {
    if (!active) return undefined;
    const screenCapture = loadScreenCapture();
    if (!screenCapture) return undefined;

    screenCapture.preventScreenCaptureAsync(key).catch((error: unknown) => {
      console.warn('[usePreventScreenCapture] Could not block screen capture', error);
    });
    return () => {
      screenCapture.allowScreenCaptureAsync(key).catch((error: unknown) => {
        console.warn('[usePreventScreenCapture] Could not re-allow screen capture', error);
      });
    };
  }, [active, key]);
}
