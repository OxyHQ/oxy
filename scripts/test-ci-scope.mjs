#!/usr/bin/env bun
/**
 * Exercises scripts/ci-scope.mjs against throwaway git repositories built from
 * the REAL root manifest, every real workspace manifest, the real bun.lock and
 * the real ci.yml, each mutated the way a pull request would.
 *
 * The scope decides which suites a pull request runs, so its one unacceptable
 * failure is a false `false`: a change that reaches a suite and is skipped.
 * Most cases below therefore assert `true` for a change that must run a suite,
 * each with the REASON the script gives, and the `false` cases are the positive
 * controls proving the script can say no at all — a scope that always says
 * `true` would pass every must-run case and save nothing.
 *
 * The lockfile cases mutate entries the script itself did NOT choose: one that
 * the API provably reaches (express, a direct dependency) and one it provably
 * does not (@oxy.so/bloom, which only app packages use), plus a phantom-import
 * case built from a root-level package the manifest walk alone never visits.
 *
 * Also a census over every suite's real roots: every `packages/<x>/`,
 * `<rootDir>/../<x>/` and climbing `../<x>/` reference must name a package in
 * that suite's computed closure. A test or build that reads another package's
 * files at runtime is the one dependency the lockfile and manifest walks cannot
 * see; this makes adding one go red here instead of silently making a scope too
 * narrow.
 *
 * Offline, no install: git, Bun and node builtins only.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTRA_INPUTS,
  REPO_WIDE_TESTS,
  SUITES,
  WORKFLOW_PATH,
  closureOf,
  importedPackages,
  lockFootprint,
  parseLockfile,
  suiteRoots,
  workspaceDirectories,
} from './ci-scope.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scopeScript = join(repoRoot, 'scripts', 'ci-scope.mjs');
const realWorkflow = readFileSync(join(repoRoot, WORKFLOW_PATH), 'utf8');
const failures = [];
const fixtures = [];
let cases = 0;

const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const workspaceDirs = rootManifest.workspaces.packages;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

/** A repo holding the real manifests + lockfile and a minimal source tree, committed once. */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'oxy-ci-scope-'));
  fixtures.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
  cpSync(join(repoRoot, 'bun.lock'), join(root, 'bun.lock'));
  for (const dir of workspaceDirs) cpSync(join(repoRoot, dir, 'package.json'), join(root, dir, 'package.json'));
  write(root, 'packages/api/src/server.ts', "import express from 'express';\nexport const app = express();\n");
  write(root, 'packages/core/src/index.ts', "export const core = 1;\n");
  write(root, 'packages/services/src/index.ts', "export const services = 1;\n");
  write(root, 'packages/stickers/src/index.ts', "export const stickers = 1;\n");
  write(root, 'packages/console/src/main.tsx', "export const console = 1;\n");
  write(root, WORKFLOW_PATH, realWorkflow);
  write(root, 'docs/README.md', '# docs\n');
  write(root, 'tsconfig.json', '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function commit(root, message = 'head') {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
}

