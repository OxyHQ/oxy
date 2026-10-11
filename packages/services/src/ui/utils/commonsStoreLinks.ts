/**
 * Where to send a user who doesn't have Commons installed yet.
 *
 * Commons is not published to either app store as of this writing (no submit
 * profile in its `eas.json`, no store listing) — so these are ALWAYS
 * env-overridable and NEVER hardcoded, and the landing-page fallback exists
 * precisely so a "Get Commons" affordance is never a dead link in the
 * meantime. Once Commons ships to TestFlight/Play, set the two store env vars
 * and every consumer picks them up with no code change.
 */

/** Real per-platform store URLs, or `undefined` where not yet configured. */
export interface CommonsStoreLinks {
  ios: string | undefined;
  android: string | undefined;
}

/** Per-platform Commons store URLs, from env — `undefined` when unset. */
export function getCommonsStoreLinks(): CommonsStoreLinks {
  return {
    ios: process.env.EXPO_PUBLIC_COMMONS_APP_STORE_URL || undefined,
    android: process.env.EXPO_PUBLIC_COMMONS_PLAY_STORE_URL || undefined,
  };
}

/** Placeholder landing page — the fallback while Commons has no store listing. */
const DEFAULT_COMMONS_LANDING_URL = 'https://oxy.so/commons';

/**
 * Resolve the "Get Commons" href for the current platform. Never `undefined`
 * — falls back to a landing page so the affordance is always a working link,
 * store listing or not.
 */
export function getCommonsAcquisitionUrl(platformOS: 'ios' | 'android' | string): string {
  const links = getCommonsStoreLinks();
  const storeUrl =
    platformOS === 'ios' ? links.ios : platformOS === 'android' ? links.android : undefined;
  return storeUrl ?? process.env.EXPO_PUBLIC_COMMONS_LANDING_URL ?? DEFAULT_COMMONS_LANDING_URL;
}
