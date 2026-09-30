#!/usr/bin/env bun
/**
 * Decides which of CI's SCOPED jobs a PULL REQUEST run must run. It is never
 * consulted on `merge_group` or `push`: those runs always run the complete
 * suite, and the `CI complete` gate refuses to pass there if any job was
 * skipped (scripts/check-ci-complete.mjs). This script only decides how much
 * feedback a pull request gets BEFORE it enters the queue; nothing reaches main
 * without the full suite passing on the exact merged tree.
 *
 * THE SUITES
 *
 *   api        `api-test` (the sharded Jest matrix; `api-coverage` merges it)
 *              and `api-build`
 *   platform   `packages-platform`
 *   apps       `packages-apps`
 *
 * `guards` is not scoped: its checks are repository-wide.
 *
 * A suite's ROOTS are not listed here. They are read from the workflow itself
 * (`.github/workflows/ci.yml` at the head of the diff): every
 * `working-directory:` and every `--filter <workspace>` in a suite job's steps.
 * A step added for another package widens its suite's scope the day it lands,
 * with nothing here to forget. A suite's CLOSURE is its roots plus every
 * workspace they reach through any dependency field, read from the manifests at
 * both sides of the diff (so adding or removing a workspace dependency counts).
 *
 * WHY
 *
 * The API suite is the critical path of every run (six shards, ~4 minutes each
 * with containers, measured 2026-09-30) and it ran twice per pull request: once
 * on the PR, which auto-merge waits for, then again in the queue. Of the last 15
 * pull requests merged to main before it was scoped, 9 touched nothing in
 * packages/api or anything it imports. The same holds one level down: a change
 * to Console never reaches the platform packages' suites, a change to the
 * stickers SDK never reaches the apps'. Each skipped job is also one runner of
 * the org's 20 left for someone else.
 *
 * THE RULE: FAIL TOWARD RUNNING
 *
 * A suite's answer is `false` (skip) only when EVERY changed path is positively
 * known not to reach it. Anything this script does not recognise, cannot read
 * or cannot parse is `true` for every suite. Concretely, a changed path is
 * irrelevant to a suite only if it is:
 *
 *   - inside a workspace package directory that is NOT in that suite's closure;
 *   - documentation outside every package: `docs/**`, `wiki/**`, or a
 *     root-level `*.md`;
 *   - `bun.lock`, when the resolved dependency graph reachable from the suite's
 *     closure is byte-identical on both sides (below).
 *
 * Everything else runs the suite: every package in its closure, every root file
 * (package.json, tsconfig.json, bunfig.toml, turbo.json, Dockerfile, ...),
 * `.github/**`, `scripts/**`, `workers/**`, `examples/**`, and any path this
 * list has never heard of.
 *
 * BUN.LOCK
 *
 * `bun.lock` changes on nearly every pull request (a Bloom bump rewrites it), so
 * "the lockfile moved, run everything" would save nothing. The question that
 * matters is narrower: did anything the suite can LOAD resolve differently? This
 * answers it by walking the lockfile the way Node resolves `node_modules`:
 *
 *   roots   every dependency (all four kinds, dev included — the suites build
 *           and run with them) declared by each workspace in the closure, on
 *           either side of the diff, PLUS every bare module specifier found in
 *           their tracked source. The second set is what catches a phantom
 *           dependency: an import that resolves only because something else
 *           hoisted it to the root `node_modules`, and that a manifest-only walk
 *           would never visit.
 *   walk    a package installed at key `a/b` looks for dependency `d` at `a/b/d`,
 *           then `a/d`, then `d` — exactly the nested `node_modules` lookup, and
 *           exactly how bun.lock keys its `packages` map. Dependencies,
 *           optional dependencies and peer dependencies are all followed.
 *           Workspace packages continue into that workspace's own manifest.
 *   compare the set of `key = entry` pairs visited (entry includes the exact
 *           version, the integrity hash, bins and platform constraints), plus
 *           every lookup that found nothing, plus the lockfile's global
 *           sections that change what an install does to ANY package
 *           (`lockfileVersion`, `configVersion`, `overrides`,
 *           `patchedDependencies`, `trustedDependencies`). Any difference, in
 *           either direction, runs the suite.
 *
 * WHAT IT DOES NOT SEE, AND WHY THAT IS ACCEPTABLE
 *
 * A test that reads a file outside the closure at runtime (fs.readFile of
 * another package's source) is invisible to a dependency walk.
 * scripts/test-ci-scope.mjs carries a census of every `packages/<x>`,
 * `<rootDir>/../<x>` and `../<x>/` reference in each suite's roots and fails if
 * one names a package outside that suite's closure, so such a reference cannot
 * be added without this script being taught about it. And the merge queue runs
 * everything regardless.
 *
 * Usage:
 *   bun scripts/ci-scope.mjs                  # PR merge commit: base = HEAD^1
 *   bun scripts/ci-scope.mjs --base <rev> [--head <rev>]
 *
 * Writes `<suite>=true|false` for every suite to $GITHUB_OUTPUT when set, and
 * always prints the decisions and the path(s) that drove them. Exits 0 on every
 * decision, including "could not decide" (which is `true` for every suite), so
 * a bug here costs a slower pull request, never a skipped suite. No install
 * needed: node builtins, git and Bun's own JSONC and YAML parsers.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const LOCKFILE = 'bun.lock';
export const WORKFLOW_PATH = '.github/workflows/ci.yml';

/**
 * Suite -> the ci.yml jobs it gates. `check-ci-complete.mjs` reads this same
 * map to decide which skips a pull request may excuse and on which output, and
 * refuses a workflow whose job `if:` does not consult it.
 */
