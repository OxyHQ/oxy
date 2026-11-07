/**
 * Which Commons way in a sign-in surface offers, from the device it runs on
 * (`resolveSignInDevice`). Every surface also takes an email or username
 * (`OxySignInPanel`), in place:
 *
 *  - a browser or a computer: the embedded QR a phone scans (the split card's
 *    right column from `md`, with "Continue with Oxy" below `md`, where the
 *    screen is as narrow as a phone's);
 *  - a phone: "Continue with Oxy", and "Get Commons" on a phone that has no
 *    Commons to continue with.
 */

import type { CommonsAvailability } from '@oxy.so/core/session';
import type { SignInDevice } from '../../utils/signInDevice';

/**
 * `qr`          — a browser or a computer: the embedded QR from `md`,
 *                 "Continue with Oxy" below.
 * `continue`    — a phone's "Continue with Oxy": Oxy picks the route (shared
 *                 keychain, Commons on this device, a push, or the QR view).
 * `get-commons` — a phone, and Commons is not installed on it.
 */
export type CommonsEntry = 'qr' | 'continue' | 'get-commons';

export interface SignInMethods {
  commons: CommonsEntry;
}

export interface SignInSurfaceFacts {
  /** What the surface runs on (`resolveSignInDevice`). */
  device: SignInDevice;
  /** The controller's native probe for an installed Commons (phones only). */
  commonsAvailability: CommonsAvailability;
}

export function resolveSignInMethods(facts: SignInSurfaceFacts): SignInMethods {
  if (facts.device !== 'phone') return { commons: 'qr' };
  return { commons: facts.commonsAvailability === 'unavailable' ? 'get-commons' : 'continue' };
}
