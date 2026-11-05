import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import semver from 'semver';

/**
 * Packages an app must hold exactly one copy of. Each copy of a module is its
 * own module instance: two `@oxy.so/contracts` are two schema sets, two
 * `@oxy.so/bloom` two theme contexts (a provider from one copy is invisible to
 * a consumer of the other), two `react` an invalid-hook crash, two native
 * modules a build that links one and runs the other. OxyOS's packager refuses
 * a duplicate module outright. Every `@oxy.so/*` package is on this list too.
 */
export const SINGLE_COPY_PACKAGES = [
  'expo',
  'expo-modules-core',
  'react',
  'react-dom',
  'react-native',
  'react-native-gesture-handler',
  'react-native-reanimated',
  'react-native-safe-area-context',
  'react-native-screens',
  'socket.io-client',
];

/**
 * Single only among the copies Oxy packages use: `@oxy.so/contracts` and an
 * app's own `@oxy.so/*-contracts` build schemas with zod, and a schema from one
 * zod copy cannot be composed into, or parsed by, another. A build tool
 * carrying its own zod for its own config is not shared and may differ.
 */
export const SHARED_WITH_OXY_PACKAGES = ['zod'];

const isOxyPackage = (name) => name.startsWith('@oxy.so/');
export const mustBeSingle = (name) => isOxyPackage(name) || SINGLE_COPY_PACKAGES.includes(name);

/**
 * `bun.lock` is JSON with trailing commas. Drop every comma that closes an
 * object or array (outside strings) and parse the rest as JSON.
 */
export function parseBunLock(text) {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === ',') {
      let next = index + 1;
      while (/\s/.test(text[next] ?? '')) next += 1;
      if (text[next] === '}' || text[next] === ']') continue;
    }
    out += char;
  }
  return JSON.parse(out);
}

/** `@scope/name@1.2.3` → { name, spec }. */
function splitIdent(ident) {
  const at = ident.indexOf('@', ident.startsWith('@') ? 1 : 0);
  return at === -1
    ? { name: ident, spec: '' }
    : { name: ident.slice(0, at), spec: ident.slice(at + 1) };
}

/** The package names a lockfile key nests: `a/@s/b/c` → ['a', '@s/b', 'c']. */
function keyNames(key) {
  const segments = key.split('/');
  const names = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].startsWith('@')) {
      names.push(`${segments[index]}/${segments[index + 1]}`);
      index += 1;
    } else names.push(segments[index]);
  }
  return names;
}

const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies'];

/**
 * Every copy of every package `bun.lock` installs, and who pulls each copy:
 * the workspaces and packages whose dependency on it resolves to that copy
 * (Node's walk: the dependent's own nested entry first, then each ancestor's,
 * then the hoisted one).
 *
 * @returns {Map<string, Array<{ key: string, version: string, pulledBy: Array<{ by: string, range: string, peer: boolean, oxy: boolean, workspace: boolean }> }>>}
 */
