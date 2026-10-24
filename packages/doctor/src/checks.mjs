import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const FIRST_PARTY_SCOPES = ['@oxy.so/'];

/**
 * Days an app may stay behind a newly published `@oxy.so/*` release before
 * `--ci` fails. A release is a warning inside this window and an error after
 * it, so one publish never turns every app's CI (and every deploy gated on it)
 * red at the same moment; the upgrade still has to land within the window.
 */
export const DEFAULT_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
export const isFirstPartyPackage = (name) =>
  FIRST_PARTY_SCOPES.some((scope) => name.startsWith(scope));

export function compareVersions(left, right) {
  const parse = (value) =>
    value
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function rangeIncludesVersion(range, version) {
  return range.split('||').some((alternative) => {
    const terms = alternative.trim().split(/\s+/).filter(Boolean);
    return terms.every((term) => {
      const target = term.match(/\d+\.\d+\.\d+/)?.[0];
      if (!target) return true;
      const comparison = compareVersions(version, target);
      if (term.startsWith('>=')) return comparison >= 0;
      if (term.startsWith('<=')) return comparison <= 0;
      if (term.startsWith('>')) return comparison > 0;
      if (term.startsWith('<')) return comparison < 0;
      if (term.startsWith('^')) {
        const [major, minor] = target.split('.').map(Number);
        const [candidateMajor, candidateMinor] = version.split('.').map(Number);
        return (
          comparison >= 0 && candidateMajor === major && (major > 0 || candidateMinor === minor)
        );
      }
      if (term.startsWith('~')) {
        const [major, minor] = target.split('.').map(Number);
        const [candidateMajor, candidateMinor] = version.split('.').map(Number);
        return comparison >= 0 && candidateMajor === major && candidateMinor === minor;
      }
      return comparison === 0;
    });
  });
}

export function lockfileVersions(lockfile, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`"(?:[^"\\n]+/)?${escaped}"\\s*:\\s*\\["${escaped}@([^"\\s]+)"`, 'g');
  return [...lockfile.matchAll(matcher)].map((match) => match[1]);
}

export async function findRepositoryRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No package.json found above ${start}`);
    current = parent;
  }
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.expo',
  '.turbo',
  '.worktrees',
  'dist',
  'lib',
  'node_modules',
]);

async function childDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
    .map((entry) => join(directory, entry.name));
}

/** Directories matching one Bun workspace pattern (`dir`, `dir/*`, `dir/**`). */
async function expandWorkspacePattern(directory, segments) {
  if (segments.length === 0) return [directory];
  const [segment, ...rest] = segments;
  if (segment === '**') {
    const here = await expandWorkspacePattern(directory, rest);
    const deeper = await Promise.all(
      (await childDirectories(directory)).map((child) => expandWorkspacePattern(child, segments)),
    );
    return [...here, ...deeper.flat()];
  }
  if (segment.includes('*')) {
    const matcher = new RegExp(
      `^${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    const children = (await childDirectories(directory)).filter((child) =>
      matcher.test(child.slice(directory.length + 1)),
    );
    return (await Promise.all(children.map((child) => expandWorkspacePattern(child, rest)))).flat();
  }
  return expandWorkspacePattern(join(directory, segment), rest);
}

/**
 * The manifests Bun installs from: the root and its workspaces. A package.json
 * outside them (a frozen copy kept as audit evidence, a fixture) is not
 * installed from this lockfile, so it is not this repository's dependency state.
 */
async function collectManifests(root, rootManifest) {
  const workspaces = rootManifest.workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
  const directories = new Set([root]);
  const excluded = new Set();
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const segments = (negated ? pattern.slice(1) : pattern)
      .replace(/^\.\//, '')
      .split('/')
      .filter(Boolean);
    for (const directory of await expandWorkspacePattern(root, segments))
      (negated ? excluded : directories).add(directory);
  }
  return [...directories]
    .filter((directory) => !excluded.has(directory))
    .map((directory) => join(directory, 'package.json'))
    .filter((path) => existsSync(path))
    .sort();
}

/** `catalog:` / `catalog:<name>` resolved against the root manifest's catalogs. */
function catalogEntries(rootManifest) {
  const workspaces = Array.isArray(rootManifest.workspaces) ? {} : (rootManifest.workspaces ?? {});
  const rows = [];
  const add = (section, catalog) => {
    for (const [name, range] of Object.entries(catalog ?? {})) rows.push({ section, name, range });
  };
  add('catalog', workspaces.catalog ?? rootManifest.catalog);
  for (const [catalogName, catalog] of Object.entries(
    workspaces.catalogs ?? rootManifest.catalogs ?? {},
  ))
    add(`catalogs.${catalogName}`, catalog);
  return rows;
}

/** The SDK whose native peers an app has to declare itself. */
export const NATIVE_PEER_HOST = '@oxy.so/services';

/** The installed directory of `name`, found the way Node and Metro walk node_modules. */
function installedPackageDir(name, from) {
  let directory = from;
  while (true) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Ships native code autolinking must link: the markers Expo and the React Native CLI read. */
export function isNativeModulePackage(directory) {
  return (
    existsSync(join(directory, 'expo-module.config.json')) ||
    existsSync(join(directory, 'react-native.config.js')) ||
    existsSync(join(directory, 'android')) ||
    existsSync(join(directory, 'ios')) ||
    readdirSync(directory).some((entry) => entry.endsWith('.podspec'))
  );
}

/**
 * Required native peers of `@oxy.so/services` that an app (a manifest on
 * services and on `expo` or `react-native`) does not declare. Expo's autolinking skips OPTIONAL peers, and an undeclared native
 * module is installed at whatever version the package manager picks rather than
 * the build `expo install` pins for the app's SDK; `expo-crypto` missing from
 * Allo's release APK broke the CSPRNG and sign-in. Reads the INSTALLED services
 * manifest, so it needs `bun install` first; without one the manifest is
 * reported as unverified rather than passed.
 *
 * @returns {Promise<{ finding?: object, unverified?: string }>}
 */
export async function nativePeerCheck(root, manifestPath, manifest) {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  // Only an APP is autolinked: a manifest on services that is no Expo / React
  // Native project (a monorepo root holding it for hoisting, a library) is not.
  if (!(NATIVE_PEER_HOST in declared) || !('expo' in declared || 'react-native' in declared))
    return {};
  const relative = manifestPath.slice(root.length + 1);
  const servicesDir = installedPackageDir(NATIVE_PEER_HOST, dirname(manifestPath));
  if (!servicesDir) return { unverified: relative };
  const services = JSON.parse(await readFile(join(servicesDir, 'package.json'), 'utf8'));
  const meta = services.peerDependenciesMeta ?? {};
  const missing = Object.keys(services.peerDependencies ?? {})
    .filter((name) => meta[name]?.optional !== true && !(name in declared))
    .filter((name) => {
      const directory = installedPackageDir(name, servicesDir);
      // Not installed at all: a required peer is missing outright.
      return directory === null || isNativeModulePackage(directory);
    })
    .sort();
  if (missing.length === 0) return {};
  return {
    finding: {
      severity: 'error',
      code: 'undeclared-native-peer',
      package: NATIVE_PEER_HOST,
      version: services.version,
      manifest: relative,
      missing,
      message: `${relative} uses ${NATIVE_PEER_HOST} ${services.version} but does not declare its required native peer${missing.length === 1 ? '' : 's'} ${missing.join(', ')}; run \`npx expo install ${missing.join(' ')}\` in ${dirname(relative) || '.'}`,
    },
  };
}

