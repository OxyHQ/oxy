/**
 * Which sign-in methods a surface offers, from where it runs.
 *
 * One screen everywhere; only the transport behind each block changes:
 *
 *  - the COMMONS way in — on the web the embedded QR (the split card's right
 *    column from `md`, with "Continue with Oxy" below `md`, where the screen
 *    is the phone that would scan it), on native "Continue with Oxy", and
 *    "Get Commons" on a native device that has no Commons to continue with;
 *  - the PASSKEY block under "or continue with" — run right here on an origin
 *    the `oxy.so` credential can be asserted from, in the identity window
 *    everywhere else on the web, and not at all on native, where Commons holds
 *    the identity.
 */

import type { CommonsAvailability } from '@oxy.so/core';

/**
 * `direct`          — the WebAuthn ceremony runs on this page (`isOxyRpOrigin()`).
 * `identity-window` — it runs at auth.oxy.so, in the identity window (a popup).
 * `none`            — no passkey on this platform.
 */
export type PasskeyRoute = 'direct' | 'identity-window' | 'none';

/**
 * `qr`          — the web: the embedded QR from `md`, "Continue with Oxy" below.
 * `continue`    — "Continue with Oxy": Oxy picks the route (shared keychain,
 *                 Commons on this device, a push, or the QR view).
 * `get-commons` — native, and Commons is not installed here.
 */
export type CommonsEntry = 'qr' | 'continue' | 'get-commons';

export interface SignInMethods {
  commons: CommonsEntry;
  passkey: PasskeyRoute;
}

export interface SignInSurfaceFacts {
  /** Rendering in a browser (react-native-web), not a native app. */
  web: boolean;
  /** `isOxyRpOrigin()` — only meaningful on the web. */
  oxyRpOrigin: boolean;
  /** The controller's native probe for an installed Commons. */
  commonsAvailability: CommonsAvailability;
}

export function resolveSignInMethods(facts: SignInSurfaceFacts): SignInMethods {
  if (facts.web) {
    return {
      commons: 'qr',
      passkey: facts.oxyRpOrigin ? 'direct' : 'identity-window',
    };
  }
  return {
    commons: facts.commonsAvailability === 'unavailable' ? 'get-commons' : 'continue',
    passkey: 'none',
  };
}
