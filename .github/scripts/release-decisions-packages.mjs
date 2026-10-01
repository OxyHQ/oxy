// Release the reviewed decisions pair: @oxy.so/contracts then @oxy.so/core.
//
// Same guarantees as release-external-identity-packages.mjs, whose pure guards
// are reused unchanged: exact protected main SHA, build+pack in one command,
// immutable integrity (identical bytes are idempotent, different bytes refuse),
// dry run by default, existing NPM_TOKEN only.
//
// Four phases, run by three jobs of release-decisions-packages.yml:
//   prepare  (build job; again in the publish job) frozen-lockfile build, pack,
//            test and inspect from the exact SHA. Runs only locked code.
//   smoke    (smoke job, no token) checks the trusted tarballs' integrity, then
//            installs them as a consumer with npm and bun — which resolves
//            UNLOCKED registry code — in a temp directory, with an allowlisted
//            environment and a real minimum release age. Nothing it writes is
//            read by a later job; the publish job depends only on its success.
//   verify   (publish job, no token) the job's own rebuild must equal the build
//            job's bytes; anonymous registry preflight of both versions.
//   publish  (publish job, apply only, token) re-checks source and registry,
//            then publishes the job's own rebuilt tarballs in dependency order.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  integrity,
  releaseDecision,
  validateArtifactManifest,
  validateSource,
} from './release-external-identity-packages.mjs';

export const RELEASES = Object.freeze([
  { directory: 'contracts', name: '@oxy.so/contracts', version: '4.7.0' },
  // Core's own build pre-builds only telemetry; protocol must be built first
  // in a fresh checkout. Contracts is built just before, as this pair's first.
  { directory: 'core', name: '@oxy.so/core', version: '4.1.0', workspaceBuilds: ['@oxy.so/protocol'] },
]);
/** Every consumer combination, exactly: installer / runtime / entry point. */
export const EXPECTED_SMOKE_CASES = Object.freeze(
  ['npm', 'bun'].flatMap((installer) => ['node', 'bun'].flatMap((runtime) => ['smoke.mjs', 'smoke.cjs'].map((entry) => `${installer}/${runtime}/${entry}`))),
);
/** Registry versions younger than this are not installed by the smoke. */
export const SMOKE_MINIMUM_RELEASE_AGE_SECONDS = 3 * 24 * 60 * 60;
const registry = 'https://registry.npmjs.org';
const root = resolve(process.cwd());
const artifacts = join(root, 'release-artifacts');
const trusted = join(root, 'trusted-artifacts');
const smokeSource = join(fileURLToPath(new URL('.', import.meta.url)), 'decisions-release-smoke');

function run(command, args, cwd = root) {
  const directory = resolve(cwd);
  if (directory !== root && !directory.startsWith(`${root}/`)) throw new Error('cwd must stay within repository root');
  return execFileSync(command, args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}
function assertSource() {
  validateSource(process.env.EXPECTED_SOURCE_SHA, run('git', ['rev-parse', 'HEAD']), process.env.GITHUB_REF, process.env.DRY_RUN, process.env.GITHUB_REF_PROTECTED);
  const currentMain = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (currentMain !== process.env.EXPECTED_SOURCE_SHA) throw new Error('Protected main advanced; review and dispatch the current source SHA');
  if (run('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Tracked release source has changed');
}
const fileName = (release) => `oxy.so-${release.directory}-${release.version}.tgz`;

/**
 * The packed core manifest must depend on EXACTLY this contracts release, and
 * every other first-party dependency must be a caret range over a version the
 * registry already serves (`published` answers that). Returns the floors checked.
 */
export function validateFirstPartyDependencies(manifest, published) {
  const [contracts] = RELEASES;
  const checked = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith('@oxy.so/')) continue;
    if (name === contracts.name) {
      if (manifest.name !== contracts.name && range !== `^${contracts.version}`) {
        throw new Error(`${manifest.name} must depend on ${contracts.name} ^${contracts.version}, not ${range}`);
      }
      continue;
    }
    const floor = /^\^(\d+\.\d+\.\d+)$/.exec(range)?.[1];
    if (floor === undefined) throw new Error(`${name} must be a published caret range, not ${range}`);
    if (!published(name, floor)) throw new Error(`${name}@${floor} is not published`);
    checked.push(`${name}@${floor}`);
  }
  if (manifest.name !== contracts.name && manifest.dependencies?.[contracts.name] === undefined) {
    throw new Error(`${manifest.name} must depend on ${contracts.name}`);
  }
  for (const field of ['peerDependencies', 'optionalDependencies']) {
    if (Object.keys(manifest[field] ?? {}).some((name) => name.startsWith('@oxy.so/'))) {
      throw new Error(`${manifest.name} names a first-party ${field} entry this release does not check`);
    }
  }
  return checked;
}

/**
 * The only environment a consumer install or smoke sees. No `GITHUB_*` file
 * command paths, no runner or Actions tokens, no `NODE_OPTIONS`, no npm auth.
 */
