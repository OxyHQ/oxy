/**
 * Jest's CommonJS runtime cannot `require` an ESM-only package unless Node runs
 * with `--experimental-vm-modules` (the only way `vm.SourceTextModule` exists),
 * and every package here runs Jest as CommonJS. The packages named below are
 * therefore lowered to CommonJS by the same per-file ts-jest transpile the
 * packages' own sources go through.
 *
 * Bun's isolated linker nests `@scope/name@x` under
 * `node_modules/.bun/@scope+name@x/node_modules/@scope/name/`, so the ignore
 * pattern lets both spellings of a listed package through and keeps every other
 * file under `node_modules` untransformed, as Jest's default does.
 */

/** `@noble/*` and `@scure/*` ship ESM only since 2.0; core and protocol reach them. */
const NOBLE_ESM_PACKAGES = ['@noble/ciphers', '@noble/curves', '@noble/hashes', '@scure/bip39'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The `transform` entry that lowers `packages` to CommonJS. */
function esmOnlyTransform(packages) {
  return {
    [`^.+/node_modules/(${packages.map(escapeRegExp).join('|')})/.+\\.m?js$`]: [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          isolatedModules: true,
          module: 'commonjs',
          moduleResolution: 'node10',
          allowJs: true,
        },
      },
    ],
  };
}

/** One `transformIgnorePatterns` entry: all of `node_modules` except `packages`. */
function esmOnlyTransformIgnorePattern(packages) {
  const bunDirs = packages.map((name) => escapeRegExp(name.replace('/', '+'))).join('|');
  const names = packages.map(escapeRegExp).join('|');
  return `/node_modules/(?!\\.bun/(${bunDirs})@|(${names})/)`;
}

module.exports = { NOBLE_ESM_PACKAGES, esmOnlyTransform, esmOnlyTransformIgnorePattern };
