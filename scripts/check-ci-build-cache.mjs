#!/usr/bin/env bun
/**
 * Holds the Turbo build cache to the two properties that make it safe to use in
 * the jobs `main` depends on (see "THE TURBO BUILD CACHE" in ci.yml):
 *
 *   A. A cache hit can skip a COMPILE, never a TEST, and never with an input
 *      left out of the hash.
 *   B. Nothing a pull request or a merge-queue run executes can WRITE the
 *      cache those runs read. The only writer is ci-build-cache.yml, on a push
 *      to main.
 *
 * GitHub's cache scoping already keeps a pull request's writes out of what the
 * queue reads (a run reads its own ref's entries and the default branch's).
 * B does not rely on it: ci.yml has no save path at all, so the scoping is a
 * second, independent wall rather than the only one.
 *
 * WHAT IS CHECKED
 *
 *   turbo.json
 *     - `build` is the only task Turbo may cache: every other task declares
 *       `cache: false`, so no test result can ever be replayed, whoever runs it.
 *     - `build.inputs` starts from `$TURBO_DEFAULT$` (every file in the
 *       package), so no narrowing glob can leave a real input out of the hash.
 *     - `globalDependencies` names bun.lock, the root package.json,
 *       bunfig.toml and tsconfig.json: a dependency bump, an override, an
 *       install setting or a root compiler option changes every hash.
 *     - `envMode` is not `loose`: in strict mode (Turbo's default) a variable
 *       not declared is not visible to the task, so it cannot change an output
 *       the hash does not know about.
 *   ci.yml
 *     - Turbo runs `build` and nothing else, and no step runs the root `test`
 *       script (which is `turbo run test`).
 *     - No step can write a GitHub cache holding Turbo output: no
 *       `actions/cache@` or `actions/cache/save@`, no remote-cache server or
 *       credentials (`TURBO_API`, `TURBO_TOKEN`, `caching-for-turbo`).
 *     - Every job that runs Turbo restores the cache first, under the key
 *       prefix the writer saves with (a mismatch is not unsafe, it is a cache
 *       that silently never hits).
 *   ci-build-cache.yml
 *     - Triggers on `push` to `main` and nothing else.
 *     - `contents: read`, no restore (every entry is one commit's builds, from
 *       empty), exactly one save, of `.turbo/cache`.
 *     - Builds a superset of every workspace ci.yml asks Turbo to build, so the
 *       cache it writes covers what the jobs look for.
 *
 * Paths resolve from the working directory, so scripts/test-check-ci-build-cache.mjs
 * can run this against mutated copies. No install: YAML and JSON through Bun.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CI = join('.github', 'workflows', 'ci.yml');
const WRITER = join('.github', 'workflows', 'ci-build-cache.yml');
const TURBO = 'turbo.json';
const CACHE_PATH = '.turbo/cache';
const GLOBAL_INPUTS = ['bun.lock', 'package.json', 'bunfig.toml', 'tsconfig.json'];

const problems = [];
const fail = (message) => problems.push(message);

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`Cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
}

function parseYaml(path) {
  try {
    return Bun.YAML.parse(read(path));
  } catch (error) {
    console.error(`${path} is not parseable YAML (${error.message}).`);
    process.exit(1);
  }
}

const ci = parseYaml(CI);
const writer = parseYaml(WRITER);
let turbo;
try {
  turbo = JSON.parse(read(TURBO));
} catch (error) {
  console.error(`${TURBO} is not parseable JSON (${error.message}).`);
  process.exit(1);
}

const steps = (job) => (Array.isArray(job?.steps) ? job.steps : []);
const TURBO_RUN = /\bturbo\s+(?:run\s+)?([A-Za-z0-9:_-]+)((?:\s+[^\n&|;]*)?)/g;
const FILTER = /--filter(?:=|\s+)['"]?([^\s'"]+)/g;
const isRestore = (step) => typeof step?.uses === 'string' && step.uses.startsWith('actions/cache/restore@');
const isSave = (step) => typeof step?.uses === 'string' && step.uses.startsWith('actions/cache/save@');
const isCache = (step) => typeof step?.uses === 'string' && /^actions\/cache@/.test(step.uses);

function prefixOf(step) {
  const restoreKeys = step?.with?.['restore-keys'];
  if (typeof restoreKeys === 'string') return restoreKeys.trim().split('\n')[0].trim();
  const key = step?.with?.key;
  return typeof key === 'string' ? key.replace(/\$\{\{\s*github\.sha\s*\}\}$/, '') : null;
}

// ── turbo.json ─────────────────────────────────────────────────────────────
const tasks = turbo?.tasks;
if (!tasks || typeof tasks !== 'object' || !tasks.build) {
  fail(`${TURBO} has no \`tasks.build\`; the cache has nothing it is allowed to hold.`);
} else {
  for (const [name, task] of Object.entries(tasks)) {
    if (name === 'build') continue;
    if (task?.cache !== false) {
      fail(
        `${TURBO} task \`${name}\` is cacheable. Only \`build\` may be: a cached \`${name}\` is a result Turbo ` +
          'replays instead of running, and for a test that is a suite that never executed. Add `"cache": false`.'
      );
    }
  }
  const inputs = tasks.build.inputs;
  if (inputs !== undefined && !(Array.isArray(inputs) && inputs.includes('$TURBO_DEFAULT$'))) {
    fail(
      `${TURBO} narrows \`build.inputs\` without \`$TURBO_DEFAULT$\`. A file outside the globs — a babel ` +
        'config, a root-level build script — would change the output and not the hash, and a hit would restore ' +
        'a stale build.'
    );
  }
  if (!Array.isArray(tasks.build.outputs) || tasks.build.outputs.length === 0) {
    fail(`${TURBO} \`build.outputs\` is empty, so a hit would restore nothing and every job would build against no dist.`);
  }
}
const globals = Array.isArray(turbo?.globalDependencies) ? turbo.globalDependencies : [];
for (const file of GLOBAL_INPUTS) {
  if (!globals.includes(file)) {
    fail(`${TURBO} \`globalDependencies\` does not name ${file}, so changing it would not change any build hash.`);
  }
}
if (turbo?.envMode === 'loose') {
  fail(`${TURBO} sets \`envMode: loose\`: every variable reaches the build while only declared ones reach the hash.`);
}

// ── ci.yml ─────────────────────────────────────────────────────────────────
const ciText = read(CI);
for (const marker of ['TURBO_API', 'TURBO_TOKEN', 'TURBO_REMOTE', 'caching-for-turbo']) {
  if (ciText.includes(marker)) {
    fail(`${CI} mentions ${marker}: a remote cache is a write path from pull-request code into what the queue reads.`);
  }
}

const ciFilters = new Set();
let restorePrefix = null;
let turboJobs = 0;
for (const [id, job] of Object.entries(ci?.jobs ?? {})) {
  let restored = false;
  for (const step of steps(job)) {
    if (isCache(step) || isSave(step)) {
      fail(`${CI} job \`${id}\` uses ${step.uses}, which SAVES a cache. ${CI} may only restore (actions/cache/restore).`);
    }
    if (isRestore(step) && String(step?.with?.path ?? '').includes('.turbo')) {
      restored = true;
      const prefix = prefixOf(step);
      if (restorePrefix === null) restorePrefix = prefix;
      else if (prefix !== restorePrefix) fail(`${CI} job \`${id}\` restores the Turbo cache under ${prefix}, others under ${restorePrefix}.`);
    }
    const run = typeof step?.run === 'string' ? step.run : '';
    if (!step?.['working-directory'] && /\bbun\s+run\s+test\b(?!:)/.test(run)) {
      fail(`${CI} job \`${id}\` runs the ROOT \`test\` script, which is \`turbo run test\`; run each package's own \`bun run test\` in its directory.`);
    }
    let usesTurbo = false;
    for (const match of run.matchAll(TURBO_RUN)) {
      usesTurbo = true;
      if (match[1] !== 'build') {
        fail(`${CI} job \`${id}\` runs \`turbo ${match[1]}\`. Turbo runs \`build\` here and nothing else, so no cached result can stand in for a check.`);
      }
      for (const filter of (match[2] ?? '').matchAll(FILTER)) ciFilters.add(filter[1].replace(/^\.\.\./, '').replace(/\.\.\.$/, ''));
    }
    if (usesTurbo) {
      turboJobs += 1;
      if (!restored) fail(`${CI} job \`${id}\` runs Turbo before restoring the Turbo build cache, so it always builds from scratch.`);
    }
  }
}
if (turboJobs === 0) fail(`${CI} runs Turbo nowhere; this check would be vacuous.`);

// ── ci-build-cache.yml ─────────────────────────────────────────────────────
const triggers = writer?.on ?? writer?.[true];
const triggerNames = triggers && typeof triggers === 'object' ? Object.keys(triggers) : [String(triggers)];
const pushBranches = triggers?.push?.branches;
if (
  triggerNames.length !== 1 ||
  triggerNames[0] !== 'push' ||
  !Array.isArray(pushBranches) ||
  pushBranches.length !== 1 ||
  pushBranches[0] !== 'main'
) {
  fail(
    `${WRITER} must trigger on \`push\` to \`main\` and nothing else (found ${JSON.stringify(triggers)}). Any other ` +
      'trigger runs code that has not passed the merge queue with the power to write the cache.'
  );
}
const permissions = writer?.permissions;
if (!permissions || typeof permissions !== 'object' || Object.keys(permissions).length !== 1 || permissions.contents !== 'read') {
  fail(`${WRITER} must declare exactly \`permissions: contents: read\` (found ${JSON.stringify(permissions ?? null)}).`);
}
const writerSteps = Object.values(writer?.jobs ?? {}).flatMap(steps);
const saves = writerSteps.filter((step) => isSave(step) || isCache(step));
if (writerSteps.some(isRestore) || writerSteps.some(isCache)) {
  fail(`${WRITER} restores a cache before building, so an entry could carry artifacts this commit did not produce. Build from empty.`);
}
if (saves.length !== 1 || !isSave(saves[0]) || String(saves[0]?.with?.path ?? '').trim() !== CACHE_PATH) {
  fail(`${WRITER} must save exactly one cache, \`${CACHE_PATH}\`, with actions/cache/save.`);
} else if (restorePrefix !== null && !String(saves[0].with.key ?? '').startsWith(restorePrefix)) {
  fail(`${WRITER} saves under ${saves[0].with.key}, which ${CI}'s restore prefix ${restorePrefix} never matches.`);
}

// The writer's build set, closed over workspace dependencies, must cover every
// workspace ci.yml asks Turbo to build.
const writerFilters = [];
for (const step of writerSteps) {
  const run = typeof step?.run === 'string' ? step.run : '';
  for (const match of run.matchAll(TURBO_RUN)) {
    if (match[1] !== 'build') fail(`${WRITER} runs \`turbo ${match[1]}\`; it exists to build.`);
    for (const filter of (match[2] ?? '').matchAll(FILTER)) writerFilters.push(filter[1].replace(/^\.\.\./, '').replace(/\.\.\.$/, ''));
  }
}
const root = JSON.parse(read('package.json'));
const workspaceDirs = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages ?? [];
const manifests = new Map();
for (const dir of workspaceDirs) {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(read(path));
  if (manifest?.name) manifests.set(manifest.name, manifest);
}
const covered = new Set();
const queue = [...writerFilters];
while (queue.length > 0) {
  const name = queue.shift();
  if (covered.has(name) || !manifests.has(name)) continue;
  covered.add(name);
  const manifest = manifests.get(name);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {})) if (manifests.has(dependency)) queue.push(dependency);
  }
}
if (writerFilters.length === 0) fail(`${WRITER} builds nothing through Turbo, so it writes an empty cache.`);
for (const name of [...ciFilters].sort()) {
  if (!covered.has(name)) {
    fail(`${CI} asks Turbo to build ${name}, which ${WRITER} does not build: every job would miss it.`);
  }
}

if (problems.length > 0) {
  console.error('The Turbo build cache is NOT safe or NOT wired:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `Turbo build cache: only \`build\` is cacheable, ${GLOBAL_INPUTS.length} global inputs hashed, ${turboJobs} ci.yml ` +
    `step(s) run Turbo after a read-only restore, and ${WRITER} (push to main only) builds all ${ciFilters.size} of their targets.`
);
