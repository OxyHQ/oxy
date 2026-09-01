import { getPlatformOS } from './platform';

/**
 * Automatic "Sign in with Oxy" delivery selection (issue #691, Phase 4).
 *
 * The user performs ONE action ("Continue with Oxy"); Oxy — not the user —
 * decides how the approval request reaches their Commons identity. This module
 * is that decision, and nothing else: a single pure function mapping the facts
 * the caller has gathered onto exactly ONE primary route.
 *
 * Deliberate design constraints:
 *
 *  - **Pure.** No I/O, no platform sniffing, no clock, no globals. Every input
 *    is passed in by the caller, which is what makes the decision exhaustively
 *    unit-testable and identical on web, native, and server.
 *  - **One route, never a chain.** The result is the PRIMARY route only.
 *    Alternatives stay hidden behind a "Having trouble?" affordance and are
 *    revealed by the UI only once the primary route fails or is unavailable —
 *    the SDK never silently cascades from one delivery surface to the next.
 *  - **Fail-safe to QR.** QR is the route that works with no prior knowledge of
 *    the device, so every ambiguous or malformed input degrades to it rather
 *    than to a route that could leave the user staring at a dead end.
 *
 * Every route drives the SAME `AuthSession`, resolved from the same public
 * `authorizeCode`; the route only decides how that code travels.
 */

/**
 * The kind of surface the sign-in was initiated from.
 *
 * `'unknown'` is a first-class value, not an error: a caller that cannot
 * confidently classify the surface must say so rather than guess, and an
 * unknown surface never opts into the deep-link route (a custom-scheme
 * navigation that does not resolve is a dead end with no automatic way back).
 */
export type CommonsDeliveryPlatform = 'mobile' | 'desktop' | 'unknown';

/**
 * The single primary route chosen for this request.
 *
 *  - `'open-commons'` — navigate to the verified Commons app/universal link on
 *    THIS device and let the user confirm there.
 *  - `'await-push'` — the request was pushed to a known Commons installation;
 *    show "Check Commons on your phone" and wait for the authorization.
 *  - `'qr'` — render the QR carrying the public `authorizeCode` for the user to
 *    scan with Commons on another device.
 */
export type CommonsDeliveryRoute = 'open-commons' | 'await-push' | 'qr';

/**
 * The facts the caller must gather before asking for a route. All of them are
 * observations, never decisions — the caller owns the platform detection, the
 * app-link verification, and the delivery round-trip; this module owns only the
 * choice between them.
 */
export interface CommonsDeliveryFacts {
  /** Which surface the sign-in was initiated from (see {@link CommonsDeliveryPlatform}). */
  platform: CommonsDeliveryPlatform;
  /**
   * `true` only when a VERIFIED Commons app/universal link can be opened on
   * this very device (an installed, link-verified Commons). "The user probably
   * has Commons somewhere" is not this fact — that is what `pushTargets`
   * expresses.
   */
  commonsAvailable: boolean;
  /**
   * How many eligible Commons installations the server said it delivered the
   * request to — the `targets` field of `deliverCommonsSignIn`. Zero is a
   * NORMAL outcome (no capable Commons install is registered for this
   * identity), never an error; it simply means push is not a usable route.
   */
  pushTargets: number;
}

/**
 * Choose the ONE primary delivery route for a "Sign in with Oxy" request.
 *
 * Decision order (issue #691, "Automatic delivery selection"):
 *
 *  1. Mobile with a verified Commons link available → open Commons directly.
 *     No push is needed when the identity is already reachable on this device.
 *  2. At least one eligible Commons installation was pushed to → await the push.
 *  3. Otherwise → QR.
 *
 * A caller that already knows it is on step 1 does not need to call
 * `deliverCommonsSignIn` at all; every other caller runs the delivery
 * round-trip first and passes its `targets` in here.
 *
 * `pushTargets` is server-derived, so it is validated rather than trusted: a
 * negative, fractional, non-finite, or otherwise malformed count is treated as
 * "no targets" and degrades to QR instead of parking the user on a "check your
 * phone" screen that nothing will ever wake.
 */
export function selectCommonsDelivery(facts: CommonsDeliveryFacts): CommonsDeliveryRoute {
  if (facts.platform === 'mobile' && facts.commonsAvailable) {
    return 'open-commons';
  }
  if (Number.isInteger(facts.pushTargets) && facts.pushTargets >= 1) {
    return 'await-push';
  }
  return 'qr';
}

/**
 * Map a `deliverCommonsSignIn` result onto the `pushTargets` fact for
 * {@link selectCommonsDelivery}. The server reports eligible install *count*
 * separately from whether any push was accepted — a transport failure can leave
 * `delivered: false` with `targets > 0`, which must NOT park the user on
 * "check your phone".
 */
export function pushTargetsFromDelivery(result: {
  delivered: boolean;
  targets: number;
}): number {
  return result.delivered ? result.targets : 0;
}

/**
 * Classify the current runtime surface for delivery selection. Callers that
 * cannot confidently detect the platform should not use this — pass
 * `'unknown'` explicitly instead.
 */
export function commonsDeliveryPlatform(): CommonsDeliveryPlatform {
  const os = getPlatformOS();
  if (os === 'ios' || os === 'android') {
    return 'mobile';
  }
  if (os === 'web') {
    return 'desktop';
  }
  return 'unknown';
}
