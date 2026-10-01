// Release the reviewed decisions pair: @oxy.so/contracts then @oxy.so/core.
//
// Same guarantees as release-external-identity-packages.mjs, whose pure guards
// are reused unchanged: exact protected main SHA, build+pack in one command,
// immutable integrity (identical bytes are idempotent, different bytes refuse),
// dry run by default in the workflow, existing NPM_TOKEN only. Added here:
// core must pin exactly this contracts release, every other @oxy.so dependency
// floor must already be published, and both tarballs are installed with npm
// and bun and exercised from Node and Bun before anything can be published.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  { directory: 'core', name: '@oxy.so/core', version: '4.1.0' },
]);
const registry = 'https://registry.npmjs.org';
const root = resolve(process.cwd());
const artifacts = join(root, 'release-artifacts');
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
const target = (release) => join(artifacts, fileName(release));

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
  return checked;
}

function inspect(release) {
  const tarball = target(release);
  const entries = run('tar', ['-tzf', tarball]).split('\n');
  if (entries.some((entry) => !entry.startsWith('package/') || entry.split('/').includes('..'))) throw new Error('Unsafe archive path');
  if (entries.some((entry) => entry.includes('/__tests__/'))) throw new Error('Tests leaked into the artifact');
  const manifest = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']));
  validateArtifactManifest(release, manifest, entries);
  return { manifest, artifact: { name: release.name, version: release.version, file: fileName(release), integrity: integrity(readFileSync(tarball)) } };
}
async function registryDocument(name, version) {
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

/** Install both tarballs as a consumer would and exercise them from Node and Bun. */
function smoke() {
  const results = [];
  for (const installer of ['npm', 'bun']) {
    const project = join(artifacts, `smoke-${installer}`);
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    const dependencies = Object.fromEntries(RELEASES.map((release) => [release.name, `file:../${fileName(release)}`]));
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({
      name: 'decisions-release-smoke', private: true, version: '0.0.0', dependencies,
      // One contracts copy: core's ^4.7.0 must resolve to the paired tarball.
      overrides: { [RELEASES[0].name]: dependencies[RELEASES[0].name] },
    }, null, 2)}\n`);
    for (const file of ['checks.cjs', 'fixtures.json', 'smoke.mjs', 'smoke.cjs']) copyFileSync(join(smokeSource, file), join(project, file));
    if (installer === 'npm') run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry], project);
    else run('bun', ['install', '--ignore-scripts', '--minimum-release-age=0'], project);
    for (const runtime of ['node', 'bun']) {
      for (const entry of ['smoke.mjs', 'smoke.cjs']) {
        run(runtime, [entry], project);
        results.push(`${installer}/${runtime}/${entry}`);
      }
    }
  }
  return results;
}

async function main() {
  const phase = process.argv[2];
  if (!['prepare', 'publish'].includes(phase) || process.argv.length !== 3) throw new Error('Only fixed prepare/publish phases are supported');
  assertSource();
  mkdirSync(artifacts, { recursive: true });
  if (phase === 'prepare') {
    const built = [];
    const dependencyFloors = [];
    for (const release of RELEASES) {
      const directory = join(root, 'packages', release.directory);
      const source = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (source.name !== release.name || source.version !== release.version) throw new Error('Source version differs from fixed release');
      if (await published(release) !== null) {
        // Allowed only as an identical retry; publish re-checks the bytes.
        console.log(`${release.name}@${release.version} already exists; publish will require identical bytes`);
      }
      rmSync(target(release), { force: true });
      // One command; the inspected tarball can only come from this build.
      run('bash', ['-euo', 'pipefail', '-c', 'bun run clean && bun run build && bun pm pack --destination ../../release-artifacts'], directory);
      run('bun', ['run', 'test'], directory);
      if (source.scripts?.['test:package']) run('bun', ['run', 'test:package'], directory);
      const { manifest, artifact } = inspect(release);
      const floors = [];
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        const floor = /^\^(\d+\.\d+\.\d+)$/.exec(range)?.[1];
        if (name.startsWith('@oxy.so/') && name !== RELEASES[0].name && floor !== undefined) {
          floors.push([`${name}@${floor}`, (await registryDocument(name, floor)) !== null]);
        }
      }
      const known = new Map(floors);
      dependencyFloors.push(...validateFirstPartyDependencies(manifest, (name, floor) => known.get(`${name}@${floor}`) === true));
      built.push(artifact);
    }
    const smoked = smoke();
    writeFileSync(join(artifacts, 'prepared.json'), `${JSON.stringify({ sourceSha: process.env.EXPECTED_SOURCE_SHA, packages: built, dependencyFloors, smoked }, null, 2)}\n`);
    return;
  }
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('Existing NPM_TOKEN must be available to the release step');
  run('npm', ['whoami', '--registry', registry]);
  const prepared = JSON.parse(readFileSync(join(artifacts, 'prepared.json'), 'utf8'));
  if (prepared.sourceSha !== process.env.EXPECTED_SOURCE_SHA) throw new Error('Artifact preparation belongs to another commit');
  if (!Array.isArray(prepared.smoked) || prepared.smoked.length !== 8) throw new Error('Artifacts were not smoke-installed');
  const report = { sourceSha: prepared.sourceSha, dryRun: process.env.DRY_RUN === 'true', packages: [] };
  // Preflight BOTH immutable versions before any publication.
  for (const release of RELEASES) {
    const { artifact } = inspect(release);
    if (!prepared.packages.some((entry) => entry.name === artifact.name && entry.integrity === artifact.integrity)) throw new Error('Prepared artifact changed');
    report.packages.push({ ...artifact, state: releaseDecision(await published(release), artifact.integrity) });
  }
  writeFileSync(join(artifacts, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  // Dependency order: core is never published before the contracts it pins.
  for (const [index, release] of RELEASES.entries()) {
    const entry = report.packages[index];
    if (entry.state === 'missing' && !report.dryRun) {
      assertSource();
      run('npm', ['publish', target(release), '--access', 'public', '--registry', registry, '--ignore-scripts']);
      if (releaseDecision(await published(release), entry.integrity) !== 'already-published') throw new Error('Publication readback absent');
      entry.state = 'published';
      writeFileSync(join(artifacts, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
