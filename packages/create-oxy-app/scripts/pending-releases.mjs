/**
 * Ranges a template names before their packages are released.
 *
 * The language template (`create-oxy-app --language`) is built on packages
 * that ship together and are not on npm yet: Bloom 23 (no NativeWind), the
 * Bloom language and its compiler, bloom-data, app-preset 6.9 and Services 15.
 * Until they are, `assert-oxy-ranges-resolve.mjs` would fail a language app
 * on an E404 for each one.
 *
 * An entry excuses exactly that and nothing else: this `name@range` matching
 * no published version. A range that resolves is checked like any other (and
 * the run says the entry can go), and a name at any other range still fails.
 * Each entry is the range `src/versions.ts` pins, which the unit tests hold;
 * delete it when its package is released.
 */
export const PENDING_RELEASES = Object.freeze({
  '@oxy.so/bloom': '^23.0.0',
  '@oxy.so/bloom-language': '^1.0.0',
  '@oxy.so/bloom-language-compiler': '^1.0.0',
  '@oxy.so/bloom-data': '^0.1.0',
  '@oxy.so/app-preset': '^6.9.0',
  '@oxy.so/services': '^15.0.0',
});

/** Whether `name@range` is a listed, not yet released range. */
export function isPendingRelease(name, range) {
  return Object.hasOwn(PENDING_RELEASES, name) && PENDING_RELEASES[name] === range;
}
