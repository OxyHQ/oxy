/**
 * Which sign-in methods a surface offers, from where it runs.
 *
 * One screen everywhere; only the transport behind each block changes:
 *
 *  - auth.oxy.so (`page`) is where the web signs in: the embedded Commons QR
 *    (the split card's right column from `md`, "Continue with Oxy" below it),
 *    the username with its Continue, and the passkey — asserted right here,
 *    on the one origin every Oxy passkey belongs to;
 *  - an app's account dialog on the web (`dialog`) opens that screen in a
 *    window over the app ("Continue with Oxy"), like "Sign in with Google":
 *    the browser's session lives on auth.oxy.so, so every Oxy app shares it;
 *  - native signs in with Commons: "Continue with Oxy", or "Get Commons" on a
 *    device that has no Commons to continue with.
 */

import type { CommonsAvailability } from '@oxy.so/core';

/**
 * `qr`          — auth.oxy.so: the embedded QR from `md`, "Continue with Oxy" below.
 * `window`      — an app on the web: "Continue with Oxy" opens auth.oxy.so's window.
 * `continue`    — native "Continue with Oxy": Oxy picks the route (shared
 *                 keychain, Commons on this device, a push, or the QR view).
 * `get-commons` — native, and Commons is not installed here.
 */
export type CommonsEntry = 'qr' | 'window' | 'continue' | 'get-commons';

export interface SignInMethods {
  commons: CommonsEntry;
  /** The username and passkey block: only on auth.oxy.so. */
  passkey: boolean;
}

export interface SignInSurfaceFacts {
  /** Rendering in a browser (react-native-web), not a native app. */
  web: boolean;
  /** `page` is auth.oxy.so; `dialog` is an app's account dialog. */
  host: 'dialog' | 'page';
  /** The controller's native probe for an installed Commons. */
  commonsAvailability: CommonsAvailability;
}

export function resolveSignInMethods(facts: SignInSurfaceFacts): SignInMethods {
  if (facts.web) {
    return facts.host === 'page' ? { commons: 'qr', passkey: true } : { commons: 'window', passkey: false };
  }
  return {
    commons: facts.commonsAvailability === 'unavailable' ? 'get-commons' : 'continue',
    passkey: false,
  };
}
