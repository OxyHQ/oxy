/** GHSA-mrhx-c7xc-m3w5: exact residual paths, never a package-wide exception.
 * Evidence and removal conditions: docs/security/zod-parser-boundary.md.
 * Reads the committed lock without installing or executing dependencies.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ZOD_ADVISORY = 'GHSA-mrhx-c7xc-m3w5';
const reviewedAtproto = {
  '@atproto-labs/did-resolver': '0.3.9',
  '@atproto-labs/fetch': '0.3.6',
  '@atproto-labs/fetch-node': '0.4.0',
  '@atproto-labs/handle-resolver': '0.4.9',
  '@atproto-labs/handle-resolver-node': '0.2.10',
  '@atproto-labs/identity-resolver': '0.4.9',
  '@atproto-labs/pipe': '0.2.4',
  '@atproto-labs/simple-store': '0.5.1',
  '@atproto-labs/simple-store-memory': '0.2.6',
  '@atproto/common-web': '0.5.12',
  '@atproto/did': '0.5.5',
  '@atproto/jwk': '0.7.4',
  '@atproto/jwk-jose': '0.2.4',
  '@atproto/jwk-webcrypto': '0.3.4',
  '@atproto/lex-data': '0.1.7',
  '@atproto/lex-json': '0.1.6',
  '@atproto/lexicon': '0.7.14',
  '@atproto/oauth-client': '0.8.7',
  '@atproto/oauth-client-node': '0.5.7',
  '@atproto/oauth-types': '0.7.6',
  '@atproto/syntax': '0.7.6',
  '@atproto/xrpc': '0.8.13',
};
const residualParents = new Set([
  '@atproto-labs/did-resolver',
  '@atproto-labs/handle-resolver',
  '@atproto/common-web',
  '@atproto/did',
  '@atproto/jwk',
  '@atproto/jwk-webcrypto',
  '@atproto/lexicon',
  '@atproto/oauth-client',
  '@atproto/oauth-types',
  '@atproto/xrpc',
  'shadcn',
  '@expo/cli',
]);
const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
function segments(key) {
  return key.match(/@[^/]+\/[^/]+|[^/]+/g) ?? [];
}
function lookup(packages, from, name) {
  const parts = segments(from);
  for (let n = parts.length; n >= 0; n--) {
    const key = [...parts.slice(0, n), name].join('/');
    if (Object.hasOwn(packages, key)) return key;
  }
  return null;
}
function metadata(entry) {
  return entry?.find((part) => part && typeof part === 'object' && !Array.isArray(part)) ?? {};
}
function patched(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return (
    match &&
    (Number(match[1]) > 4 ||
      (Number(match[1]) === 4 &&
        (Number(match[2]) > 6 || (Number(match[2]) === 6 && Number(match[3]) >= 7))))
  );
}

export function inspectZodLock(lock) {
  const errors = [];
  const packages = lock?.packages;
  const workspaces = lock?.workspaces;
  if (!packages || !workspaces)
    return {
      errors: ['Zod path guard requires complete Bun workspaces and packages'],
      residuals: [],
    };
  const residuals = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      errors.push(`Malformed lock entry: ${key}`);
      continue;
    }
    const identity = entry[0];
    if (identity.startsWith('zod@')) {
      const version = identity.slice(4);
      if (patched(version)) continue;
      const parts = segments(key);
      const parent = parts.slice(0, -1).join('/');
      if (version !== '3.25.76' || parts.at(-1) !== 'zod' || !residualParents.has(parent))
        errors.push(`Unreviewed vulnerable Zod resolution: ${key} -> ${identity}`);
      else residuals.push(key);
    }
    const atprotoName = /^(@atproto(?:-labs)?\/[^@]+)@/.exec(identity)?.[1];
    if (atprotoName && identity !== `${atprotoName}@${reviewedAtproto[atprotoName]}`)
      errors.push(
        `Atproto parser path changed; re-audit transport and restore boundaries: ${identity}`,
      );
  }
  if (residuals.includes('shadcn/zod') && packages.shadcn?.[0] !== 'shadcn@3.8.5')
    errors.push('The reviewed dev-only shadcn path/version changed');
  if (
    residuals.includes('@expo/cli/zod') &&
    (packages['@expo/cli']?.[0] !==
      '@oxy.so/expo-cli-native@./vendor/expo-native/oxy.so-expo-cli-native-58.1.11+oxy.native.1.tgz' ||
      packages['@expo/cli']?.at(-1) !==
        'sha512-gRY9CvFESqxDzC2WR5wE6fdnqWpiIGAJDJbjKxxqZNJ6lr8ACEZ/GWMEwM69tjnfqyTdlHvC9pe6zyGUhAfr4A==')
  )
    errors.push('The reviewed Expo build CLI artifact changed');

  // Walk every workspace, including published SDKs and tooling. A shared leaf
  // cannot become accepted just because an allowed consumer also uses it.
  for (const [directory, workspace] of Object.entries(workspaces)) {
    const pending = [];
    const seen = new Set();
    for (const field of [...fields, 'devDependencies']) {
      for (const name of Object.keys(workspace[field] ?? {})) {
        const lane =
          directory === 'packages/api' &&
          field === 'dependencies' &&
          name === '@atproto/oauth-client-node'
            ? 'atproto'
            : directory === 'packages/test-app-vite' &&
                field === 'devDependencies' &&
                name === 'shadcn'
              ? 'shadcn'
              : 'ordinary';
        pending.push({
          from: workspace.name ?? directory,
          name,
          lane,
          path: `${directory || '<root>'}:${field}`,
        });
      }
    }
    while (pending.length) {
      const item = pending.pop();
      const key = lookup(packages, item.from, item.name);
      if (!key) continue; // Optional peers need not be installed; unknown weak leaves are checked above.
      const reviewedExpoParent =
        item.from === 'expo' &&
        packages.expo?.[0] === 'expo@58.0.14' &&
        metadata(packages.expo).dependencies?.['@expo/cli'] === '^58.1.11';
      if (key === '@expo/cli' && !reviewedExpoParent)
        errors.push(`Expo CLI entered through an unreviewed parent: ${item.path} -> ${key}`);
      const visited = `${key}:${item.lane}`;
      if (seen.has(visited)) continue;
      seen.add(visited);
      const entry = packages[key];
      const identity = entry[0];
      const path = `${item.path} -> ${key}`;
      if (identity.startsWith('zod@') && !patched(identity.slice(4))) {
        if (
          !(item.lane === 'atproto' && key.startsWith('@atproto')) &&
          !(item.lane === 'shadcn' && key === 'shadcn/zod') &&
          !(item.lane === 'expo-cli' && key === '@expo/cli/zod')
        )
          errors.push(`Vulnerable Zod reaches an unreviewed workspace path: ${path}`);
        continue;
      }
      if (key === 'shadcn' && item.lane !== 'shadcn')
        errors.push(`shadcn must remain the test-app-vite dev CLI: ${path}`);
      if (key.startsWith('@atproto') && item.lane !== 'atproto')
        errors.push(`Atproto must remain behind the API linked-account boundary: ${path}`);
      // Expo ships a Node CLI as part of the Expo package. This exact vendored
      // CLI is build tooling, not the React Native runtime or an API parser.
      const lane = key === '@expo/cli' && reviewedExpoParent ? 'expo-cli' : item.lane;
      const workspaceMatch = identity.match(/@workspace:(.+)$/);
      const deps = workspaceMatch ? (workspaces[workspaceMatch[1]] ?? {}) : metadata(entry);
      for (const field of fields)
        for (const name of Object.keys(deps[field] ?? {}))
          pending.push({ from: key, name, lane, path });
    }
  }
  return { errors: [...new Set(errors)], residuals };
}

export function inspectZodAuditPaths(root) {
  try {
    return inspectZodLock(Bun.JSONC.parse(readFileSync(resolve(root, 'bun.lock'), 'utf8')));
  } catch (error) {
    return { errors: [`Zod path inventory unavailable: ${error.message}`], residuals: [] };
  }
}
