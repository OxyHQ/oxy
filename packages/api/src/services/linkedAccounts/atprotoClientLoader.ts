/**
 * The single place `@atproto/oauth-client-node` is loaded.
 *
 * The package is ESM-only and this API compiles to CommonJS, so it is reached
 * through a real dynamic `import()` (NodeNext keeps it one) on first use rather
 * than a static import. Tests replace this module with `jest.mock`, because
 * ts-jest's CommonJS runtime cannot evaluate an ES module.
 */

export type AtprotoOAuthModule = typeof import('@atproto/oauth-client-node', { with: { 'resolution-mode': 'import' } });

export function loadAtprotoOAuthModule(): Promise<AtprotoOAuthModule> {
  return import('@atproto/oauth-client-node');
}