export function consumerEnv(source, sandbox) {
  return {
    PATH: source.PATH ?? '/usr/bin:/bin',
    HOME: join(sandbox, 'home'),
    TMPDIR: join(sandbox, 'tmp'),
    LANG: 'C.UTF-8',
    CI: 'true',
    npm_config_cache: join(sandbox, 'npm-cache'),
    npm_config_userconfig: join(sandbox, 'home', '.npmrc'),
    BUN_INSTALL_CACHE_DIR: join(sandbox, 'bun-cache'),
  };
}

/**
 * A published first-party floor, pinned by the registry's own integrity at
 * build time. The smoke installs exactly these bytes instead of resolving them,
 * so they need no release-age wait: integrity is the stronger guarantee.
 */
export function firstPartyFloor(key, document) {
  const at = key.lastIndexOf('@');
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  const tarball = document?.dist?.tarball;
  const value = document?.dist?.integrity;
  if (!name.startsWith('@oxy.so/') || document?.name !== name || document.version !== version ||
      typeof value !== 'string' || !value.startsWith('sha512-') ||
      typeof tarball !== 'string' || !tarball.startsWith(`${registry}/${name}/-/`)) {
    throw new Error(`${key} has no registry tarball and integrity to pin`);
  }
  return { name, version, tarball, integrity: value };
}

/** Same packages, versions and bytes, from the same source commit. */
export function assertSameArtifacts(own, reference) {
  if (own.sourceSha !== reference.sourceSha) throw new Error('Trusted build belongs to another commit');
  const describe = (prepared) => JSON.stringify(prepared.packages.map(({ name, version, file, integrity: value }) => [name, version, file, value]));
  if (describe(own) !== describe(reference)) throw new Error('Rebuilt artifacts differ from the trusted build');
  if (JSON.stringify(own.dependencyFloors) !== JSON.stringify(reference.dependencyFloors)) throw new Error('Dependency floors differ from the trusted build');
}