function runScope(root, args) {
  try {
    return execFileSync('bun', [scopeScript, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return `EXIT ${error.status}\n${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

const ALL_RUN = Object.fromEntries(SUITES.map((suite) => [suite, true]));

/** `suite=true|false` per suite, and each suite's own section of the report. */
function parseReport(output) {
  const verdicts = {};
  const sections = {};
  for (const suite of SUITES) {
    verdicts[suite] = output.match(new RegExp(`^${suite}=(true|false)$`, 'm'))?.[1];
    const start = output.indexOf(`\n[${suite}] `);
    const next = SUITES.map((other) => output.indexOf(`\n[${other}] `, start + 1)).filter((at) => at > start);
    sections[suite] = start === -1 ? '' : output.slice(start, next.length > 0 ? Math.min(...next) : undefined);
  }
  return { verdicts, sections };
}

/**
 * Build base, mutate, commit head, decide base..head, and assert every suite's
 * verdict. `expected` names every suite (a partial expectation would let a
 * suite's verdict drift unobserved), `'any'` only where the case says why;
 * `fragments` maps a suite to text its own
 * section must contain, or `*` to text anywhere in the output.
 */
function expectScope(name, mutate, expected, fragments = {}) {
  cases += 1;
  const missing = SUITES.filter((suite) => !(suite in expected));
  if (missing.length > 0) {
    failures.push(`${name}: the case does not say what ${missing.join(', ')} should do.`);
    return;
  }
  const root = createFixture();
  let mutated;
  try {
    mutated = mutate(root);
  } catch (error) {
    failures.push(`${name}: the mutation threw (${error.message}) — the case proves nothing.`);
    return;
  }
  if (mutated === false) {
    failures.push(`${name}: the mutation matched nothing — the case proves nothing.`);
    return;
  }
  commit(root);
  const output = runScope(root, ['--base', 'HEAD~1', '--head', 'HEAD']);
  const { verdicts, sections } = parseReport(output);
  for (const suite of SUITES) {
    if (expected[suite] !== 'any' && verdicts[suite] !== String(expected[suite])) {
      failures.push(`${name}: expected ${suite}=${expected[suite]}, got ${verdicts[suite] ?? 'no verdict'}.\n${output}`);
      return;
    }
  }
  for (const [where, fragment] of Object.entries(fragments)) {
    const haystack = where === '*' ? output : sections[where];
    if (!haystack.includes(fragment)) {
      failures.push(`${name}: ${where === '*' ? 'the output' : `the ${where} section`} does not contain ${JSON.stringify(fragment)}.\n${output}`);
    }
  }
}

/** Rewrite the sha512 of one lockfile entry, returning false when the key is absent. */
function bumpIntegrity(root, key) {
  const text = read(root, 'bun.lock');
  const line = new RegExp(`^(    ${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\[.*"sha512-)([A-Za-z0-9+/]{4})`, 'm');
  if (!line.test(text)) return false;
  write(root, 'bun.lock', text.replace(line, (_, head, first) => `${head}${first === 'AAAA' ? 'BBBB' : 'AAAA'}`));
  return true;
}

function editJson(root, path, edit) {
  const value = JSON.parse(read(root, path));
  edit(value);
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

// ── Positive controls: every suite can say no ──────────────────────────────
const NONE = { api: false, platform: false, apps: false };
expectScope('docs-only-skips-everything', (root) => write(root, 'docs/README.md', '# docs, edited\n'), NONE, {
  api: 'Nothing reaches this suite',
  platform: 'Nothing reaches this suite',
  apps: 'Nothing reaches this suite',
});
expectScope('root-markdown-skips-everything', (root) => write(root, 'NOTES.md', 'x\n'), NONE);
expectScope(
  'a-package-no-suite-covers-skips-everything',
  (root) => write(root, 'packages/create-oxy-app/src/index.ts', 'export {};\n'),
  NONE
);

// ── Each suite, alone ──────────────────────────────────────────────────────
// The point of scoping past the API: a change to one package runs the suites
// that reach it and no others.
expectScope(
  'an-app-package-runs-only-apps',
  (root) => write(root, 'packages/services/src/index.ts', 'export const services = 2;\n'),
  { api: false, platform: false, apps: true },
  { apps: 'packages/services/src/index.ts is in packages/services', api: 'Nothing reaches this suite' }
);
expectScope(
  'console-runs-only-apps',
  (root) => write(root, 'packages/console/src/main.tsx', 'export const console = 2;\n'),
  { api: false, platform: false, apps: true },
  { apps: 'is in packages/console' }
);
expectScope(
  'a-platform-leaf-runs-only-platform',
  (root) => write(root, 'packages/stickers/src/index.ts', 'export const stickers = 2;\n'),
  { api: false, platform: true, apps: false },
  { platform: 'packages/stickers/src/index.ts is in packages/stickers' }
);
expectScope(
  'mcp-runs-its-own-platform-suite-and-api-dependents',
  (root) => write(root, 'packages/mcp/src/internalTransport.ts', 'export {};\n'),
  { api: true, platform: true, apps: false },
  { api: 'is in packages/mcp', platform: 'is in packages/mcp', apps: 'Nothing reaches this suite' }
);
expectScope(
  'packages-api-runs-only-api',
  (root) => write(root, 'packages/api/src/server.ts', '// edited\n'),
  { api: true, platform: false, apps: false },
  { api: 'packages/api/src/server.ts is in packages/api' }
);
expectScope(
  'core-reaches-every-suite',
  (root) => write(root, 'packages/core/src/index.ts', 'export const core = 2;\n'),
  ALL_RUN,
  { api: 'is in packages/core', platform: 'is in packages/core', apps: 'is in packages/core' }
);
expectScope(
  'a-transitive-workspace-dependency-runs-its-dependents',
  // telemetry is a root of no suite; core (a root of all three) depends on it.
  (root) => write(root, 'packages/telemetry/src/index.ts', 'export {};\n'),
  ALL_RUN,
  { platform: 'is in packages/telemetry' }
);
expectScope(
  'a-package-that-joins-a-closure-runs',
  (root) => {
    editJson(root, 'packages/core/package.json', (m) => { m.dependencies = { ...m.dependencies, '@oxy.so/create-oxy-app-fixture': 'workspace:*' }; });
    editJson(root, 'packages/create-oxy-app/package.json', (m) => { m.name = '@oxy.so/create-oxy-app-fixture'; });
    write(root, 'packages/create-oxy-app/src/index.ts', 'export const x = 3;\n');
  },
  ALL_RUN,
  { api: 'packages/create-oxy-app/src/index.ts is in packages/create-oxy-app' }
);
expectScope(
  'a-file-moved-out-of-the-api-runs-api',
  (root) => { git(root, 'mv', 'packages/api/src/server.ts', 'packages/services/src/server.ts'); },
  { api: true, platform: false, apps: true },
  { api: 'packages/api/src/server.ts is in packages/api' }
);
expectScope(
  'markdown-inside-a-package-runs-its-suites',
  (root) => write(root, 'packages/api/NOTES.md', '1\n'),
  { api: true, platform: false, apps: false },
  { api: 'is in packages/api' }
);

// ── Paths that must run every suite ────────────────────────────────────────
expectScope('dot-github-runs', (root) => write(root, '.github/scripts/new.sh', 'x\n'), ALL_RUN, {
  apps: '.github/scripts/new.sh is not inside any workspace',
});
expectScope('root-config-runs', (root) => write(root, 'tsconfig.json', '{"compilerOptions":{}}\n'), ALL_RUN, {
  platform: 'tsconfig.json is not inside any workspace',
});
expectScope('turbo-config-runs', (root) => write(root, 'turbo.json', '{}\n'), ALL_RUN, {
  apps: 'turbo.json is not inside any workspace',
});
expectScope('root-scripts-run', (root) => write(root, 'scripts/new.mjs', '1\n'), ALL_RUN, {
  api: 'scripts/new.mjs is not inside any workspace',
});
expectScope('an-unknown-top-level-path-runs', (root) => write(root, 'somewhere/new.txt', '1\n'), ALL_RUN, {
  api: 'somewhere/new.txt is not inside any workspace',
});
expectScope(
  'the-bun-version-runs',
  (root) => editJson(root, 'package.json', (m) => { m.packageManager = 'bun@0.0.1'; }),
  ALL_RUN,
  { api: 'package.json changed outside the catalog' }
);
expectScope(
  'the-workspace-list-runs',
  (root) => editJson(root, 'package.json', (m) => { m.workspaces.packages = m.workspaces.packages.filter((d) => d !== 'packages/doctor'); }),
  ALL_RUN,
  { apps: 'package.json changed outside the catalog' }
);

// ── The workflow is the source of each suite's roots ───────────────────────
{
  cases += 1;
  const workspaces = workspaceDirectories(repoRoot, 'HEAD');
  let roots;
  try {
    roots = suiteRoots(realWorkflow, workspaces);
  } catch (error) {
    failures.push(`suite-roots: the real workflow does not yield roots (${error.message}).`);
  }
  if (roots) {
    // Vacuity floor: the packages each job is known to test today.
    for (const [suite, dir] of [
      ['api', 'packages/api'],
      ['platform', 'packages/db'],
      ['platform', 'packages/federation'],
      ['platform', 'packages/mcp'],
      ['platform', 'packages/stickers'],
      ['apps', 'packages/services'],
      ['apps', 'packages/console'],
      ['apps', 'packages/test-app-vite'],
    ]) {
      if (!roots[suite]?.includes(dir)) failures.push(`suite-roots: ${suite} does not include ${dir} (${roots[suite]?.join(', ')}).`);
    }
    // A step added for another package widens its suite with no edit here.
    const widened = realWorkflow.replace(
      "      - name: 'Federation Tests: build, lint, typecheck, test'\n",
      "      - name: 'Doctor Tests: test'\n        run: bun run test\n        working-directory: ./packages/doctor\n      - name: 'Federation Tests: build, lint, typecheck, test'\n"
    );
    if (widened === realWorkflow) {
      failures.push('suite-roots: the widening fixture matched nothing in ci.yml.');
    } else if (!suiteRoots(widened, workspaces).platform.includes('packages/doctor')) {
      failures.push('suite-roots: a platform step working in packages/doctor did not make doctor a platform root.');
    }
    // Anything unmappable throws, which the CLI turns into "run everything".
    for (const [label, text] of [
      ['a filter naming no workspace', realWorkflow.replace('run: bunx turbo run build --filter=oxy-console...', 'run: bunx turbo run build --filter=no-such-package...')],
      ['a working directory outside the workspaces', realWorkflow.replace('working-directory: ./packages/stickers', 'working-directory: ./elsewhere')],
      ['a suite job that is gone', realWorkflow.replace('\n  packages-apps:\n', '\n  packages-apps-renamed:\n')],
    ]) {
      if (text === realWorkflow) {
        failures.push(`suite-roots: the "${label}" fixture matched nothing in ci.yml.`);
        continue;
      }
      let threw = false;
      try {
        suiteRoots(text, workspaces);
      } catch {
        threw = true;
      }
      if (!threw) failures.push(`suite-roots: ${label} was accepted instead of refused.`);
    }
  }
}
expectScope(
  'an-unmappable-workflow-runs-everything',
  (root) => write(root, WORKFLOW_PATH, realWorkflow.replace('run: bunx turbo run build --filter=oxy-console...', 'run: bunx turbo run build --filter=no-such-package...')),
  ALL_RUN,
  { '*': 'scope could not be computed' }
);

// ── The lockfile walk ──────────────────────────────────────────────────────
expectScope(
  'a-bloom-only-lock-change-runs-only-apps',
  (root) => bumpIntegrity(root, '@oxy.so/bloom'),
  { api: false, platform: false, apps: true },
  { api: 'reachable from this suite are identical', platform: 'reachable from this suite are identical', apps: 'changes what this suite resolves' }
);
expectScope(
  'a-catalog-only-root-change-defers-to-the-lockfile',
  (root) => editJson(root, 'package.json', (m) => { m.workspaces.catalog['@oxy.so/bloom'] = '^99.0.0'; }),
  NONE,
  { api: 'decided by the lockfile walk' }
);
expectScope(
  'a-direct-api-dependency-in-the-lock-runs-api',
  (root) => bumpIntegrity(root, 'express'),
  // Other packages use express too; what they do is not this case's question.
  { api: true, platform: 'any', apps: 'any' },
  { api: 'changes what this suite resolves' }
);
expectScope(
  'a-transitive-api-dependency-in-the-lock-runs-api',
  (root) => {
    const lock = parseLockfile(read(root, 'bun.lock'));
    // express's own first dependency, whichever it is today: a key two hops out.
    const dependency = Object.keys(lock.packages.express[2].dependencies).sort()[0];
    return bumpIntegrity(root, dependency);
  },
  { api: true, platform: 'any', apps: 'any' },
  { api: 'changes what this suite resolves' }
);
expectScope(
  'trusted-dependencies-in-the-lock-run-everything',
  (root) => {
    const text = read(root, 'bun.lock');
    const edited = text.replace('"trustedDependencies": [', '"trustedDependencies": [\n    "planted-package",');
    if (edited === text) return false;
    write(root, 'bun.lock', edited);
  },
  ALL_RUN,
  { api: '#trustedDependencies', platform: '#trustedDependencies', apps: '#trustedDependencies' }
);
{
  // A phantom import: a root-level package NO suite declares and the manifest
  // walk does not reach. Chosen from the real lockfile so the case stays
  // meaningful as the lockfile moves.
  const lock = parseLockfile(readFileSync(join(repoRoot, 'bun.lock'), 'utf8'));
  const workspaces = workspaceDirectories(repoRoot, 'HEAD');
  const roots = suiteRoots(realWorkflow, workspaces);
  const reachable = new Set();
  for (const suite of SUITES) {
    const closure = [...closureOf(workspaces, roots[suite]).values()].map((w) => w.dir);
    for (const line of lockFootprint(lock, closure, importedPackages(repoRoot, 'HEAD', closure))) reachable.add(line.split(' = ')[0]);
  }
  const phantom = Object.keys(lock.packages)
    .filter((key) => !key.includes('/') && !reachable.has(key) && /"sha512-/.test(JSON.stringify(lock.packages[key])))
    .sort()[0];
  if (!phantom) {
    failures.push('phantom-import: no root-level package in bun.lock that no suite reaches, to build the case from.');
  } else {
    expectScope(`an-unreachable-lock-change-skips-everything (${phantom})`, (root) => bumpIntegrity(root, phantom), NONE, {
      api: 'reachable from this suite are identical',
    });
    expectScope(
      `a-phantom-import-makes-it-reachable (${phantom})`,
      (root) => {
        // Committed on the BASE side too, so the import itself is not the change.
        write(root, 'packages/api/src/phantom.ts', `import x from '${phantom}';\nexport default x;\n`);
        commit(root, 'phantom import');
        return bumpIntegrity(root, phantom);
      },
      { api: true, platform: false, apps: false },
      { api: 'changes what this suite resolves' }
    );
  }
}

// ── Fail toward running ────────────────────────────────────────────────────
expectScope('an-unparseable-lockfile-runs-everything', (root) => write(root, 'bun.lock', '{ not json'), ALL_RUN, {
  '*': 'scope could not be computed',
});
{
  // No --base, and HEAD is an ordinary commit rather than GitHub's merge
  // commit: there is no trustworthy base, so the answer is run.
  cases += 1;
  const root = createFixture();
  write(root, 'docs/README.md', '# edited\n');
  commit(root);
  const output = runScope(root, []);
  const { verdicts } = parseReport(output);
  if (SUITES.some((suite) => verdicts[suite] !== 'true') || !output.includes('not a pull request merge commit')) {
    failures.push(`a-non-merge-head-runs: expected every suite true, naming the missing merge commit.\n${output}`);
  }
}
{
  // The CI shape: a two-parent merge commit, base = HEAD^1. A docs-only branch
  // merged onto main must skip; the same branch plus an API edit must run the
  // API suite — and not the apps suite, although main itself moved services.
  for (const [name, change, expected] of [
    ['a-merge-commit-of-docs-skips', (root) => write(root, 'docs/README.md', '# branch\n'), NONE],
    ['a-merge-commit-touching-the-api-runs-api', (root) => write(root, 'packages/api/src/server.ts', '// branch\n'), { api: true, platform: false, apps: false }],
  ]) {
    cases += 1;
    const root = createFixture();
    git(root, 'checkout', '-q', '-b', 'feature');
    change(root);
    commit(root, 'feature');
    git(root, 'checkout', '-q', 'main');
    write(root, 'packages/services/src/index.ts', 'export const services = 9;\n');
    commit(root, 'main moved');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', 'feature');
    const output = runScope(root, []);
    const { verdicts } = parseReport(output);
    if (SUITES.some((suite) => verdicts[suite] !== String(expected[suite]))) {
      failures.push(`${name}: expected ${JSON.stringify(expected)}.\n${output}`);
    }
  }
}

// ── Declared extra inputs ──────────────────────────────────────────────────
for (const [dir, prefixes] of Object.entries(EXTRA_INPUTS)) {
  for (const prefix of prefixes) {
    cases += 1;
    if (!statSync(join(repoRoot, prefix), { throwIfNoEntry: false })) {
      failures.push(`extra-inputs: ${dir} declares ${prefix}, which does not exist; drop it from EXTRA_INPUTS.`);
    }
  }
}
expectScope(
  'a-declared-extra-input-runs-the-suites-covering-its-reader',
  (root) => write(root, 'packages/commons/modules/oxy-identity-host/vectors.json', '{"changed":true}\n'),
  // core, the reader, is in every suite's closure; commons alone is only in apps'.
  ALL_RUN,
  { platform: "read by packages/core's tests (EXTRA_INPUTS)", api: "read by packages/core's tests (EXTRA_INPUTS)" }
);

// ── Census: no suite root reads a package outside its suite's closure ──────
{
  const workspaces = workspaceDirectories(repoRoot, 'HEAD');
  const roots = suiteRoots(realWorkflow, workspaces);
  const allPackages = new Set(readdirSync(join(repoRoot, 'packages')));
  // A repository-wide test is exempt only while `guards` — never scoped — runs
  // it by name on every event.
  const guardsRuns = (Bun.YAML.parse(realWorkflow)?.jobs?.guards?.steps ?? [])
    .map((step) => `${step?.['working-directory'] ?? ''}\n${step?.run ?? ''}`)
    .join('\n');
  const exempt = new Set();
  for (const file of REPO_WIDE_TESTS) {
    cases += 1;
    const [, pkg, rest] = file.match(/^(packages\/[^/]+)\/(.+)$/) ?? [];
    if (!pkg || !guardsRuns.includes(`./${pkg}`) || !guardsRuns.includes(rest)) {
      failures.push(`repo-wide-tests: ${file} is listed as repository-wide, but no \`guards\` step runs it from ${pkg}.`);
    } else if (!statSync(join(repoRoot, file), { throwIfNoEntry: false })) {
      failures.push(`repo-wide-tests: ${file} does not exist; drop it from REPO_WIDE_TESTS and from guards.`);
    } else {
      exempt.add(file);
    }
  }
  for (const suite of SUITES) {
    cases += 1;
    const closure = new Set([...closureOf(workspaces, roots[suite]).values()].map((w) => w.dir.replace(/^packages\//, '')));
    const offenders = [];
    const walk = (dir, own) => {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', 'dist', 'lib', 'coverage', '.turbo', '.expo', 'android', 'ios'].includes(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, own);
        else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry) && !exempt.has(relative(repoRoot, path))) {
          // Comment lines are prose and load nothing; a reference in code is
          // what a suite could read.
          const text = readFileSync(path, 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
            .join('\n');
          const referenced = [];
          for (const match of text.matchAll(/(?:\bpackages\/|<rootDir>\/\.\.\/)([a-z0-9-]+)\//g)) referenced.push(match[1]);
          // A relative specifier counts only when it actually climbs out of the
          // package: `../services/x` inside api/src/ is the API's own services.
          for (const match of text.matchAll(/['"`]((?:\.\.\/)+[A-Za-z0-9_.-]+)\//g)) {
            const target = relative(join(repoRoot, 'packages'), resolve(dirname(path), match[1]));
            if (!target.startsWith('..') && !target.startsWith(own)) referenced.push(target.split('/')[0]);
          }
          const declared = (EXTRA_INPUTS[`packages/${own}`] ?? []).map((prefix) => prefix.split('/')[1]);
          for (const name of referenced) {
            if (allPackages.has(name) && !closure.has(name) && !declared.includes(name)) {
              offenders.push(`${relative(repoRoot, path)} → packages/${name}`);
            }
          }
        }
      }
    };
    for (const dir of roots[suite]) walk(join(repoRoot, dir), dir.replace(/^packages\//, ''));
    if (closure.size < 3) failures.push(`census(${suite}): the computed closure looks wrong (${[...closure].join(', ')}); the census would be vacuous.`);
    if (offenders.length > 0) {
      failures.push(
        `census(${suite}): its roots reference packages outside the suite's dependency closure, which ` +
          `ci-scope.mjs cannot see — a change there would skip the suite on a pull request:\n  ${[...new Set(offenders)].join('\n  ')}`
      );
    }
  }
}

for (const root of fixtures) rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`ci-scope.mjs is BROKEN (${failures.length} of ${cases} case(s)):\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log(
  `ci-scope.mjs behaves: ${cases} cases — each suite alone, must-run paths, workflow-derived roots, ` +
    'lockfile walk (direct, transitive, phantom, global sections), fail-toward-run, merge-commit base, and the closure census per suite.'
);