export const SUITE_JOBS = {
  api: ['api-test', 'api-build'],
  platform: ['packages-platform'],
  apps: ['packages-apps'],
};
export const SUITES = Object.keys(SUITE_JOBS);

/**
 * Test files that read the WHOLE repository rather than their own package's
 * dependency closure: a census that walks every source file from the repo root.
 * No closure can contain "everything", so instead each one also runs in
 * `guards`, which is never scoped, and the census in scripts/test-ci-scope.mjs
 * exempts its references only while the `guards` job still names it. Skipping
 * the suite that owns one therefore never skips the census itself.
 */
export const REPO_WIDE_TESTS = ['packages/contracts/src/__tests__/usernamePolicySingleSource.test.ts'];

/**
 * Files a workspace's tests read from OUTSIDE its dependency closure, as path
 * prefixes: workspace dir -> prefixes. A change under one runs every suite
 * whose closure contains that workspace. The census in scripts/test-ci-scope.mjs
 * finds such reads and fails until they are declared here.
 */
export const EXTRA_INPUTS = {
  // The identity-derivation test checks core against the vectors the Commons
  // native host is built from.
  'packages/core': ['packages/commons/modules/oxy-identity-host/vectors.json'],
};

/** Documentation that nothing in the suite reads. Everything else outside a workspace runs. */
export function isInertDocumentation(path) {
  if (path.startsWith('docs/') || path.startsWith('wiki/')) return true;
  return !path.includes('/') && path.toLowerCase().endsWith('.md');
}

// ── git ────────────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** File contents at a revision, or null when the path does not exist there. */
function show(cwd, rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function changedPaths(cwd, base, head) {
  // `--no-renames`: a file moved OUT of packages/api must still name its old
  // path, and rename detection would report only the new one.
  return git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
}

// ── Workspaces ─────────────────────────────────────────────────────────────

function readJson(cwd, rev, path) {
  const text = show(cwd, rev, path);
  if (text === null) return null;
  return JSON.parse(text);
}

/** name -> directory, for every workspace the root manifest declares at `rev`. */
export function workspaceDirectories(cwd, rev) {
  const root = readJson(cwd, rev, 'package.json');
  if (!root) throw new Error(`no root package.json at ${rev}`);
  const declared = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`root package.json at ${rev} declares no workspaces`);
  }
  const byName = new Map();
  for (const dir of declared) {
    if (dir.includes('*')) {
      // A glob would need expansion this script does not do. Refuse rather than
      // silently treat every package under it as outside the closure.
      throw new Error(`workspace entry ${JSON.stringify(dir)} is a glob; teach ci-api-scope.mjs to expand it`);
    }
    const manifest = readJson(cwd, rev, `${dir}/package.json`);
    if (manifest?.name) byName.set(manifest.name, { dir, manifest });
  }
  return byName;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function declaredDependencies(manifest) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest?.[field] ?? {})) names.add(name);
  }
  return names;
}

/** packages/api plus every workspace it reaches through any dependency field. */