function inspect(directory, release) {
  const tarball = join(directory, fileName(release));
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  if (entries.some((entry) => !entry.startsWith('package/') || entry.split('/').includes('..'))) throw new Error('Unsafe archive path');
  if (entries.some((entry) => entry.includes('/__tests__/'))) throw new Error('Tests leaked into the artifact');
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  validateArtifactManifest(release, manifest, entries);
  return { manifest, artifact: { name: release.name, version: release.version, file: fileName(release), integrity: integrity(readFileSync(tarball)) } };
}
async function registryDocument(name, version) {
  // Anonymous on purpose: preflight never needs a credential.
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry lookup failed (${response.status})`);
  return response.json();
}
async function published(release) {
  const document = await registryDocument(release.name, release.version);
  if (document === null) return null;
  if (typeof document.dist?.integrity !== 'string') throw new Error('Registry omitted immutable integrity');
  return document.dist.integrity;
}
function readPrepared(directory) {
  return JSON.parse(readFileSync(join(directory, 'prepared.json'), 'utf8'));
}
/** Inspect every tarball in `directory` and require the bytes `prepared` names. */
function verifiedPackages(directory, prepared) {
  if (prepared.sourceSha !== process.env.EXPECTED_SOURCE_SHA) throw new Error('Artifact preparation belongs to another commit');
  return RELEASES.map((release, index) => {
    const { artifact } = inspect(directory, release);
    const entry = prepared.packages[index];
    if (entry?.name !== artifact.name || entry.version !== artifact.version || entry.integrity !== artifact.integrity) throw new Error('Prepared artifact changed');
    return artifact;
  });
}
async function preflight(packages) {
  // BOTH immutable versions before any publication.
  const states = [];
  for (const [index, release] of RELEASES.entries()) {
    states.push({ ...packages[index], state: releaseDecision(await published(release), packages[index].integrity) });
  }
  return states;
}

async function prepare() {
  assertSource();
  mkdirSync(artifacts, { recursive: true });
  const built = [];
  const dependencyFloors = [];
  for (const release of RELEASES) {
    const directory = join(root, 'packages', release.directory);
    const source = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (source.name !== release.name || source.version !== release.version) throw new Error('Source version differs from fixed release');
    for (const dependency of release.workspaceBuilds ?? []) run('bun', ['run', '--filter', dependency, 'build']);
    rmSync(join(artifacts, fileName(release)), { force: true });
    // One command; the inspected tarball can only come from this build.
    run('bash', ['-euo', 'pipefail', '-c', 'bun run clean && bun run build && bun pm pack --destination ../../release-artifacts'], directory);
    run('bun', ['run', 'test'], directory);
    if (source.scripts?.['test:package']) run('bun', ['run', 'test:package'], directory);
    const { manifest, artifact } = inspect(artifacts, release);
    const known = new Map();
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const floor = /^\^(\d+\.\d+\.\d+)$/.exec(range)?.[1];
      if (name.startsWith('@oxy.so/') && name !== RELEASES[0].name && floor !== undefined) {
        known.set(`${name}@${floor}`, await registryDocument(name, floor));
      }
    }
    validateFirstPartyDependencies(manifest, (name, floor) => known.get(`${name}@${floor}`) != null);
    for (const [key, document] of known) {
      dependencyFloors.push(firstPartyFloor(key, document));
    }
    built.push(artifact);
  }
  writeFileSync(join(artifacts, 'prepared.json'), `${JSON.stringify({ sourceSha: process.env.EXPECTED_SOURCE_SHA, packages: built, dependencyFloors }, null, 2)}\n`);
}

async function smoke() {
  const prepared = readPrepared(trusted);
  const packages = verifiedPackages(trusted, prepared);
  const sandbox = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'decisions-smoke-'));
  for (const directory of ['home', 'tmp']) mkdirSync(join(sandbox, directory));
  const env = consumerEnv(process.env, sandbox);
  const before = new Date(Date.now() - SMOKE_MINIMUM_RELEASE_AGE_SECONDS * 1000).toISOString();
  const consumer = (command, args, cwd) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  for (const release of RELEASES) copyFileSync(join(trusted, fileName(release)), join(sandbox, fileName(release)));
  const pinned = Object.fromEntries(RELEASES.map((release) => [release.name, `file:../${fileName(release)}`]));
  if (!Array.isArray(prepared.dependencyFloors)) throw new Error('The trusted build recorded no dependency floors');
  for (const floor of prepared.dependencyFloors) {
    const checked = firstPartyFloor(`${floor.name}@${floor.version}`, { name: floor.name, version: floor.version, dist: floor });
    const response = await fetch(checked.tarball, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Could not fetch ${floor.name}@${floor.version} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (integrity(bytes) !== checked.integrity) throw new Error(`${floor.name}@${floor.version} bytes differ from the trusted build's record`);
    const file = `floor-${floor.name.slice('@oxy.so/'.length)}-${floor.version}.tgz`;
    writeFileSync(join(sandbox, file), bytes);
    pinned[floor.name] = `file:../${file}`;
  }
  const passed = [];
  for (const installer of ['npm', 'bun']) {
    const project = join(sandbox, installer);
    mkdirSync(project);
    const dependencies = Object.fromEntries(RELEASES.map((release) => [release.name, pinned[release.name]]));
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({
      name: 'decisions-release-smoke', private: true, version: '0.0.0', dependencies,
      // Every first-party package is these exact bytes: one contracts copy
      // (core's and protocol's ranges both land on the paired tarball) and the
      // integrity-checked floors. Only third-party code resolves, behind the age gate.
      overrides: pinned,
    }, null, 2)}\n`);
    for (const file of ['checks.cjs', 'fixtures.json', 'smoke.mjs', 'smoke.cjs']) copyFileSync(join(smokeSource, file), join(project, file));
    if (installer === 'npm') consumer('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry, `--before=${before}`], project);
    else consumer('bun', ['install', '--ignore-scripts', `--minimum-release-age=${SMOKE_MINIMUM_RELEASE_AGE_SECONDS}`], project);
    for (const runtime of ['node', 'bun']) {
      for (const entry of ['smoke.mjs', 'smoke.cjs']) {
        consumer(runtime, [entry], project);
        passed.push(`${installer}/${runtime}/${entry}`);
      }
    }
  }
  if (JSON.stringify(passed) !== JSON.stringify(EXPECTED_SMOKE_CASES)) throw new Error('Smoke did not run exactly the expected cases');
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'smoke-report.json'), `${JSON.stringify({ sourceSha: process.env.EXPECTED_SOURCE_SHA, packages, pinned, cases: passed, minimumReleaseAgeSeconds: SMOKE_MINIMUM_RELEASE_AGE_SECONDS }, null, 2)}\n`);
}

async function verify() {
  assertSource();
  const own = readPrepared(artifacts);
  assertSameArtifacts(own, readPrepared(trusted));
  const packages = verifiedPackages(artifacts, own);
  const report = { sourceSha: own.sourceSha, dryRun: process.env.DRY_RUN === 'true', packages: await preflight(packages) };
  writeFileSync(join(artifacts, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function publish() {
  if (process.env.DRY_RUN !== 'false') throw new Error('Publication runs only when dry_run is explicitly false');
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('Existing NPM_TOKEN must be available to the release step');
  assertSource();
  const own = readPrepared(artifacts);
  assertSameArtifacts(own, readPrepared(trusted));
  const packages = verifiedPackages(artifacts, own);
  const report = { sourceSha: own.sourceSha, dryRun: false, packages: await preflight(packages) };
  run('npm', ['whoami', '--registry', registry]);
  // Dependency order: core is never published before the contracts it pins.
  for (const [index, release] of RELEASES.entries()) {
    const entry = report.packages[index];
    if (entry.state === 'missing') {
      assertSource();
      run('npm', ['publish', join(artifacts, fileName(release)), '--access', 'public', '--registry', registry, '--ignore-scripts']);
      if (releaseDecision(await published(release), entry.integrity) !== 'already-published') throw new Error('Publication readback absent');
      entry.state = 'published';
    }
    writeFileSync(join(artifacts, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

const PHASES = { prepare, smoke, verify, publish };
async function main() {
  const phase = process.argv[2];
  if (!Object.hasOwn(PHASES, phase) || process.argv.length !== 3) throw new Error('Only fixed prepare/smoke/verify/publish phases are supported');
  await PHASES[phase]();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
