// The checks the shared npm release workflow (`npm-release.yml`) runs around
// one public package of the repository that calls it. It runs from its own
// checkout of OxyHQ/oxy at the workflow's commit, against the caller's tree in
// the current directory, so it holds nothing specific to any one repository.
//
//   resolve <name>        prints the package's directory; refuses a name that is
//                         not a public (non-`private`) package of the repository
//                         (a workspace, or the root package itself), and one
//                         that declares no `prepublishOnly`: that script is the
//                         package's own pre-flight, and the release runs it
//   dependencies <name>   prints, dependencies first, the directories of the
//                         workspace packages it links with `workspace:` (any
//                         dependency field): what a fresh checkout must build
//                         before the package builds
//   pack <dir> <dest>     builds the package and writes its ONE release tarball
//                         into <dest>: `bun pm pack` (which rewrites
//                         `workspace:`/`catalog:` ranges), or, when the package
//                         declares `release:pack`, that script with <dest> as
//                         its argument: a package that publishes a staged
//                         manifest packs and tests it itself, and the release
//                         publishes exactly that tarball
//   inspect <tgz> <dir>   checks the packed tarball: it is that package at that
//                         version, bun rewrote every `workspace:`/`catalog:`
//                         range, every entry point it declares is inside it, it
//                         ships no TypeScript build-info file, every
//                         `workspace:` dependency names the version that
//                         workspace has in this same commit (bun writes it from
//                         `bun.lock`, so a stale lockfile pins an old version),
//                         and every range a consumer installs (dependencies,
//                         peer, optional) already resolves on the registry
//   dist-tag <name> <version> <tag>
//                         refuses a `latest` that is a prerelease or older than
//                         the registry's `latest`; any other tag is the
//                         release's own choice
//
// Registry reads are anonymous (`--userconfig /dev/null`): nothing here holds a
// credential, and the publish job's OIDC exchange happens only in `npm publish`.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
];
const CONSUMER_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

/** `packages/*` or a literal directory; any other glob is refused rather than guessed at. */
function expandWorkspacePattern(root, pattern) {
  if (pattern.endsWith('/*') && !pattern.slice(0, -2).includes('*')) {
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json')),
      )
      .map((entry) => `${parent}/${entry.name}`)
      .sort();
  }
  if (/[*?[\]{}!]/.test(pattern)) throw new Error(`unsupported workspace pattern "${pattern}"`);
  return [pattern];
}

/** The root package (directory `.`) and every workspace, whichever form `workspaces` takes. */
export function workspacePackages(root) {
  const manifest = readManifest(root);
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  return [
    { directory: '.', manifest },
    ...patterns
      .flatMap((pattern) => expandWorkspacePattern(root, pattern))
      .map((directory) => ({ directory, manifest: readManifest(join(root, directory)) })),
  ];
}

export function resolveWorkspace(name, workspaces) {
  const releasable = workspaces.filter(
    ({ manifest }) => manifest.name && manifest.private !== true,
  );
  const match = releasable.find(({ manifest }) => manifest.name === name);
  if (!match) {
    const names = releasable.map(({ manifest }) => manifest.name).join(', ');
    throw new Error(`${name} is not a public package of this repository; releasable: ${names}`);
  }
  if (!match.manifest.scripts?.prepublishOnly)
    throw new Error(
      `${name} declares no prepublishOnly: a public package states its own pre-flight (typecheck, tests, build) there`,
    );
  return match.directory;
}

export function workspaceDependencies(name, workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const order = [];
  const visit = (current, path) => {
    if (path.includes(current))
      throw new Error(`workspace cycle: ${[...path, current].join(' -> ')}`);
    if (order.includes(current)) return;
    for (const field of DEPENDENCY_FIELDS)
      for (const [dependency, range] of Object.entries(byName.get(current).manifest[field] ?? {}))
        if (range.startsWith('workspace:') && byName.has(dependency))
          visit(dependency, [...path, current]);
    order.push(current);
  };
  visit(name, []);
  return order
    .filter((dependency) => dependency !== name)
    .map((dependency) => byName.get(dependency).directory);
}

function entryTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(entryTargets);
}