/** The given workspace dirs plus every workspace they reach through any dependency field. */
export function closureOf(workspaces, rootDirs) {
  const byDir = new Map([...workspaces.values()].map((w) => [w.dir, w]));
  const closure = new Map();
  const queue = [];
  for (const dir of rootDirs) {
    const workspace = byDir.get(dir);
    if (!workspace) throw new Error(`${dir} is not a declared workspace`);
    if (!closure.has(workspace.manifest.name)) {
      closure.set(workspace.manifest.name, workspace);
      queue.push(workspace);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    for (const name of declaredDependencies(current.manifest)) {
      const workspace = workspaces.get(name);
      if (workspace && !closure.has(name)) {
        closure.set(name, workspace);
        queue.push(workspace);
      }
    }
  }
  return closure;
}

// ── Suite roots, read from the workflow ────────────────────────────────────

const FILTER = /--filter(?:=|\s+)['"]?([^\s'"]+)/g;

/**
 * suite -> sorted workspace dirs its jobs' steps work in or name with
 * `--filter`. Throws on anything it cannot map — a filter naming no workspace, a
 * working directory outside `packages/<x>`, a suite job missing or with no
 * roots — so the CLI falls back to running everything.
 */
export function suiteRoots(workflowText, workspaces) {
  const workflow = Bun.YAML.parse(workflowText);
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== 'object') throw new Error(`${WORKFLOW_PATH} has no jobs mapping`);
  const dirByName = new Map([...workspaces.values()].map((w) => [w.manifest.name, w.dir]));
  const dirs = new Set([...workspaces.values()].map((w) => w.dir));
  const roots = {};
  for (const [suite, jobIds] of Object.entries(SUITE_JOBS)) {
    const found = new Set();
    for (const id of jobIds) {
      const job = jobs[id];
      if (!job || !Array.isArray(job.steps)) throw new Error(`${WORKFLOW_PATH} has no job \`${id}\` with steps (suite ${suite})`);
      for (const step of job.steps) {
        const workingDirectory = step?.['working-directory'];
        if (typeof workingDirectory === 'string') {
          const dir = workingDirectory.replace(/^\.\//, '').replace(/\/$/, '');
          if (!dirs.has(dir)) throw new Error(`job \`${id}\` works in ${workingDirectory}, which is not a workspace`);
          found.add(dir);
        }
        const run = typeof step?.run === 'string' ? step.run : '';
        for (const match of run.matchAll(FILTER)) {
          const name = match[1].replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
          const dir = dirByName.get(name);
          if (!dir) throw new Error(`job \`${id}\` filters on ${JSON.stringify(match[1])}, which names no workspace`);
          found.add(dir);
        }
      }
    }
    if (found.size === 0) throw new Error(`suite ${suite} found no roots in ${jobIds.join(', ')}`);
    roots[suite] = [...found].sort();
  }
  return roots;
}

// ── Bare module specifiers in tracked source ───────────────────────────────

// `git grep` at the revision, not a per-file `git show`: packages/api alone is
// thousands of files, and one process over the object store is ~100x faster.
const SPECIFIER_PATTERN = String.raw`(from|import|require\(|import\(|jest\.(mock|requireActual|doMock)\()[[:space:]]*['"][^'"]+['"]`;
const SPECIFIER = /(['"])([^'"]+)\1\s*$/;
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts'];

/** The package name a bare specifier resolves through, or null for relative/builtin/absolute. */
export function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  if (specifier.startsWith('bun:') || specifier.includes('<rootDir>') || /\s/.test(specifier)) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

export function importedPackages(cwd, rev, dirs) {
  const pathspecs = dirs.flatMap((dir) => SOURCE_GLOBS.map((glob) => `:(glob)${dir}/**/${glob}`));
  let output = '';
  try {
    output = git(cwd, ['grep', '-h', '-I', '-o', '-E', SPECIFIER_PATTERN, rev, '--', ...pathspecs]);
  } catch (error) {
    // `git grep` exits 1 when nothing matches, which is a real (if unlikely) answer.
    if (error.status !== 1) throw error;
  }
  const names = new Set();
  for (const line of output.split('\n')) {
    const match = line.match(SPECIFIER);
    const name = match ? packageNameOf(match[2]) : null;
    if (name) names.add(name);
  }
  return names;
}

// ── The lockfile walk ──────────────────────────────────────────────────────

/** `@babel/core/semver` -> ['@babel/core', 'semver']: a key is a nested node_modules path. */
export function keySegments(key) {
  const tokens = key.split('/');
  const segments = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].startsWith('@') && index + 1 < tokens.length) {
      segments.push(`${tokens[index]}/${tokens[index + 1]}`);
      index += 1;
    } else {
      segments.push(tokens[index]);
    }
  }
  return segments;
}

/** Node's lookup: the dependent's own node_modules, then each ancestor's, then the root. */
function resolveKey(packages, fromSegments, name) {
  for (let depth = fromSegments.length; depth >= 0; depth -= 1) {
    const key = [...fromSegments.slice(0, depth), name].join('/');
    if (Object.hasOwn(packages, key)) return key;
  }
  return null;
}

export function parseLockfile(text) {
  if (typeof Bun?.JSONC?.parse !== 'function') throw new Error('this Bun has no JSONC parser');
  const lock = Bun.JSONC.parse(text);
  if (!lock || typeof lock !== 'object' || typeof lock.packages !== 'object' || typeof lock.workspaces !== 'object') {
    throw new Error('bun.lock has no `packages` or `workspaces` map');
  }
  return lock;
}

/**
 * Every lockfile fact a suite's closure can observe, as a sorted list of
 * strings. Two lockfiles give it the same installed graph iff these lists are equal.
 */
export function lockFootprint(lock, closureDirs, rootNames) {
  const { packages, workspaces } = lock;
  const footprint = new Set();
  for (const section of ['lockfileVersion', 'configVersion', 'overrides', 'patchedDependencies', 'trustedDependencies']) {
    footprint.add(`#${section} ${JSON.stringify(lock[section] ?? null)}`);
  }

  const visited = new Set();
  const queue = [];

  function visit(fromKey, fromSegments, name) {
    const key = resolveKey(packages, fromSegments, name);
    if (key === null) {
      // Recorded, not ignored: a lookup that starts or stops finding something
      // is a change like any other.
      footprint.add(`!unresolved ${fromKey} -> ${name}`);
      return;
    }
    if (visited.has(key)) return;
    visited.add(key);
    queue.push(key);
  }

  // Roots, resolved from each closure workspace's own position. The lockfile
  // keys a workspace's nested dependencies under its package NAME.
  for (const dir of closureDirs) {
    const workspace = workspaces[dir];
    if (!workspace) {
      footprint.add(`!workspace-missing ${dir}`);
      continue;
    }
    footprint.add(`@workspace ${dir} ${JSON.stringify(workspace)}`);
    const segments = [workspace.name ?? dir];
    const names = new Set(rootNames);
    for (const field of DEPENDENCY_FIELDS) for (const name of Object.keys(workspace[field] ?? {})) names.add(name);
    for (const name of [...names].sort()) visit(dir, segments, name);
  }

  while (queue.length > 0) {
    const key = queue.shift();
    const entry = packages[key];
    footprint.add(`${key} = ${JSON.stringify(entry)}`);
    const segments = keySegments(key);
    const ident = Array.isArray(entry) ? entry[0] : undefined;
    const workspaceMatch = typeof ident === 'string' ? ident.match(/@workspace:(.+)$/) : null;
    let dependencies;
    if (workspaceMatch) {
      const workspace = workspaces[workspaceMatch[1]];
      footprint.add(`@workspace ${workspaceMatch[1]} ${JSON.stringify(workspace ?? null)}`);
      dependencies = workspace ?? {};
    } else {
      dependencies = Array.isArray(entry) ? entry.find((part) => part && typeof part === 'object' && !Array.isArray(part)) ?? {} : {};
    }
    const names = new Set();
    for (const field of DEPENDENCY_FIELDS) for (const name of Object.keys(dependencies[field] ?? {})) names.add(name);
    for (const name of [...names].sort()) visit(key, segments, name);
  }

  return [...footprint].sort();
}

// ── The root manifest ──────────────────────────────────────────────────────

/**
 * The root package.json keys whose ONLY effect on a suite is through what the
 * lockfile resolves. A Bloom bump edits `workspaces.catalog` and the root
 * dependency maps on nearly every pull request; what that does to a suite is
 * exactly what the lockfile walk measures, so those keys defer to it. Every
 * other root key — `workspaces.packages`, `overrides`, `trustedDependencies`,
 * `packageManager` (the Bun every job installs with), `scripts`, `engines`,
 * anything added later — runs the suite when it changes.
 */
const ROOT_KEYS_DEFERRED_TO_LOCKFILE = ['dependencies', 'devDependencies', 'optionalDependencies'];
const ROOT_WORKSPACE_KEYS_DEFERRED_TO_LOCKFILE = ['catalog', 'catalogs'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** True when the root manifests differ ONLY in keys whose effect the lockfile walk measures. */
export function rootManifestChangeIsResolutionOnly(baseText, headText) {
  if (baseText === null || headText === null) return false;
  const strip = (text) => {
    const manifest = JSON.parse(text);
    for (const key of ROOT_KEYS_DEFERRED_TO_LOCKFILE) delete manifest[key];
    for (const key of ['catalog', 'catalogs']) delete manifest[key];
    if (manifest.workspaces && typeof manifest.workspaces === 'object' && !Array.isArray(manifest.workspaces)) {
      for (const key of ROOT_WORKSPACE_KEYS_DEFERRED_TO_LOCKFILE) delete manifest.workspaces[key];
    }
    return JSON.stringify(canonical(manifest));
  };
  return strip(baseText) === strip(headText);
}

// ── The decision ───────────────────────────────────────────────────────────

function lockfileVerdict(cwd, base, head, closure) {
  const roots = new Set([...importedPackages(cwd, base, closure), ...importedPackages(cwd, head, closure)]);
  const baseText = show(cwd, base, LOCKFILE);
  const headText = show(cwd, head, LOCKFILE);
  if (baseText === null || headText === null) return { reason: `${LOCKFILE} is missing on one side of the diff` };
  const before = lockFootprint(parseLockfile(baseText), closure, roots);
  const after = lockFootprint(parseLockfile(headText), closure, roots);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const removed = before.filter((line) => !afterSet.has(line));
  const added = after.filter((line) => !beforeSet.has(line));
  if (removed.length > 0 || added.length > 0) {
    const sample = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].slice(0, 12);
    return {
      reason:
        `${LOCKFILE} changes what this suite resolves (${removed.length} removed, ${added.length} added of ` +
        `${after.length} reachable entries):\n      ${sample.map((l) => l.slice(0, 200)).join('\n      ')}`,
    };
  }
  return { ignored: `${LOCKFILE} (all ${after.length} entries reachable from this suite are identical)` };
}

/**
 * @returns {{ [suite: string]: { run: boolean, reasons: string[], ignored: string[], roots: string[], closure: string[] } }}
 * Throws on git/argument/workflow failures; the CLI turns a throw into "run everything".
 */
export function decide({ cwd, base, head }) {
  const baseWorkspaces = workspaceDirectories(cwd, base);
  const headWorkspaces = workspaceDirectories(cwd, head);
  const workflowText = show(cwd, head, WORKFLOW_PATH);
  if (workflowText === null) throw new Error(`no ${WORKFLOW_PATH} at ${head}`);
  const roots = suiteRoots(workflowText, headWorkspaces);
  const workspaceDirs = new Set([
    ...[...baseWorkspaces.values()].map((w) => w.dir),
    ...[...headWorkspaces.values()].map((w) => w.dir),
  ]);
  const changed = changedPaths(cwd, base, head);
  const rootManifestResolutionOnly = changed.includes('package.json')
    ? rootManifestChangeIsResolutionOnly(show(cwd, base, 'package.json'), show(cwd, head, 'package.json'))
    : null;

  const verdicts = {};
  for (const suite of SUITES) {
    // Roots that exist on the base side too: a root the PR removes still names
    // the code the suite used to cover.
    const baseRoots = roots[suite].filter((dir) => [...baseWorkspaces.values()].some((w) => w.dir === dir));
    const closureDirs = new Set([
      ...[...closureOf(baseWorkspaces, baseRoots).values()].map((w) => w.dir),
      ...[...closureOf(headWorkspaces, roots[suite]).values()].map((w) => w.dir),
    ]);
    const closure = [...closureDirs].sort();
    const extraInputs = closure.flatMap((dir) => (EXTRA_INPUTS[dir] ?? []).map((prefix) => ({ dir, prefix })));
    const reasons = [];
    const ignored = [];
    let lockfileChanged = false;

    for (const path of changed) {
      if (path === LOCKFILE) {
        lockfileChanged = true;
        continue;
      }
      if (path === 'package.json') {
        if (rootManifestResolutionOnly) {
          // Deferred, not ignored: the lockfile walk below decides, whether or
          // not bun.lock itself moved.
          lockfileChanged = true;
          ignored.push('package.json (only the catalog / root dependency maps changed; decided by the lockfile walk)');
        } else {
          reasons.push('package.json changed outside the catalog and root dependency maps');
        }
        continue;
      }
      const extra = extraInputs.find(({ prefix }) => path.startsWith(prefix));
      if (extra) {
        reasons.push(`${path} is read by ${extra.dir}'s tests (EXTRA_INPUTS), and this suite covers ${extra.dir}`);
        continue;
      }
      const owner = [...workspaceDirs].find((dir) => path.startsWith(`${dir}/`));
      if (owner && closureDirs.has(owner)) {
        reasons.push(`${path} is in ${owner}, which this suite builds, tests or imports`);
      } else if (owner) {
        ignored.push(path);
      } else if (isInertDocumentation(path)) {
        ignored.push(path);
      } else {
        reasons.push(`${path} is not inside any workspace and is not documentation`);
      }
    }

    if (lockfileChanged) {
      if (reasons.length > 0) {
        reasons.push(`${LOCKFILE} changed (not analysed: the suite already runs)`);
      } else {
        const verdict = lockfileVerdict(cwd, base, head, closure);
        if (verdict.reason) reasons.push(verdict.reason);
        else ignored.push(verdict.ignored);
      }
    }

    verdicts[suite] = { run: reasons.length > 0, reasons, ignored, roots: roots[suite], closure };
  }
  return verdicts;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--base' || flag === '--head') args[flag.slice(2)] = argv[++index];
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

function emit(runs, lines) {
  const outputs = SUITES.map((suite) => `${suite}=${runs[suite] ? 'true' : 'false'}`);
  for (const line of outputs) console.log(line);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      '### Suites on this pull request\n\n' +
        SUITES.map((suite) => `- **${suite}** (${SUITE_JOBS[suite].join(', ')}): ${runs[suite] ? 'RUN' : 'SKIPPED'}`).join('\n') +
        '\n\n```\n' + lines.join('\n') + '\n```\n\n' +
        'The merge queue runs every suite regardless.\n'
    );
  }
}

