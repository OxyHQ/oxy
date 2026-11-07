/**
 * What kind of device an Oxy sign-in runs on. The sign-in screen and its
 * Commons delivery decide by it (`resolveSignInMethods`,
 * `resolveDeliveryPlatform`):
 *
 *  - `browser`  — react-native-web in a browser, on a phone or a computer
 *                 (`resolveDeliveryPlatform` tells those apart);
 *  - `phone`    — a native app on a phone or tablet (iOS, Android): the device
 *                 Commons lives on, and the one that scans a QR;
 *  - `computer` — a native app on a computer (react-native-macos, OxyOS, any
 *                 other desktop platform): no Commons to continue with and no
 *                 camera to scan with. Like a browser on a computer, it SHOWS
 *                 the QR a phone scans.
 *
 * A native platform is a phone only by name (`ios`, `android`); every other
 * one is a computer, so a desktop platform the SDK does not know yet gets the
 * QR rather than a "Continue with Oxy" that has nowhere to go.
 */

import { Platform } from 'react-native';
import { isWebBrowser } from './isWebBrowser';

export type SignInDevice = 'browser' | 'phone' | 'computer';

export function resolveSignInDevice(): SignInDevice {
  if (isWebBrowser()) return 'browser';
  return Platform.OS === 'ios' || Platform.OS === 'android' ? 'phone' : 'computer';
}
