/**
 * Tells `@oxy.so/core` which platform it runs on.
 *
 * Core never imports `react-native`, so on iOS and Android it cannot detect the
 * platform by itself (`navigator.product === 'ReactNative'` only says "native"
 * and it answers `'unknown'`). Until this runs, `isNative()`, `isIOS()` and
 * `isAndroid()` are false on a phone: the shared identity key is not read, the
 * Commons session fallback is off, and Android-only identity paths are skipped.
 *
 * Every client entry imports this module FIRST (`index.ts`, `ui/index.ts`,
 * `ui/client.ts`), so an app that keeps to a lean entry gets the same platform
 * as one that imports the root barrel. `__tests__/boot/cryptoPolyfillOrder.test.ts` pins it.
 */
import { setPlatformOS, type PlatformOS } from '@oxy.so/core';
import { Platform } from 'react-native';

setPlatformOS(Platform.OS as PlatformOS);
