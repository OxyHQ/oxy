/**
 * Which sign-in methods a surface offers, from where it runs.
 *
 * One screen everywhere, and sign-in happens IN it (ADR 0029 D1):
 *
 *  - the COMMONS way in — on the web the embedded QR (the split card's right
 *    column from `md`, with "Continue with Oxy" below `md`, where the screen
 *    is the phone that would scan it); on native "Continue with Oxy", and
 *    "Get Commons" on a device that has no Commons to continue with;
 *  - the PASSKEY — it belongs to `oxy.so`, so it runs right here on auth.oxy.so
 *    (`page`: the username with its Continue, and the discoverable passkey), and
 *    in an app's dialog on the web it opens auth.oxy.so's window for that one
 *    step (with account creation); native has none, Commons holds the identity.
 */

import type { CommonsAvailability } from '@oxy.so/core';

/**
 * `qr`          — the web: the embedded QR from `md`, "Continue with Oxy" below.
 * `continue`    — native "Continue with Oxy": Oxy picks the route (shared
 *                 keychain, Commons on this device, a push, or the QR view).
 * `get-commons` — native, and Commons is not installed here.
 */
export type CommonsEntry = 'qr' | 'continue' | 'get-commons';

/**
 * `here`   — auth.oxy.so: the username and the passkey run on this page.
 * `window` — an app's dialog on the web: the passkey opens auth.oxy.so's window.
 * `none`   — native.
 */
export type PasskeyEntry = 'here' | 'window' | 'none';

export interface SignInMethods {
  commons: CommonsEntry;
  passkey: PasskeyEntry;
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
    return { commons: 'qr', passkey: facts.host === 'page' ? 'here' : 'window' };
  }
  return {
    commons: facts.commonsAvailability === 'unavailable' ? 'get-commons' : 'continue',
    passkey: 'none',
  };
}