export function lockfileCopies(lock) {
  const packages = lock.packages ?? {};
  const workspaces = lock.workspaces ?? {};
  const catalog = lock.catalog ?? {};
  const catalogs = lock.catalogs ?? {};
  const copies = new Map();
  const byKey = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const { name, spec } = splitIdent(entry[0]);
    let version = spec;
    if (spec.startsWith('workspace:')) {
      const path = spec.slice('workspace:'.length);
      version = workspaces[path]?.version ?? spec;
    }
    const meta =
      entry.find((part) => part && typeof part === 'object' && !Array.isArray(part)) ?? {};
    const copy = {
      key,
      name,
      version,
      meta,
      workspace: spec.startsWith('workspace:'),
      bundled: meta.bundled === true,
      pulledBy: [],
    };
    byKey.set(key, copy);
    const list = copies.get(name) ?? [];
    list.push(copy);
    copies.set(name, list);
  }
  const resolveFrom = (chain, dependency) => {
    for (let depth = chain.length; depth >= 0; depth -= 1) {
      const key = [...chain.slice(0, depth), dependency].join('/');
      if (byKey.has(key)) return byKey.get(key);
    }
    return null;
  };
  const record = (chain, dependency, range, edge) => {
    const target = resolveFrom(chain, dependency);
    if (target) target.pulledBy.push({ range, ...edge });
  };
  for (const [path, workspace] of Object.entries(workspaces)) {
    const chain = path === '' || !workspace.name ? [] : [workspace.name];
    const by = path === '' ? 'package.json' : `${path}/package.json`;
    for (const section of [...DEPENDENCY_SECTIONS, 'peerDependencies'])
      for (const [dependency, range] of Object.entries(workspace[section] ?? {})) {
        let resolved = range;
        if (range.startsWith('catalog:')) {
          const named = range.slice('catalog:'.length);
          resolved =
            (named && named !== 'default' ? catalogs[named] : catalog)?.[dependency] ?? range;
        }
        record(chain, dependency, resolved, {
          by,
          peer: section === 'peerDependencies',
          oxy: typeof workspace.name === 'string' && isOxyPackage(workspace.name),
          workspace: true,
        });
      }
  }
  for (const copy of byKey.values()) {
    if (copy.workspace) continue;
    const chain = keyNames(copy.key);
    const by = `${copy.name}@${copy.version}`;
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const [dependency, range] of Object.entries(copy.meta[section] ?? {})) {
        record(chain, dependency, range, {
          by,
          peer: section === 'peerDependencies',
          oxy: isOxyPackage(copy.name),
          workspace: false,
        });
      }
  }
  return copies;
}

/** The package at one lockfile key, for naming it. */
function lockCopy(lock, key) {
  const entry = lock.packages?.[key];
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return null;
  const { name, spec } = splitIdent(entry[0]);
  return { name, version: spec };
}

/** The semver range in a dependency spec, or null when it is not one (git, file, link, tag). */
function semverRange(range) {
  const spec = range.startsWith('npm:') ? splitIdent(range.slice(4)).spec : range;
  return semver.validRange(spec) === null ? null : spec;
}

/** Workspaces install what they declare; packages install their dependencies, never their peers. */
function pullers(copy) {
  const installing = copy.pulledBy.filter((edge) => !edge.peer || edge.workspace);
  return installing.length > 0 ? installing : copy.pulledBy;
}

const LIST_LIMIT = 4;
function describeEdges(edges) {
  const unique = [...new Map(edges.map((edge) => [`${edge.by} ${edge.range}`, edge])).values()];
  const shown = unique
    .slice(0, LIST_LIMIT)
    .map((edge) => `${edge.by} (${edge.range})`)
    .join(', ');
  return unique.length > LIST_LIMIT ? `${shown} and ${unique.length - LIST_LIMIT} more` : shown;
}

/** "6.8.0 (pulled by …); 6.9.0 (3 copies, pulled by …)": one clause per version. */
function describeCopies(copies) {
  const byVersion = new Map();
  for (const copy of copies) {
    const rows = byVersion.get(copy.version) ?? [];
    rows.push(copy);
    byVersion.set(copy.version, rows);
  }
  return [...byVersion]
    .map(([version, rows]) => {
      const count = rows.length === 1 ? '' : `${rows.length} copies, `;
      const edges = describeEdges(rows.flatMap(pullers));
      return `${version} (${count}pulled by ${edges || 'nothing that declares it'})`;
    })
    .join('; ');
}

/**
 * Duplicate copies in a parsed `bun.lock`. Bun resolves each range to the
 * newest version it accepts and reuses an existing copy only when that copy
 * satisfies the range, so after an SDK bump moves the hoisted copy forward a
 * dependent's older nested copy can stay locked although the new one would do.
 *
 * - `duplicate-copy` (error, any package): the newest locked copy satisfies
 *   every range that pulls a copy. `bun update <name>` re-resolves them all to
 *   it.
 * - `duplicate-pinned`: every range accepts one OLDER locked version, but a
 *   dependent pins below the newest, so the resolver's newest-first choice
 *   splits them and `bun update` cannot. An error for a single-copy package
 *   (fix: a release of the pinning dependent, or a root `overrides` entry); a
 *   warning for any other package.
 * - `duplicate-conflict` (error, single-copy packages): no one version
 *   satisfies every range. No update or override is correct; the dependent
 *   whose range is too narrow needs a release.
 *
 * Copies of an ordinary package forced by incompatible ranges (two majors of
 * a utility) are normal and not reported.
 */
