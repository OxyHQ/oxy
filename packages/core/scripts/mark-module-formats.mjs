import { mkdir, writeFile } from 'node:fs/promises';

/**
 * Each build directory gets its own `package.json`, and that file is the
 * PACKAGE SCOPE for everything under it: Node, Vite/Rolldown and Metro all
 * resolve a `#` specifier against the nearest `package.json`, not the root one.
 * So the package-private `imports` map lives here, beside the `type` marker,
 * with targets relative to the build directory.
 *
 * `#workload-identity` is the ADR 0026 attestation module that
 * `OxyServices.auth` loads lazily. Native and browser bundlers get the
 * client stub, so `node:crypto` never enters their graph; only a Node host gets
 * the signer. It replaces a self-reference to an `@oxy.so/core/...` export
 * subpath, which resolves only where `@oxy.so/core` is reachable through
 * `node_modules` — never from inside this workspace, whose isolated install
 * links no package to itself, so every Vite app here failed to bundle.
 * `scripts/verify-package-formats.mjs` asserts the resolution per condition.
 */
const workloadIdentity = {
  'react-native': './server/workloadIdentity.client.js',
  browser: './server/workloadIdentity.client.js',
  node: './server/workloadIdentity.js',
  default: './server/workloadIdentity.client.js',
};

for (const [directory, type] of [
  ['dist/cjs', 'commonjs'],
  ['dist/esm', 'module'],
]) {
  await mkdir(directory, { recursive: true });
  const scope = { type, imports: { '#workload-identity': workloadIdentity } };
  await writeFile(`${directory}/package.json`, `${JSON.stringify(scope, null, 2)}\n`);
}