if (import.meta.main) {
  const cwd = process.cwd();
  try {
    const args = parseArgs(process.argv.slice(2));
    let base = args.base;
    const head = args.head ?? 'HEAD';
    if (!base) {
      // The pull_request checkout is GitHub's merge commit: parent 1 is the base
      // branch it was merged onto, so HEAD^1..HEAD is exactly what the PR adds
      // to the tree the queue will test. Anything else is not that commit.
      const parents = git(cwd, ['rev-list', '--parents', '-n', '1', head]).trim().split(/\s+/);
      if (parents.length !== 3) {
        throw new Error(`${head} has ${parents.length - 1} parent(s), not 2: it is not a pull request merge commit`);
      }
      base = parents[1];
    }
    const verdicts = decide({ cwd, base, head });
    const lines = [`diff: ${base.slice(0, 12)}..${head}`];
    for (const suite of SUITES) {
      const { run, reasons, ignored, roots, closure } = verdicts[suite];
      lines.push(
        '',
        `[${suite}] ${run ? 'RUN' : 'SKIP'} — roots: ${roots.join(', ')}`,
        `  closure: ${closure.join(', ')}`,
        ...(run
          ? [`  Runs because (${reasons.length}):`, ...reasons.slice(0, 15).map((r) => `    - ${r}`)]
          : ['  Nothing reaches this suite.']),
        ...(ignored.length > 0 ? [`  Outside its reach (${ignored.length}):`, ...ignored.slice(0, 20).map((p) => `    - ${p}`)] : [])
      );
    }
    emit(Object.fromEntries(SUITES.map((suite) => [suite, verdicts[suite].run])), lines);
  } catch (error) {
    // Fail toward running: a scope we cannot compute is a scope we do not trust.
    emit(Object.fromEntries(SUITES.map((suite) => [suite, true])), [
      `Every suite runs because the scope could not be computed: ${error?.stack ?? error}`,
    ]);
  }
}