export function duplicateFindings(lock) {
  const findings = [];
  const overrides = lock.overrides ?? {};
  for (const [name, all] of lockfileCopies(lock)) {
    if (all.length < 2) continue;
    const shared = SHARED_WITH_OXY_PACKAGES.includes(name);
    const single = mustBeSingle(name) || shared;
    // A bundled copy ships inside its dependent's tarball: no resolver can
    // collapse it, so it counts only where a second copy is never acceptable.
    const copies = all.filter(
      (copy) => (single || !copy.bundled) && (!shared || copy.pulledBy.some((edge) => edge.oxy)),
    );
    if (copies.length < 2) continue;
    const edges = copies.flatMap(pullers);
    const ranges = edges.map((edge) => edge.range);
    if (overrides[name]) ranges.push(overrides[name]);
    const checkable = ranges.map(semverRange).filter((range) => range !== null);
    const acceptsAll = (version) => checkable.every((range) => semver.satisfies(version, range));
    const versions = [...new Set(copies.map((copy) => copy.version))]
      .filter((version) => semver.valid(version) !== null)
      .sort(semver.rcompare);
    const newest = versions[0];
    const bundled = copies.some((copy) => copy.bundled);
    const common = bundled ? undefined : versions.find(acceptsAll);
    const base = {
      package: name,
      installed: [...new Set(copies.map((copy) => copy.version))],
      copies: copies.map((copy) => ({
        key: copy.key,
        version: copy.version,
        pulledBy: pullers(copy).map(({ by, range }) => ({ by, range })),
      })),
    };
    const listing = describeCopies(copies);
    const rejecting = (version) =>
      edges.filter((edge) => {
        const range = semverRange(edge.range);
        return range !== null && !semver.satisfies(version, range);
      });
    const remedyFor = (version) => {
      const blockers = rejecting(version);
      const releases = [
        ...new Set(blockers.filter((edge) => !edge.workspace).map((edge) => edge.by)),
      ];
      const manifests = [
        ...new Set(blockers.filter((edge) => edge.workspace).map((edge) => edge.by)),
      ];
      const bundlers = copies
        .filter((copy) => copy.bundled)
        .map((copy) => {
          const owner = lockCopy(lock, keyNames(copy.key).slice(0, -1).join('/'));
          return owner ? `${owner.name}@${owner.version}` : copy.key;
        });
      const plural = (list, word) => `${word}${list.length === 1 ? 's' : ''}`;
      return {
        blockers: blockers.map(({ by, range }) => ({ by, range })),
        text:
          [
            bundlers.length > 0 &&
              `${bundlers.join(', ')} ${plural(bundlers, 'bundle')} a private copy and ${plural(bundlers, 'need')} a release that does not`,
            releases.length > 0 &&
              `${releases.join(', ')} ${plural(releases, 'need')} a release whose range accepts ${version}`,
            manifests.length > 0 &&
              `widen the range in ${manifests.join(', ')} to accept ${version}`,
          ]
            .filter(Boolean)
            .join('; ') || 'the ranges that pull these copies must be made compatible',
      };
    };
    if (common !== undefined && common === newest) {
      findings.push({
        severity: 'error',
        code: 'duplicate-copy',
        ...base,
        target: common,
        message: `${name}: ${copies.length} copies in bun.lock where one would do: ${listing}. Every range accepts ${common}: run \`bun update ${name}\` and commit bun.lock`,
      });
    } else if (common !== undefined) {
      if (!single && newest === undefined) continue;
      const remedy = remedyFor(newest);
      findings.push({
        severity: single ? 'error' : 'warning',
        code: 'duplicate-pinned',
        ...base,
        target: common,
        newest,
        blockers: remedy.blockers,
        message: `${name}: ${copies.length} copies in bun.lock: ${listing}. Every range accepts ${common}, but Bun resolves the wider ranges to ${newest}, so \`bun update\` keeps both: ${remedy.text}, or pin it with \`"overrides": { "${name}": "${common}" }\` in the root package.json`,
      });
    } else if (single) {
      const target =
        [...versions].sort((left, right) => rejecting(left).length - rejecting(right).length)[0] ??
        newest;
      const remedy = remedyFor(target);
      findings.push({
        severity: 'error',
        code: 'duplicate-conflict',
        ...base,
        target,
        blockers: remedy.blockers,
        message: `${name} must be a single copy, but bun.lock has ${copies.length} and no one version satisfies every range: ${listing}. A real conflict that \`bun update\` cannot fix: ${remedy.text}`,
      });
    }
  }
  return findings.sort((left, right) => left.package.localeCompare(right.package));
}

