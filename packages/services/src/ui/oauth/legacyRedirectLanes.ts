/**
 * The legacy, redirect-mode-only lanes that navigate the RP's TOP-LEVEL window
 * to the IdP without a user gesture.
 *
 * `webAuthMode: 'popup'` exists to guarantee exactly one thing: the relying
 * party never leaves its route. Two mechanics in this SDK break that guarantee,
 * because each replaces the whole document on its own initiative:
 *
 * 1. **Cold-boot silent restore** — a full-page `prompt=none` authorize bounce
 *    to `auth.oxy.so` when the device-secret mint finds no local session
 *    (`maybeStartSilentOAuthRestore`, called from `runProviderColdBoot`).
 * 2. **Post-sign-in hub sync** — a full-page hop to `auth.oxy.so/sync` that
 *    plants this device's credential on the IdP hub so OTHER origins can later
 *    run lane 1 (`syncHubAfterSignIn`, called from the `commitSession` funnel).
 *
 * Both belong to the redirect transport and are kept only for the migration
 * window (issue #691, "Cold boot and cross-domain behavior"). In popup mode a
 * domain with no local credential simply resolves SIGNED OUT, and the user's
 * next explicit "Continue with Oxy" opens the popup — from a real user gesture,
 * never automatically.
 *
 * NOT covered here, and correctly enabled in BOTH modes: navigations the user
 * asked for. When the browser blocks the popup, `startWebOAuthSignIn` still
 * falls back to a full-page redirect rather than dead-ending the sign-in, and
 * `tryCompleteOAuthReturn` still consumes a `?code=` that is already on the URL.
 *
 * PHASE 7b: once the pilot flips the default transport to `'popup'`, this
 * predicate and BOTH lanes above are deleted outright. Grepping this symbol
 * finds every site that has to go.
 */

import type { WebAuthMode } from './types';

/**
 * Whether a provider running `webAuthMode` may perform an SDK-initiated,
 * non-gesture, full-page navigation to the IdP.
 *
 * `true` only for `'redirect'` — still the default and the compatibility path,
 * whose behaviour must stay byte-for-byte unchanged.
 */
export function allowsAutomaticIdpRedirect(webAuthMode: WebAuthMode): boolean {
  return webAuthMode === 'redirect';
}
