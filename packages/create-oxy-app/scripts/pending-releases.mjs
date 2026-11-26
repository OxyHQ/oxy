/**
 * Ranges a template names before their packages are released.
 *
 * The language template (`create-oxy-app --language`) is built on Bloom 23,
 * the Bloom language and its compiler, bloom-data, app-preset 6.9 and
 * Services 15. All but Services 15 are on npm; until it is,
 * `assert-oxy-ranges-resolve.mjs` would fail a language app on its E404.
 * Bloom 23 is released but stays listed while this workspace's catalog is on
 * Bloom 22: Services 15 (#2316) moves the catalog, and both entries go then.
 *
 * An entry excuses exactly that and nothing else: this `name@range` matching
 * no published version. A range that resolves is checked like any other (and
 * the run says the entry can go), and a name at any other range still fails.
 * Each entry is the range `src/versions.ts` pins, which the unit tests hold;
 * delete it when its package is released.
 */
export const PENDING_RELEASES = Object.freeze({
  '@oxy.so/bloom': '^23.0.0',
  '@oxy.so/services': '^15.0.0',
});

/** Whether `name@range` is a listed, not yet released range. */
export function isPendingRelease(name, range) {
  return Object.hasOwn(PENDING_RELEASES, name) && PENDING_RELEASES[name] === range;
}
