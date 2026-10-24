#!/usr/bin/env node
/**
 * Behavioral verification for the maintained Zod forks. Package names and an
 * audit's version verdict cannot prove that embedded /v3 or /v4 parsers changed.
 * Run against both built workspaces and every materialized installed copy.
 * An extracted published tarball can be checked with --package <directory>.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
export const FORKS = Object.freeze({
  '@oxy.so/zod3': '3.25.77',
  '@oxy.so/zod4': '4.6.8',
});
export const UPSTREAM = Object.freeze({
  '@oxy.so/zod3': {
    version: '3.25.76',
    integrity:
      'sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==',
    gitHead: '50606616c0d291caf3210a7521da51271b918333',
  },
  '@oxy.so/zod4': {
    version: '4.6.7',
    integrity:
      'sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==',
    gitHead: 'b500a2ee95134f81d74da7911d7378dd2853d042',
  },
});
const parserExports = ['.', './v3', './v4', './v4-mini', './v4/mini', './v4/core'];

function metadata(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

function exportedFile(directory, manifest, subpath, mode) {
  const condition = mode === 'source' ? '@zod/source' : mode;
  const entry = manifest.exports?.[subpath];
  const target = typeof entry === 'string' ? entry : entry?.[condition];
  assert.equal(typeof target, 'string', `Missing ${condition} export ${subpath}`);
  const path = realpathSync(resolve(directory, target));
  const fromRoot = relative(realpathSync(directory), path);
  assert.ok(
    fromRoot && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
    'Export escaped package',
  );
  return path;
}

async function load(directory, manifest, subpath, mode) {
  const path = exportedFile(directory, manifest, subpath, mode);
  return mode === 'require' ? require(path) : import(pathToFileURL(path).href);
}

function observedInput(kind) {
  const values = Array.from({ length: 16 }, (_, index) => index);
  let visits = 0;
  class ObservedSet extends Set {
    *values() {
      for (const value of super.values()) {
        visits++;
        yield value;
      }
    }
    *[Symbol.iterator]() {
      for (const value of super.values()) {
        visits++;
        yield value;
      }
    }
  }
  class ObservedMap extends Map {
    *entries() {
      for (const value of super.entries()) {
        visits++;
        yield value;
      }
    }
    *[Symbol.iterator]() {
      for (const value of super.entries()) {
        visits++;
        yield value;
      }
    }
  }
  const data =
    kind === 'array'
      ? new Proxy(values, {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
            return Reflect.get(target, key, receiver);
          },
        })
      : kind === 'set'
        ? new ObservedSet(values)
        : new ObservedMap(values.map((value) => [value, value]));
  return { data, visits: () => visits };
}

function boundedSchema(z, { core, v3, kind, exact }) {
  if (core) {
    const string = () => new z.$ZodString({ type: 'string' });
    const check =
      kind === 'array'
        ? exact
          ? new z.$ZodCheckLengthEquals({ check: 'length_equals', length: 1 })
          : new z.$ZodCheckMaxLength({ check: 'max_length', maximum: 1 })
        : exact
          ? new z.$ZodCheckSizeEquals({ check: 'size_equals', size: 1 })
          : new z.$ZodCheckMaxSize({ check: 'max_size', maximum: 1 });
    return kind === 'array'
      ? new z.$ZodArray({ type: 'array', element: string(), checks: [check] })
      : kind === 'set'
        ? new z.$ZodSet({ type: 'set', valueType: string(), checks: [check] })
        : new z.$ZodMap({ type: 'map', keyType: string(), valueType: string(), checks: [check] });
  }
  const schema = kind === 'map' ? z.map(z.string(), z.string()) : z[kind](z.string());
  if (v3) return schema[exact ? (kind === 'array' ? 'length' : 'size') : 'max'](1);
  return schema.check(
    kind === 'array' ? (exact ? z.length(1) : z.maxLength(1)) : exact ? z.size(1) : z.maxSize(1),
  );
}

/** Also used on untouched upstream distributions as the negative control. */
export async function probePackage(directory, mode = 'import', compiled = false) {
  const manifest = metadata(directory);
  const results = [];
  const subpaths = [...parserExports];
  if (manifest.exports?.['./mini']) subpaths.push('./mini');
  if (compiled) await load(directory, manifest, './compile', mode);
  for (const subpath of subpaths) {
    const z = await load(directory, manifest, subpath, mode);
    const core = subpath === './v4/core';
    const v3 = !core && typeof z.array(z.string()).check !== 'function';
    for (const kind of v3 ? ['array', 'set'] : ['array', 'set', 'map']) {
      for (const exact of [false, true]) {
        const schema = boundedSchema(z, { core, v3, kind, exact });
        for (const asynchronous of [false, true]) {
          const parse = (value) =>
            core
              ? z[asynchronous ? 'safeParseAsync' : 'safeParse'](schema, value)
              : schema[asynchronous ? 'safeParseAsync' : 'safeParse'](value);
          const valid =
            kind === 'array' ? ['ok'] : kind === 'set' ? new Set(['ok']) : new Map([['key', 'ok']]);
          const validResult = await parse(valid);
          assert.equal(validResult.success, true, `${subpath} ${kind}: valid boundary rejected`);
          assert.deepEqual(validResult.data, valid);
          const observed = observedInput(kind);
          const result = await parse(observed.data);
          const fixed =
            !result.success &&
            observed.visits() === 0 &&
            result.error.issues.length === 1 &&
            result.error.issues[0].code === 'too_big';
          results.push({
            subpath,
            kind,
            exact,
            asynchronous,
            fixed,
            visits: observed.visits(),
            issues: result.success ? 0 : result.error.issues.length,
          });
        }
      }
    }
    // Only classic exposes these methods. An aborted oversized container must
    // not hand an invented/truncated value to an outer refinement or transform.
    if (!core && typeof z.array(z.string()).max === 'function') {
      let refinements = 0;
      const nested = z.object({
        items: z
          .array(z.string())
          .max(1, 'bounded collection')
          .refine(() => {
            refinements++;
            return true;
          }),
      });
      const result = nested.safeParse({ items: ['a', 'b'] });
      const fixed =
        !result.success &&
        refinements === 0 &&
        result.error.issues.length === 1 &&
        result.error.issues[0].message === 'bounded collection' &&
        JSON.stringify(result.error.issues[0].path) === '["items"]';
      results.push({ subpath, kind: 'outer-refinement', fixed });
      const transformed = z.array(z.string().transform((value) => value.toUpperCase())).max(1);
      assert.deepEqual(transformed.parse(['ok']), ['OK']);
      const recovered = z.array(z.string()).max(1).catch(['fallback']);
      assert.deepEqual(recovered.parse(['a', 'b']), ['fallback']);
      if (!v3 && typeof z.array(z.string()).overwrite === 'function') {
        // V4 may transform a collection before a later bound: do not hoist a
        // size check past overwrite, which would reject a valid transformed input.
        assert.deepEqual(
          z
            .array(z.string())
            .overwrite((values) => values.slice(0, 1))
            .max(1)
            .parse(['a', 'b']),
          ['a'],
        );
      }
    }
  }
  return {
    name: manifest.name,
    version: manifest.version,
    mode,
    compiled,
    checks: results.length,
    failures: results.filter((result) => !result.fixed),
  };
}

