import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASES = Object.freeze([
  { directory: 'contracts', name: '@oxy.so/contracts', version: '1.1.0' },
  { directory: 'federation', name: '@oxy.so/federation', version: '1.0.1' },
]);
const registry = 'https://registry.npmjs.org';
const root = process.cwd();
const artifacts = join(root, 'release-artifacts');
function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}
export function validateSource(expected, actual, reference, dryRun, protectedRef) {
  if (!/^[a-f0-9]{40}$/.test(expected ?? '') || expected !== actual || reference !== 'refs/heads/main' || protectedRef !== 'true') {
    throw new Error('Release requires the exact protected main source SHA');
  }
  if (!['true', 'false'].includes(dryRun)) throw new Error('dry_run must be an explicit boolean');
}
function assertSource() {
  validateSource(process.env.EXPECTED_SOURCE_SHA, run('git', ['rev-parse', 'HEAD']), process.env.GITHUB_REF, process.env.DRY_RUN, process.env.GITHUB_REF_PROTECTED);
  const currentMain = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (currentMain !== process.env.EXPECTED_SOURCE_SHA) throw new Error('Protected main advanced; review and dispatch the current source SHA');
  if (run('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Tracked release source has changed');
}
export function integrity(bytes) { return `sha512-${createHash('sha512').update(bytes).digest('base64')}`; }
export function releaseDecision(publishedIntegrity, builtIntegrity) {
  if (publishedIntegrity === null) return 'missing';
  if (publishedIntegrity !== builtIntegrity) throw new Error('Published immutable version differs from the reviewed artifact; refusing overwrite');
  return 'already-published';
}
function target(release) { return join(artifacts, `oxy.so-${release.directory}-${release.version}.tgz`); }
function exportsTargets(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportsTargets);
}
export function validateArtifactManifest(release, manifest, entries) {
  if (manifest.name !== release.name || manifest.version !== release.version) throw new Error('Packed release manifest mismatch');
  if (/(?:workspace|catalog):/.test(JSON.stringify(manifest))) throw new Error('Unresolved workspace/catalog reference in artifact');
  const required = [manifest.main, manifest.module, manifest.types, ...exportsTargets(manifest.exports)].filter(Boolean);
  for (const path of required) {
    if (path.includes('*') || !entries.includes(`package/${path.replace(/^\.\//, '')}`)) throw new Error(`Missing concrete export ${path}`);
  }
  if (!entries.some(entry => entry.endsWith('.d.ts')) || !entries.some(entry => entry.startsWith('package/dist/esm/'))) throw new Error('Incomplete package build');
}
function inspect(release) {
  const tarball = target(release);
  const entries = run('tar', ['-tzf', tarball]).split('\n');
  if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..'))) throw new Error('Unsafe archive path');
  const manifest = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']));
  validateArtifactManifest(release, manifest, entries);
  return { name: release.name, version: release.version, file: tarball.split('/').pop(), integrity: integrity(readFileSync(tarball)) };
}
async function published(release) {
  const response = await fetch(`${registry}/${encodeURIComponent(release.name)}/${release.version}`, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry lookup failed (${response.status})`);
  const document = await response.json();
  if (typeof document.dist?.integrity !== 'string') throw new Error('Registry omitted immutable integrity');
  return document.dist.integrity;
}
async function main() {
  const phase = process.argv[2];
  if (!['prepare', 'publish'].includes(phase) || process.argv.length !== 3) throw new Error('Only fixed prepare/publish phases are supported');
  assertSource();
  mkdirSync(artifacts, { recursive: true });
  if (phase === 'prepare') {
    const built = [];
    for (const release of RELEASES) {
      const directory = join(root, 'packages', release.directory);
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name !== release.name || manifest.version !== release.version) throw new Error('Source version differs from fixed release');
      rmSync(target(release), { force: true });
      // Both are one command; the inspected tarball can only come from this build.
      run('bash', ['-euo', 'pipefail', '-c', 'bun run clean && bun run build && bun pm pack --destination ../../release-artifacts'], directory);
      run('bun', ['run', 'test', '--runInBand'], directory);
      built.push(inspect(release));
    }
    writeFileSync(join(artifacts, 'prepared.json'), `${JSON.stringify({ sourceSha: process.env.EXPECTED_SOURCE_SHA, packages: built }, null, 2)}\n`);
    return;
  }
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('Existing NPM_TOKEN must be available to the release step');
  run('npm', ['whoami', '--registry', registry]);
  const prepared = JSON.parse(readFileSync(join(artifacts, 'prepared.json'), 'utf8'));
  if (prepared.sourceSha !== process.env.EXPECTED_SOURCE_SHA) throw new Error('Artifact preparation belongs to another commit');
  const report = { sourceSha: prepared.sourceSha, dryRun: process.env.DRY_RUN === 'true', packages: [] };
  // Preflight BOTH immutable versions before any publication.
  for (const release of RELEASES) {
    const artifact = inspect(release);
    if (!prepared.packages.some(entry => entry.name === artifact.name && entry.integrity === artifact.integrity)) throw new Error('Prepared artifact changed');
    report.packages.push({ ...artifact, state: releaseDecision(await published(release), artifact.integrity) });
  }
  writeFileSync(join(artifacts, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
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
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
