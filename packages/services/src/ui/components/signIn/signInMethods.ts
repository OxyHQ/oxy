/**
 * Which Commons way in a sign-in surface offers, from where it runs. Every
 * surface also takes an email or username (`OxySignInPanel`), in place:
 *
 *  - the web: the embedded QR (the split card's right column from `md`, with
 *    "Continue with Oxy" below `md`, where the screen is the phone that would
 *    scan it);
 *  - native: "Continue with Oxy", and "Get Commons" on a device that has no
 *    Commons to continue with.
 */

import type { CommonsAvailability } from '@oxy.so/core/session';

/**
 * `qr`          — the web: the embedded QR from `md`, "Continue with Oxy" below.
 * `continue`    — native "Continue with Oxy": Oxy picks the route (shared
 *                 keychain, Commons on this device, a push, or the QR view).
 * `get-commons` — native, and Commons is not installed here.
 */
export type CommonsEntry = 'qr' | 'continue' | 'get-commons';

export interface SignInMethods {
  commons: CommonsEntry;
}

export interface SignInSurfaceFacts {
  /** Rendering in a browser (react-native-web), not a native app. */
  web: boolean;
  /** The controller's native probe for an installed Commons. */
  commonsAvailability: CommonsAvailability;
}

export function resolveSignInMethods(facts: SignInSurfaceFacts): SignInMethods {
  if (facts.web) return { commons: 'qr' };
  return { commons: facts.commonsAvailability === 'unavailable' ? 'get-commons' : 'continue' };
}