export function runProbe(directory, mode, compiled = false) {
  // Builder/release checks execute on Node; final-image checks execute on Bun.
  // Keep the caller's real runtime instead of requiring Node in a Bun-only image.
  const executable = mode === 'source' ? 'bun' : process.execPath;
  const run = spawnSync(executable, [script, '--probe', directory, mode, String(compiled)], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${directory} ${mode}: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout);
}

/** No skip-source option: release artifacts must ship their advertised source too. */
export function verifyPackage(directory) {
  const manifest = metadata(directory);
  assert.equal(
    manifest.version,
    FORKS[manifest.name],
    `Unreviewed Zod distribution ${manifest.name}@${manifest.version}`,
  );
  assert.ok(Object.hasOwn(FORKS, manifest.name), `Unreviewed Zod package ${manifest.name}`);
  const upstream = UPSTREAM[manifest.name];
  const provenance = JSON.parse(readFileSync(join(directory, 'upstream/provenance.json'), 'utf8'));
  assert.equal(provenance.name, 'zod');
  for (const key of ['version', 'integrity', 'gitHead'])
    assert.equal(provenance[key], upstream[key], `Unreviewed upstream ${key}`);
  assert.equal(provenance.tarball, `https://registry.npmjs.org/zod/-/zod-${upstream.version}.tgz`);
  assert.equal(provenance.advisory, 'GHSA-mrhx-c7xc-m3w5');
  const expectedExports = [...parserExports, './package.json', './v4/locales', './v4/locales/*'];
  if (manifest.name === '@oxy.so/zod4') expectedExports.push('./mini', './compile', './locales');
  assert.deepEqual(
    Object.keys(manifest.exports).sort(),
    expectedExports.sort(),
    'Unreviewed export surface',
  );
  const results = [];
  for (const mode of ['require', 'import', 'source']) {
    for (const compiled of manifest.exports?.['./compile'] ? [false, true] : [false]) {
      const result = runProbe(directory, mode, compiled);
      assert.deepEqual(
        result.failures,
        [],
        `Unfixed parser in ${directory}: ${JSON.stringify(result.failures)}`,
      );
      results.push(result);
    }
  }
  return results;
}