/** Every problem with a packed manifest and its file list; empty when it can ship. */
export function manifestProblems(packed, source, entries) {
  const problems = [];
  if (packed.name !== source.name || packed.version !== source.version)
    problems.push(
      `packed ${packed.name}@${packed.version}, the workspace is ${source.name}@${source.version}`,
    );
  for (const field of DEPENDENCY_FIELDS)
    for (const [dependency, range] of Object.entries(packed[field] ?? {}))
      if (/^(workspace|catalog):/.test(range))
        problems.push(`${field}.${dependency} is the unresolvable "${range}": pack with bun`);
  const files = new Set(entries.map((entry) => entry.replace(/^package\//, '')));
  for (const file of files)
    if (file.endsWith('.tsbuildinfo'))
      problems.push(`ships the TypeScript build-info file ${file}: exclude it in "files"`);
  const declared = [
    packed.main,
    packed.module,
    packed.types,
    ...entryTargets(packed.bin),
    ...entryTargets(packed.exports),
  ];
  for (const target of declared)
    if (
      typeof target === 'string' &&
      !target.includes('*') &&
      !files.has(target.replace(/^\.\//, ''))
    )
      problems.push(`declares ${target}, which is not in the tarball`);
  return problems;
}

/** The range `bun pm pack` must write for a `workspace:` spec on a workspace at `version`. */
function packedWorkspaceRange(spec, version) {
  const range = spec.slice('workspace:'.length);
  if (range === '*') return version;
  if (range === '^' || range === '~') return `${range}${version}`;
  return range;
}

/**
 * Every consumer-facing `workspace:` dependency whose packed range is not the
 * one this commit's workspace gives it. bun takes the version from `bun.lock`,
 * not from the workspace's package.json, so a version bump without its
 * lockfile line ships the dependent pinned to the previous version.
 */
export function workspaceRangeProblems(packed, source, workspaces) {
  const versions = new Map(workspaces.map(({ manifest }) => [manifest.name, manifest.version]));
  const problems = [];
  for (const field of CONSUMER_FIELDS)
    for (const [dependency, spec] of Object.entries(source[field] ?? {})) {
      if (!spec.startsWith('workspace:') || !versions.has(dependency)) continue;
      const expected = packedWorkspaceRange(spec, versions.get(dependency));
      const actual = packed[field]?.[dependency];
      if (actual !== expected)
        problems.push(
          `${field}.${dependency} is packed as "${actual}", but ${dependency} is ${versions.get(dependency)} in this commit ("${expected}"): bun.lock is stale; run bun install and commit it`,
        );
    }
  return problems;
}

/** The ranges a consumer's install resolves: everything but devDependencies. */
export function consumerRanges(packed) {
  return CONSUMER_FIELDS.flatMap((field) =>
    Object.entries(packed[field] ?? {}).map(([dependency, range]) => `${dependency}@${range}`),
  );
}

function npmView(spec, field) {
  try {
    return execFileSync('npm', ['view', spec, field, '--json', '--userconfig', '/dev/null'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** npm answers a range nothing satisfies with an empty body, and an unknown name with E404. */
function resolvesOnRegistry(spec) {
  const out = npmView(spec, 'version');
  return out !== '' && out !== '[]';
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
  if (!match) throw new Error(`"${version}" is not a semantic version`);
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] };
}

/** Why `version` may not take `tag`, given the registry's current `latest` (or none). */
export function distTagProblem(version, tag, registryLatest) {
  if (tag !== 'latest') return null;
  const next = parseVersion(version);
  if (next.prerelease)
    return `${version} is a prerelease; publish it under its own tag (next, beta…), never latest`;
  if (!registryLatest) return null;
  const current = parseVersion(registryLatest).core;
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] > current[index]) return null;
    if (next.core[index] < current[index])
      return `${version} is older than latest ${registryLatest}; publish it under its own tag (e.g. the major's legacy line)`;
  }
  return `${version} is latest already`;
}

function inspect(tarball, directory) {
  const source = readManifest(directory);
  const packed = JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  // The listing outgrows execFileSync's 1 MiB default buffer: @oxy.so/bloom
  // ships ~24 000 files, whose names alone are over 1 MiB (ENOBUFS).
  const entries = execFileSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  const problems = [
    ...manifestProblems(packed, source, entries),
    ...workspaceRangeProblems(packed, source, workspacePackages(process.cwd())),
  ];
  for (const spec of consumerRanges(packed))
    if (!resolvesOnRegistry(spec))
      problems.push(`depends on ${spec}, which nothing on the registry satisfies yet`);
  if (problems.length) {
    console.error(
      `${packed.name}@${packed.version} cannot be released:\n- ${problems.join('\n- ')}`,
    );
    process.exit(1);
  }
  console.log(`${packed.name}@${packed.version}: ${entries.length} files, every check passed`);
}

/** Build, then the package's own release tarball into `destination`. */
function pack(directory, destination) {
  // The builds log to stderr: stdout is the tarball's path, for the caller.
  const run = (command, args) =>
    execFileSync(command, args, { cwd: directory, stdio: ['ignore', 2, 2] });
  run('bun', ['run', '--if-present', 'build']);
  if (readManifest(directory).scripts?.['release:pack'])
    run('bun', ['run', 'release:pack', destination]);
  else run('bun', ['pm', 'pack', '--destination', destination]);
  const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1)
    fail(`expected exactly one tarball in ${destination}, found ${tarballs.length}`);
  console.log(join(destination, tarballs[0]));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'resolve' || command === 'dependencies') {
    try {
      const workspaces = workspacePackages(process.cwd());
      const directory = resolveWorkspace(args[0], workspaces);
      console.log(
        command === 'resolve' ? directory : workspaceDependencies(args[0], workspaces).join('\n'),
      );
    } catch (error) {
      fail(error.message);
    }
  } else if (command === 'pack') {
    pack(resolve(args[0]), resolve(args[1]));
  } else if (command === 'inspect') {
    inspect(resolve(args[0]), resolve(args[1]));
  } else if (command === 'dist-tag') {
    const [name, version, tag] = args;
    const latest = npmView(`${name}@latest`, 'version');
    const problem = distTagProblem(version, tag, latest ? JSON.parse(latest) : null);
    if (problem) fail(`${name}@${version} cannot be published as "${tag}": ${problem}`);
    console.log(`${name}@${version} publishes as "${tag}"`);
  } else {
    fail(
      'usage: release-package.mjs resolve <name> | dependencies <name> | pack <directory> <destination> | inspect <tgz> <directory> | dist-tag <name> <version> <tag>',
    );
  }
}
