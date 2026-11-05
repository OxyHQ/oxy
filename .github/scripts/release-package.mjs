// The checks the shared npm release workflow (`npm-release.yml`) runs for the
// repository that calls it. It runs from its own checkout of OxyHQ/oxy at the
// workflow's commit, against the caller's tree in the current directory, so it
// holds nothing specific to any one repository.
//
//   plan                  prints, as JSON, what this commit releases: every
//                         public (non-`private`) package of the repository (a
//                         workspace, or the root package itself) whose version
//                         is not on the registry yet, dependencies first, each
//                         with the dist-tag it publishes under; and the
//                         directories to build for them, dependencies first,
//                         each once. Refuses a version whose dist-tag would be
//                         wrong (see `releaseTag`, `distTagProblem`)
//   ci <sha> <workflow>   waits until a run of the caller's CI workflow (its
//                         file name) on exactly <sha>, from a `push` or
//                         `merge_group` event, has passed; fails when every
//                         such run concluded otherwise, when none appears, or
//                         when GitHub cannot answer. Needs GH_TOKEN with
//                         `actions: read`
//   pack <dir> <dest>     writes the package's ONE release tarball into <dest>
//                         from its already-built tree: `bun pm pack
//                         --ignore-scripts` (which rewrites `workspace:`/
//                         `catalog:` ranges, and runs no `prepack`/`prepare`
//                         that would build a second time), or, when the
//                         package declares `release:pack`, that script with
//                         <dest> as its argument: a package that publishes a
//                         staged manifest packs and tests it itself, and the
//                         release publishes exactly that tarball
//   inspect <tgz> <dir> [<releasing name>...]
//                         checks the packed tarball: it is that package at that
//                         version, bun rewrote every `workspace:`/`catalog:`
//                         range, every entry point it declares is inside it, it
//                         ships no TypeScript build-info file, every
//                         `workspace:` dependency names the version that
//                         workspace has in this same commit (bun writes it from
//                         `bun.lock`, so a stale lockfile pins an old version),
//                         and every range a consumer installs (dependencies,
//                         peer, optional) already resolves on the registry, or
//                         is satisfied by the exact version this same ordered
//                         release publishes first
//   publish-status <name> <version> <tgz>
//                         fresh registry read: 0 only for identical SHA-512,
//                         1 absent, 2 conflicting bytes or registry failure
//   published <name> <version>
//                         exits 0 when that version is on the registry, 1 when
//                         it is not, and 2 when the registry cannot say
//
// Registry reads are anonymous (`--userconfig /dev/null`): nothing here holds a
// credential, and the publish job's OIDC exchange happens only in `npm publish`.
// A registry or GitHub error is never read as an answer: it fails the run.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

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