/** Physical inventory includes Bun/pnpm stores and nested dependency trees. */
export function installedZodCopies(nodeModulesRoots, workspaceRoots = []) {
  const copies = new Set();
  const visited = new Set();
  function visitModules(path) {
    if (!existsSync(path)) return;
    const real = realpathSync(path);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      const child = join(real, entry.name);
      if (entry.name === '.bun' || entry.name === '.pnpm') {
        for (const stored of readdirSync(child, { withFileTypes: true })) {
          if (stored.isDirectory()) visitModules(join(child, stored.name, 'node_modules'));
        }
      } else if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(child)) visitPackage(join(child, scoped));
      } else if (!entry.name.startsWith('.')) visitPackage(child);
    }
  }
  function visitPackage(path) {
    if (!existsSync(path) || !statSync(path).isDirectory()) return;
    const manifestPath = join(path, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = metadata(path);
      if (
        basename(path) === 'zod' ||
        manifest.name === 'zod' ||
        Object.hasOwn(FORKS, manifest.name)
      )
        copies.add(realpathSync(path));
    }
    visitModules(join(path, 'node_modules'));
  }
  for (const root of nodeModulesRoots) visitModules(root);
  for (const root of workspaceRoots) visitPackage(root);
  return [...copies].sort();
}

export function verifyInstallation(root) {
  const roots = [join(root, 'node_modules')];
  const workspaces = [];
  for (const group of ['packages', 'apps', 'workers']) {
    const directory = join(root, group);
    if (existsSync(directory))
      for (const entry of readdirSync(directory)) {
        roots.push(join(directory, entry, 'node_modules'));
        workspaces.push(join(directory, entry));
      }
  }
  const copies = installedZodCopies(roots, workspaces);
  assert.ok(copies.length > 0, 'No installed Zod inventory; run the frozen install first');
  const names = new Set(copies.map((path) => metadata(path).name));
  for (const name of Object.keys(FORKS))
    assert.ok(names.has(name), `Missing installed fork ${name}`);
  return copies.map((path) => ({ path, results: verifyPackage(path) }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--probe' && args.length === 4) {
    assert.ok(['require', 'import', 'source'].includes(args[2]));
    assert.ok(['true', 'false'].includes(args[3]));
    console.log(JSON.stringify(await probePackage(resolve(args[1]), args[2], args[3] === 'true')));
  } else if (args[0] === '--package' && args.length === 2) {
    console.log(JSON.stringify(verifyPackage(resolve(args[1])), null, 2));
  } else {
    assert.equal(args.length, 0, 'Usage: node scripts/check-zod-forks.mjs [--package directory]');
    const root = resolve(dirname(script), '..');
    const workspaces = ['zod3', 'zod4'].map((name) => ({
      name,
      results: verifyPackage(join(root, 'packages', name)),
    }));
    console.log(JSON.stringify({ workspaces, installed: verifyInstallation(root) }, null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) await main();
