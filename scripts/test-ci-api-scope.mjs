#!/usr/bin/env bun
/**
 * Exercises scripts/ci-api-scope.mjs against throwaway git repositories built
 * from the REAL root manifest, every real workspace manifest and the real
 * bun.lock, each mutated the way a pull request would.
 *
 * The scope decides whether a pull request runs the API suite, so its one
 * unacceptable failure is a false `false`: a change that reaches the API and is
 * skipped. Most cases below therefore assert `true` for a change that must run
 * the suite, each with the REASON the script gives, and the `false` cases are
 * the positive controls proving the script can say no at all — a scope that
 * always says `true` would pass every must-run case and save nothing.
 *
 * The lockfile cases mutate entries the script itself did NOT choose: one that
 * the API provably reaches (express, a direct dependency) and one it provably
 * does not (@oxy.so/bloom, which only app packages use), plus a phantom-import
 * case built from a root-level package the manifest walk alone never visits.
 *
 * Also a census over the real packages/api: every `packages/<x>/` and
 * `<rootDir>/../<x>/` reference must name a package in the computed closure.
 * A test that reads another package's files at runtime is the one dependency
 * the lockfile and manifest walks cannot see; this makes adding one go red here
 * instead of silently making the scope too narrow.
 *
 * Offline, no install: git, Bun and node builtins only.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiClosure, apiLockFootprint, importedPackages, parseLockfile, workspaceDirectories } from './ci-api-scope.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scopeScript = join(repoRoot, 'scripts', 'ci-api-scope.mjs');
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
  const root = mkdtempSync(join(tmpdir(), 'oxy-api-scope-'));
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

/** Build base, mutate, commit head, decide base..head, assert verdict + reason. */
function expectScope(name, mutate, expected, fragment) {
  cases += 1;
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
  const verdict = output.match(/^api-tests=(true|false)$/m)?.[1];
  if (verdict !== String(expected)) {
    failures.push(`${name}: expected api-tests=${expected}, got ${verdict ?? 'no verdict'}.\n${output}`);
    return;
  }
  if (fragment && !output.includes(fragment)) {
    failures.push(`${name}: output does not contain ${JSON.stringify(fragment)}.\n${output}`);
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

// ── Positive controls: the scope can say no ────────────────────────────────
expectScope('docs-only-skips', (root) => write(root, 'docs/README.md', '# docs, edited\n'), false, 'Nothing reaches the API suite');
expectScope('root-markdown-skips', (root) => write(root, 'NOTES.md', 'x\n'), false, 'Nothing reaches the API suite');
expectScope('an-app-package-skips', (root) => write(root, 'packages/services/src/index.ts', 'export const services = 2;\n'), false, 'Nothing reaches the API suite');
expectScope('an-unreachable-lock-entry-skips', (root) => bumpIntegrity(root, '@oxy.so/bloom'), false, 'reachable from the API are identical');
expectScope(
  'a-catalog-only-root-change-defers-to-the-lockfile',
  (root) => editJson(root, 'package.json', (m) => { m.workspaces.catalog['@oxy.so/bloom'] = '^99.0.0'; }),
  false,
  'decided by the lockfile walk'
);

// ── Paths that must run the suite ──────────────────────────────────────────
expectScope('packages-api-runs', (root) => write(root, 'packages/api/src/server.ts', '// edited\n'), true, 'packages/api/src/server.ts is in packages/api');
expectScope('a-closure-package-runs', (root) => write(root, 'packages/core/src/index.ts', 'export const core = 2;\n'), true, 'is in packages/core');
expectScope(
  'a-package-that-joins-the-closure-runs',
  (root) => {
    editJson(root, 'packages/core/package.json', (m) => { m.dependencies = { ...m.dependencies, '@oxy.so/services': 'workspace:*' }; });
    write(root, 'packages/services/src/index.ts', 'export const services = 3;\n');
  },
  true,
  'packages/services/src/index.ts is in packages/services'
);
expectScope(
  'a-file-moved-out-of-the-api-runs',
  (root) => { git(root, 'mv', 'packages/api/src/server.ts', 'packages/services/src/server.ts'); },
  true,
  'packages/api/src/server.ts is in packages/api'
);
expectScope('dot-github-runs', (root) => write(root, '.github/workflows/ci.yml', 'name: x\n'), true, '.github/workflows/ci.yml is not inside any workspace');
expectScope('root-config-runs', (root) => write(root, 'tsconfig.json', '{"compilerOptions":{}}\n'), true, 'tsconfig.json is not inside any workspace');
expectScope('root-scripts-run', (root) => write(root, 'scripts/new.mjs', '1\n'), true, 'scripts/new.mjs is not inside any workspace');
expectScope('an-unknown-top-level-path-runs', (root) => write(root, 'somewhere/new.txt', '1\n'), true, 'somewhere/new.txt is not inside any workspace');
expectScope('markdown-inside-the-api-runs', (root) => write(root, 'packages/api/NOTES.md', '1\n'), true, 'is in packages/api');
expectScope(
  'the-bun-version-runs',
  (root) => editJson(root, 'package.json', (m) => { m.packageManager = 'bun@0.0.1'; }),
  true,
  'package.json changed outside the catalog'
);
expectScope(
  'the-workspace-list-runs',
  (root) => editJson(root, 'package.json', (m) => { m.workspaces.packages = m.workspaces.packages.filter((d) => d !== 'packages/doctor'); }),
  true,
  'package.json changed outside the catalog'
);

// ── The lockfile walk ──────────────────────────────────────────────────────
expectScope('a-direct-api-dependency-in-the-lock-runs', (root) => bumpIntegrity(root, 'express'), true, 'changes what the API resolves');
expectScope(
  'a-transitive-api-dependency-in-the-lock-runs',
  (root) => {
    const lock = parseLockfile(read(root, 'bun.lock'));
    // express's own first dependency, whichever it is today: a key two hops out.
    const dependency = Object.keys(lock.packages.express[2].dependencies).sort()[0];
    return bumpIntegrity(root, dependency);
  },
  true,
  'changes what the API resolves'
);
expectScope(
  'trusted-dependencies-in-the-lock-run',
  (root) => {
    const text = read(root, 'bun.lock');
    const edited = text.replace('"trustedDependencies": [', '"trustedDependencies": [\n    "planted-package",');
    if (edited === text) return false;
    write(root, 'bun.lock', edited);
  },
  true,
  '#trustedDependencies'
);
{
  // A phantom import: a root-level package the API does not declare and the
  // manifest walk does not reach. Chosen from the real lockfile so the case
  // stays meaningful as the lockfile moves.
  const lock = parseLockfile(readFileSync(join(repoRoot, 'bun.lock'), 'utf8'));
  const workspaces = workspaceDirectories(repoRoot, 'HEAD');
  const closure = [...apiClosure(workspaces).values()].map((w) => w.dir);
  const reachable = new Set(apiLockFootprint(lock, closure, importedPackages(repoRoot, 'HEAD', closure)).map((line) => line.split(' = ')[0]));
  const phantom = Object.keys(lock.packages)
    .filter((key) => !key.includes('/') && !reachable.has(key) && /"sha512-/.test(JSON.stringify(lock.packages[key])))
    .sort()[0];
  if (!phantom) {
    failures.push('phantom-import: no unreachable root-level package in bun.lock to build the case from.');
  } else {
    expectScope(`an-unreachable-lock-change-skips (${phantom})`, (root) => bumpIntegrity(root, phantom), false, 'reachable from the API are identical');
    expectScope(
      `a-phantom-import-makes-it-reachable (${phantom})`,
      (root) => {
        // Committed on the BASE side too, so the import itself is not the change.
        write(root, 'packages/api/src/phantom.ts', `import x from '${phantom}';\nexport default x;\n`);
        commit(root, 'phantom import');
        return bumpIntegrity(root, phantom);
      },
      true,
      'changes what the API resolves'
    );
  }
}

// ── Fail toward running ────────────────────────────────────────────────────
expectScope(
  'an-unparseable-lockfile-runs',
  (root) => write(root, 'bun.lock', '{ not json'),
  true,
  'scope could not be computed'
);
{
  // No --base, and HEAD is an ordinary commit rather than GitHub's merge
  // commit: there is no trustworthy base, so the answer is run.
  cases += 1;
  const root = createFixture();
  write(root, 'docs/README.md', '# edited\n');
  commit(root);
  const output = runScope(root, []);
  if (!/^api-tests=true$/m.test(output) || !output.includes('not a pull request merge commit')) {
    failures.push(`a-non-merge-head-runs: expected api-tests=true naming the missing merge commit.\n${output}`);
  }
}
{
  // The CI shape: a two-parent merge commit, base = HEAD^1. A docs-only branch
  // merged onto main must skip; the same branch plus an API edit must run.
  for (const [name, change, expected] of [
    ['a-merge-commit-of-docs-skips', (root) => write(root, 'docs/README.md', '# branch\n'), 'false'],
    ['a-merge-commit-touching-the-api-runs', (root) => write(root, 'packages/api/src/server.ts', '// branch\n'), 'true'],
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
    if (!new RegExp(`^api-tests=${expected}$`, 'm').test(output)) {
      failures.push(`${name}: expected api-tests=${expected}.\n${output}`);
    }
  }
}

// ── Census: nothing in packages/api reads a package outside the closure ────
{
  cases += 1;
  const closure = new Set(
    [...apiClosure(workspaceDirectories(repoRoot, 'HEAD')).values()].map((w) => w.dir.replace(/^packages\//, ''))
  );
  const allPackages = new Set(readdirSync(join(repoRoot, 'packages')));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:[cm]?[jt]s|json)$/.test(entry)) {
        // Comment lines are prose (they name Console's hook, Commons' app.json) and
        // load nothing; a reference in code is what the suite could read.
        const text = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
          .join('\n');
        const referenced = [];
        for (const match of text.matchAll(/(?:\bpackages\/|<rootDir>\/\.\.\/)([a-z0-9-]+)\//g)) referenced.push(match[1]);
        // A relative specifier counts only when it actually climbs out of
        // packages/api: `../services/x` inside src/ is the API's own services.
        for (const match of text.matchAll(/['"`]((?:\.\.\/)+[A-Za-z0-9_.-]+)\//g)) {
          const target = relative(join(repoRoot, 'packages'), resolve(dirname(path), match[1]));
          if (!target.startsWith('..') && !target.startsWith('api')) referenced.push(target.split('/')[0]);
        }
        for (const name of referenced) {
          if (allPackages.has(name) && !closure.has(name) && name !== 'api') {
            offenders.push(`${relative(repoRoot, path)} → packages/${name}`);
          }
        }
      }
    }
  };
  walk(join(repoRoot, 'packages', 'api'));
  if (closure.size < 5 || !closure.has('api') || !closure.has('core')) {
    failures.push(`census: the computed closure looks wrong (${[...closure].join(', ')}); the census would be vacuous.`);
  }
  if (offenders.length > 0) {
    failures.push(
      `census: packages/api references packages outside its dependency closure, which ci-api-scope.mjs ` +
        `cannot see — a change there would skip the suite on a pull request:\n  ${[...new Set(offenders)].join('\n  ')}`
    );
  }
}

for (const root of fixtures) rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`ci-api-scope.mjs is BROKEN (${failures.length} of ${cases} case(s)):\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log(`ci-api-scope.mjs behaves: ${cases} cases — must-run paths, lockfile walk (direct, transitive, phantom, global sections), fail-toward-run, merge-commit base, and the closure census.`);