/** The packages the release publishes: every one with a name that is not `private`. */
export function publicPackages(workspaces) {
  return workspaces.filter(({ manifest }) => manifest.name && manifest.private !== true);
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

/**
 * The directories to build so that every package in `names` can be packed,
 * dependencies first and each once: every workspace a package links, then the
 * package. Each package's own list is in dependency order, and a directory
 * already listed was listed before anything that needs it, so the
 * concatenation stays in dependency order.
 */
export function buildOrder(names, workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const directories = [];
  for (const name of names)
    for (const directory of [
      ...workspaceDependencies(name, workspaces),
      byName.get(name).directory,
    ])
      if (!directories.includes(directory)) directories.push(directory);
  return directories;
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

/**
 * The ranges a consumer's install resolves (everything but devDependencies),
 * except ranges satisfied by an exact version this release publishes first.
 * Check each field separately: a matching dependency range must not exempt
 * an incompatible peer range for the same package name.
 */
export function consumerRanges(packed, publishedFirst = new Map()) {
  return CONSUMER_FIELDS.flatMap((field) =>
    Object.entries(packed[field] ?? {})
      .filter(([dependency, range]) => {
        const version = publishedFirst.get(dependency);
        return !version || !satisfiesRange(version, range);
      })
      .map(([dependency, range]) => `${dependency}@${range}`),
  );
}

/** Only inspect needs this locked helper package; plan/publish remain dependency-free. */
function satisfiesRange(version, range) {
  const requireRuntime = createRequire(new URL('./release-runtime/package.json', import.meta.url));
  // Resolve only our installed package, never a caller's transitive dependency.
  const semver = requireRuntime('./node_modules/semver');
  return (
    semver.valid(version) !== null &&
    semver.validRange(range) !== null &&
    semver.satisfies(version, range)
  );
}

/** Membership alone is insufficient: only preceding entries will be published first. */
export function plannedDependencyVersions(name, workspaces, releasing) {
  const order = [...releasing];
  const position = order.indexOf(name);
  const preceding = new Set(position < 0 ? [] : order.slice(0, position));
  return new Map(
    publicPackages(workspaces)
      .filter(({ manifest }) => preceding.has(manifest.name))
      .map(({ manifest }) => [manifest.name, manifest.version]),
  );
}

/**
 * `npm view <spec> <field>`, anonymously: the JSON value, or null when the
 * registry has nothing for it (an unknown name answers E404, a version or range
 * nothing satisfies answers an empty body). Any other failure throws: a
 * registry that cannot answer has not said "absent".
 */
function npmView(spec, field) {
  const result = spawnSync(
    'npm',
    [
      'view',
      spec,
      ...(field ? [field] : []),
      '--json',
      '--prefer-online',
      '--userconfig',
      '/dev/null',
    ],
    {
      encoding: 'utf8',
    },
  );
  if (result.status === 0) {
    const out = result.stdout.trim();
    return out === '' || out === '[]' ? null : JSON.parse(out);
  }
  if (/\bE404\b/.test(result.stderr)) return null;
  throw new Error(`npm view ${spec} ${field} failed: ${result.stderr.trim() || result.error}`);
}

/** Only identical trusted bytes may be skipped after another queued run publishes. */
export function identicalPublishedTarball(metadata, name, version, bytes) {
  if (metadata === null) return false;
  if (metadata.name !== name || metadata.version !== version)
    throw new Error(`registry identity does not match ${name}@${version}`);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (metadata.dist?.integrity !== integrity)
    throw new Error(
      `${name}@${version} already exists with different or missing SHA-512 integrity`,
    );
  return true;
}

/** Whether anything on the registry satisfies `name@range`. */
function resolvesOnRegistry(spec) {
  return npmView(spec, 'version') !== null;
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

/**
 * The dist-tag a version publishes under: `latest` for a release, and for a
 * prerelease the name of its line (`2.0.0-next.1` -> `next`,
 * `4.11.0-oxy-one.0` -> `oxy-one`). A prerelease that names no line
 * (`2.0.0-0`) is refused: it would have no tag to go to.
 */
export function releaseTag(version) {
  const { prerelease } = parseVersion(version);
  if (!prerelease) return 'latest';
  const line = prerelease.split('.')[0];
  if (/^\d+$/.test(line))
    throw new Error(`${version} names no prerelease line; version it as e.g. 2.0.0-next.0`);
  return line;
}

/** What this commit releases, and what to build for it; see the header. */
export function plan(workspaces, registry) {
  const pending = [];
  const problems = [];
  for (const { directory, manifest } of publicPackages(workspaces)) {
    const { name, version } = manifest;
    if (registry.published(name, version)) continue;
    try {
      const tag = releaseTag(version);
      const problem = distTagProblem(version, tag, registry.latest(name));
      if (problem) problems.push(`${name}@${version} cannot be published as "${tag}": ${problem}`);
      pending.push({ name, version, directory, tag });
    } catch (error) {
      problems.push(`${name}@${version}: ${error.message}`);
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
  const build = buildOrder(
    pending.map(({ name }) => name),
    workspaces,
  );
  const release = build.flatMap((directory) =>
    pending.filter((candidate) => candidate.directory === directory),
  );
  return { release, build };
}

/** The events whose CI run tested the very commit that is now on the branch. */
const VOUCHING_EVENTS = ['push', 'merge_group'];

/**
 * What the CI runs of one commit say about it: `passed` once any vouching run
 * succeeded; `pending` while one is still running, or none has appeared yet;
 * `failed` when every vouching run finished without succeeding.
 */
export function ciVerdict(runs, sha) {
  const vouching = runs.filter(
    (run) => run.head_sha === sha && VOUCHING_EVENTS.includes(run.event),
  );
  if (vouching.some((run) => run.conclusion === 'success')) return 'passed';
  if (vouching.length === 0 || vouching.some((run) => run.status !== 'completed')) return 'pending';
  return 'failed';
}

const CI_POLL_MS = 20_000;
/** How long a commit may have no CI run at all before that counts as "never". */
const CI_APPEAR_MS = 5 * 60_000;
/** Consecutive unanswered API calls tolerated before the run fails. */
const CI_API_ATTEMPTS = 3;

async function waitForCi(sha, workflow) {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`"${sha}" is not a full commit id`);
  if (!repository || !process.env.GH_TOKEN) fail('ci needs GITHUB_REPOSITORY and GH_TOKEN');
  const url = `${api}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=100`;
  const started = Date.now();
  let unanswered = 0;
  for (;;) {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${process.env.GH_TOKEN}`,
      },
    }).catch((error) => ({ ok: false, status: error.message }));
    if (!response.ok) {
      unanswered += 1;
      if (unanswered >= CI_API_ATTEMPTS)
        fail(`GitHub did not list the ${workflow} runs of ${sha}: ${response.status}`);
    } else {
      unanswered = 0;
      const runs = (await response.json()).workflow_runs;
      const verdict = ciVerdict(runs, sha);
      const seen = runs
        .filter((run) => VOUCHING_EVENTS.includes(run.event))
        .map((run) => `${run.event} ${run.html_url} ${run.conclusion ?? run.status}`);
      if (verdict === 'passed') {
        console.log(`${workflow} passed on ${sha}:\n${seen.join('\n')}`);
        return;
      }
      if (verdict === 'failed')
        fail(`${workflow} did not pass on ${sha}; nothing is released:\n${seen.join('\n')}`);
      if (seen.length === 0 && Date.now() - started > CI_APPEAR_MS)
        fail(`${workflow} has no push or merge_group run on ${sha}; nothing is released`);
    }
    await new Promise((resume) => setTimeout(resume, CI_POLL_MS));
  }
}

function inspect(tarball, directory, releasing) {
  const source = readManifest(directory);
  const workspaces = workspacePackages(process.cwd());
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
    ...workspaceRangeProblems(packed, source, workspaces),
  ];
  const publishedFirst = plannedDependencyVersions(packed.name, workspaces, releasing);
  for (const spec of consumerRanges(packed, publishedFirst))
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

/** The package's own release tarball into `destination`, from its built tree. */
function pack(directory, destination) {
  // Anything the scripts print goes to stderr: stdout is the tarball's path.
  const run = (command, args) =>
    execFileSync(command, args, { cwd: directory, stdio: ['ignore', 2, 2] });
  if (readManifest(directory).scripts?.['release:pack'])
    run('bun', ['run', 'release:pack', destination]);
  else run('bun', ['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', destination]);
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
  try {
    if (command === 'plan') {
      const registry = {
        published: (name, version) => npmView(`${name}@${version}`, 'version') !== null,
        latest: (name) => npmView(`${name}@latest`, 'version'),
      };
      console.log(JSON.stringify(plan(workspacePackages(process.cwd()), registry)));
    } else if (command === 'ci') {
      await waitForCi(args[0], args[1]);
    } else if (command === 'pack') {
      pack(resolve(args[0]), resolve(args[1]));
    } else if (command === 'inspect') {
      inspect(resolve(args[0]), resolve(args[1]), new Set(args.slice(2)));
    } else if (command === 'publish-status') {
      const [name, version, tarball] = args;
      if (!name || !version || !tarball)
        throw new Error('publish-status requires name, version and tarball');
      process.exit(
        identicalPublishedTarball(
          npmView(`${name}@${version}`, ''),
          name,
          version,
          readFileSync(tarball),
        )
          ? 0
          : 1,
      );
    } else if (command === 'published') {
      process.exit(npmView(`${args[0]}@${args[1]}`, 'version') === null ? 1 : 0);
    } else {
      fail(
        'usage: release-package.mjs plan | ci <sha> <workflow> | pack <directory> <destination> | inspect <tgz> <directory> [<releasing name>...] | published <name> <version> | publish-status <name> <version> <tgz>',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
