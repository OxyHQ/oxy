import { parseIdPayload } from '@oxy.so/core';

/**
 * Cold-start deep-link normalizer — expo-router's sanctioned `+native-intent`
 * hook. A PURE function run once per incoming system URL (no subscription, no
 * `useEffect`); it maps an external/system deep link onto an in-app route
 * before the router resolves it.
 *
 * FIX (card deep link): a shared Oxy ID QR is
 * `commons://card?did=<did>&v=1` (or `oxycommons://…`) — the DID rides in a
 * QUERY param. But the card view is the PATH-param route
 * `app/(tabs)/(id)/card/[did].tsx` (URL `/card/<did>`). With the scheme
 * stripped by expo-router the router receives `/card?did=…`, for which there is
 * NO leaf route (`/card` has only the `[did]` child) → "Unmatched Route / Page
 * could not be found". We rewrite it to the exact path-param URL the in-app
 * scanner already navigates to (`routeParsed`'s `id` branch →
 * `/(tabs)/(id)/card/[did]` with `parseIdPayload(raw).did`), so a system deep
 * link and an in-app scan land on the IDENTICAL screen with the IDENTICAL `did`
 * param.
 *
 * Only the card query→path shape is rewritten. Every other path passes through
 * untouched — including the already-working leaf routes `/attest?subject=…`
 * (its `attest.tsx` route matches the query form directly, so no rewrite is
 * needed or added — and per the pending owner decision this hook does NOT
 * auto-submit an attestation) and `/approve?code=…`.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const did = cardDidFromSystemPath(path);
  if (did) {
    return `/card/${encodeURIComponent(did)}`;
  }
  return path;
}

/**
 * Recover the `did` from a card deep link whose scheme expo-router has stripped.
 *
 * The OS may hand back the path in several shapes depending on version — a bare
 * `card?did=…`, a rooted `/card?did=…`, or occasionally the full
 * `commons://card?did=…` / `oxycommons://card?…`. We strip any leading scheme
 * and slashes, re-canonicalize to the `oxycommons://card?…` form, and validate
 * it with the SAME shared, dependency-free `parseIdPayload` the in-app scanner
 * uses (`lib/commons-signin/parse-scan.ts`). Anything that is not a card
 * payload, or carries no usable `did`, yields `null` → the caller passes the
 * path through unchanged (so a genuinely bad link still shows the normal
 * not-found screen rather than crashing).
 */
function cardDidFromSystemPath(path: string): string | null {
  const stripped = path
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^\/+/, '');
  if (stripped.length === 0) {
    return null;
  }
  return parseIdPayload(`oxycommons://${stripped}`)?.did ?? null;
}
