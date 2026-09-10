/**
 * Classify the surface a "Sign in with Oxy" request is initiated from, for
 * `AccountDialogController`'s `platform` option (issue #691, Phase 4/5).
 *
 * `@oxy.so/core` deliberately refuses to do this itself — it never touches a
 * platform global — so the consumer that OWNS the environment classifies it and
 * hands the verdict in. The verdict feeds `selectCommonsDelivery`, where it
 * decides one thing only: whether this device may take the `'open-commons'`
 * deep-link route. Getting it wrong in the "mobile" direction is the costly
 * error (a custom-scheme navigation that does not resolve is a dead end with no
 * automatic way back), so every ambiguous signal resolves AWAY from `'mobile'`.
 *
 * No user-agent string is parsed. The two signals used are declarative and
 * standardized:
 *   1. `navigator.userAgentData.mobile` — the User-Agent Client Hints boolean.
 *      Authoritative where implemented (Chromium), in both directions.
 *   2. The PRIMARY pointer (`(pointer: coarse)`) plus a touch digitizer.
 *      A phone/tablet reports a coarse primary pointer; a touchscreen laptop
 *      still reports its mouse as primary, so it is not misclassified.
 */

import type { CommonsDeliveryPlatform } from '@oxy.so/core';
import { isWebBrowser } from './isWebBrowser';

/**
 * The `navigator.userAgentData` slice this module reads. Declared locally
 * because `NavigatorUAData` is not in TypeScript's DOM lib yet; only the one
 * field consumed here is modelled, and it stays optional so an implementation
 * without it is simply "no answer" rather than a type lie.
 */
interface NavigatorUserAgentData {
  readonly mobile?: boolean;
}

type NavigatorWithUserAgentData = Navigator & {
  readonly userAgentData?: NavigatorUserAgentData;
};

/**
 * Which surface this app is running on, as `selectCommonsDelivery` models it.
 *
 *  - Native (Expo/RN) is always `'mobile'`: it is an Oxy app installed on a
 *    phone/tablet, exactly the case where a verified Commons link can resolve
 *    on this very device.
 *  - A web browser is classified from the signals above.
 *  - Anything else — a browser-like environment with neither signal — is
 *    `'unknown'`, a first-class value that never opts into the deep link.
 */
export function resolveDeliveryPlatform(): CommonsDeliveryPlatform {
  if (!isWebBrowser()) return 'mobile';

  const nav: NavigatorWithUserAgentData | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;

  const uaMobile = nav?.userAgentData?.mobile;
  if (typeof uaMobile === 'boolean') return uaMobile ? 'mobile' : 'desktop';

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const coarsePrimaryPointer = window.matchMedia('(pointer: coarse)').matches;
    const hasTouchDigitizer = (nav?.maxTouchPoints ?? 0) > 0;
    return coarsePrimaryPointer && hasTouchDigitizer ? 'mobile' : 'desktop';
  }

  return 'unknown';
}