/**
 * @param {string} root
 * @param {(name: string) => Promise<{ version: string, publishedAt: string }>} fetchLatest
 * @param {{ graceDays?: number, now?: Date }} [options]
 */
export async function inspectRepository(
  root,
  fetchLatest,
  { graceDays = DEFAULT_GRACE_DAYS, now = new Date() } = {},
) {
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifestPaths = await collectManifests(root, rootManifest);
  const usages = new Map();
  const findings = [];
  for (const { section, name, range } of catalogEntries(rootManifest)) {
    if (!isFirstPartyPackage(name)) continue;
    const rows = usages.get(name) ?? [];
    rows.push({ manifest: 'package.json', section, range });
    usages.set(name, rows);
  }
  for (const path of manifestPaths) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (
          !isFirstPartyPackage(name) ||
          range.startsWith('workspace:') ||
          range.startsWith('catalog:')
        )
          continue;
        const rows = usages.get(name) ?? [];
        rows.push({ manifest: path.slice(root.length + 1), section, range });
        usages.set(name, rows);
      }
    }
  }
  const unverified = [];
  for (const path of manifestPaths) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const result = await nativePeerCheck(root, path, manifest);
    if (result.finding) findings.push(result.finding);
    if (result.unverified) unverified.push(result.unverified);
  }
  const lockPath = join(root, 'bun.lock');
  const lockfile = existsSync(lockPath) ? await readFile(lockPath, 'utf8') : null;
  if (!lockfile)
    findings.push({ severity: 'error', code: 'missing-lockfile', message: 'bun.lock is missing' });
  await Promise.all(
    [...usages].map(async ([name, rows]) => {
      const { version: latest, publishedAt } = await fetchLatest(name);
      const published = new Date(publishedAt);
      if (Number.isNaN(published.getTime()))
        throw new Error(`Registry returned no publish time for ${name}@${latest}`);
      const deadline = new Date(published.getTime() + graceDays * DAY_MS);
      const overdue = now >= deadline;
      const installed = lockfile ? [...new Set(lockfileVersions(lockfile, name))] : [];
      if (installed.length > 1)
        findings.push({
          severity: 'error',
          code: 'duplicate-version',
          package: name,
          installed,
          message: `${name} has multiple locked versions: ${installed.join(', ')}`,
        });
      for (const row of rows) {
        if (rangeIncludesVersion(row.range, latest)) continue;
        const due = deadline.toISOString().slice(0, 10);
        findings.push(
          overdue
            ? {
                severity: 'error',
                code: 'outdated',
                package: name,
                latest,
                publishedAt,
                ...row,
                message: `${name} ${row.range} does not include ${latest} in ${row.manifest} (published ${publishedAt.slice(0, 10)}; the ${graceDays}-day upgrade window closed ${due})`,
              }
            : {
                severity: 'warning',
                code: 'outdated',
                package: name,
                latest,
                publishedAt,
                ...row,
                message: `${name} ${row.range} does not include ${latest} in ${row.manifest} (upgrade by ${due})`,
              },
        );
      }
    }),
  );
  return {
    root,
    manifests: manifestPaths.length,
    packages: usages.size,
    findings,
    nativePeersUnverified: unverified,
  };
}

/** The `latest` dist-tag of `name` and when that version was published. */
export async function fetchLatestRelease(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
  const metadata = await response.json();
  const version = metadata['dist-tags']?.latest;
  if (typeof version !== 'string')
    throw new Error(`Registry returned no latest version for ${name}`);
  const publishedAt = metadata.time?.[version];
  if (typeof publishedAt !== 'string')
    throw new Error(`Registry returned no publish time for ${name}@${version}`);
  return { version, publishedAt };
}