/**
 * Every installed copy of a single-copy package under the repository's
 * node_modules trees (hoisted or Bun's isolated `.bun` store), by real path, so
 * a symlink is one copy and a stale nested directory the lockfile no longer
 * names is another.
 *
 * @param {string} root
 * @param {string[]} workspaceDirs
 * @returns {Map<string, Array<{ path: string, version: string }>> | null} null when nothing is installed
 */
export function installedCopies(root, workspaceDirs = []) {
  const pending = [root, ...workspaceDirs]
    .map((directory) => join(directory, 'node_modules'))
    .filter((directory) => existsSync(directory));
  if (pending.length === 0) return null;
  const seen = new Set();
  const found = new Map();
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const list = (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  };
  const visitPackage = (directory) => {
    const resolved = real(directory);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    const manifestPath = join(resolved, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string' && mustBeSingle(manifest.name)) {
          const rows = found.get(manifest.name) ?? [];
          rows.push({ path: relative(root, resolved) || '.', version: String(manifest.version) });
          found.set(manifest.name, rows);
        }
      } catch {
        // A package.json that does not parse is not a package this check can name.
      }
    }
    const nested = join(resolved, 'node_modules');
    if (existsSync(nested)) pending.push(nested);
  };
  while (pending.length > 0) {
    const modules = pending.pop();
    const resolved = real(modules);
    if (!resolved || seen.has(`modules:${resolved}`)) continue;
    seen.add(`modules:${resolved}`);
    for (const entry of list(resolved)) {
      if (entry === '.bin' || entry === '.cache') continue;
      if (entry === '.bun') {
        for (const store of list(join(resolved, entry))) {
          const storeModules = join(resolved, entry, store, 'node_modules');
          if (existsSync(storeModules)) pending.push(storeModules);
        }
        continue;
      }
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) {
        for (const scoped of list(join(resolved, entry)))
          visitPackage(join(resolved, entry, scoped));
      } else visitPackage(join(resolved, entry));
    }
  }
  return found;
}

/** `installed-duplicate` errors for single-copy packages installed more than once. */
export function installedDuplicateFindings(root, workspaceDirs, alreadyReported = new Set()) {
  const copies = installedCopies(root, workspaceDirs);
  if (copies === null) return { checked: false, findings: [] };
  const findings = [];
  for (const [name, rows] of [...copies].sort(([left], [right]) => left.localeCompare(right))) {
    if (rows.length < 2 || alreadyReported.has(name)) continue;
    rows.sort((left, right) => left.path.localeCompare(right.path));
    findings.push({
      severity: 'error',
      code: 'installed-duplicate',
      package: name,
      installed: [...new Set(rows.map((row) => row.version))],
      paths: rows,
      message: `${name} is installed ${rows.length} times: ${rows.map((row) => `${row.path} (${row.version})`).join(', ')}. bun.lock names one copy, so the install is stale: run \`bun install --frozen-lockfile\` (after a hoisted-linker churn, \`rm -rf node_modules packages/*/node_modules\` first)`,
    });
  }
  return { checked: true, findings };
}
