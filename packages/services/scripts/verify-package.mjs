// @ts-check
/**
 * Assert that what `@oxyhq/services` actually PACKS is what its manifest
 * promises: every `exports` target present, `lib/` whole, and the dependency
 * ranges resolvable by a consumer.
 *
 * Why this exists: `@oxyhq/services@30.0.0` was published with NO `lib/` at
 * all — 276 tarball entries against 30.0.1's 2017, `lib/` at zero while `files`
 * still listed it, and 26 of the 33 `exports` targets pointing at files that did
 * not exist. Every web, Vite, Node and `tsc` consumer got a bundler failure on
 * install.
 *
 * Nothing caught it, and the reason is worth stating because it is the shape
 * every future miss will take: the 7 targets that DID resolve are the
 * `react-native` conditions, and those point at `src/`. Metro therefore worked,
 * and every check anyone ran — against `src/` — was green, true, and about a
 * different artefact than the one that shipped. `src/` being right says nothing
 * about `lib/`, so this script only ever reads the TARBALL.
 *
 * The oracle is `bun pm pack`, not `npm pack`, and that is not a preference:
 * `npm pack` leaves `workspace:*` and `catalog:` literals in the packed manifest
 * (measured on npm 10.9.8 / bun 1.3.14), which no consumer can resolve — the
 * failure `scripts/assert-bun-publish.mjs` exists to block. Verifying an npm
 * tarball would be verifying an artefact this repo must never publish.
 *
 * ## Re-entrancy
 *
 * Packing from a build hook is re-entrant in principle, because a pack runs
 * `prepack` and `prepare`, and either could rebuild. Measured on bun 1.3.14 with
 * a lifecycle-probe package:
 *
 *   bun pm pack                   -> prepack, prepare, postpack
 *   bun pm pack --ignore-scripts  -> (nothing)
 *   npm pack --ignore-scripts     -> prepare      <- npm's long-standing bug
 *
 * So on this packer ONE guard is load-bearing — `--ignore-scripts` — where
 * Bloom's equivalent needs two, because it packs with npm and npm runs `prepare`
 * whatever the flag says. Services also declares no `prepack` and no `prepare`
 * today, so there is nothing for a pack to re-enter in the first place.
 *
 * REENTRY_ENV is the containment for both of those premises changing. It is set
 * on the child pack and read at the top of this file, so unlike a flag named in
 * one place and honoured in another it cannot drift out of sync with a script
 * name. It does not fire today; if the packer ever stops honouring
 * `--ignore-scripts`, or someone adds a `prepare` that builds, it turns an
 * infinite recursion into a clean skip.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Set on the child pack, read below. See the re-entrancy note in the header. */
const REENTRY_ENV = 'OXY_SERVICES_VERIFY_PACKAGE_RUNNING';

/**
 * Absolute floors on the tarball.
 *
 * 30.0.0's tell was 276 entries against 2017, and nobody had a baseline to
 * compare it to — which is the only reason it took a fleet-wide bundler failure
 * to notice. These exist so that a pack missing a whole tree fails on the number
 * alone, even if the exports walk somehow passes.
 *
 * They are floors, not targets. Do NOT ratchet them up as the SDK grows: a
 * change that legitimately deletes a family has to be able to go green. Today
 * the pack is 2017 entries, 1741 of them under `lib/`.
 */
const MIN_PACKED_FILES = 1500;
const MIN_LIB_FILES = 1200;

/**
 * Vacuity floor for the exports walk itself.
 *
 * `collectTargets()` returning an empty set is indistinguishable from a package
 * whose every target is present — both report zero missing. The manifest carries
 * 28 unique targets today; a walk that finds fewer than 20 has stopped reading
 * the export map rather than the map having shrunk.
 */
const MIN_EXPORTS_TARGETS = 20;

/**
 * `lib/` subtrees whose `.js` output must each have a declaration beside it in
 * `lib/typescript/<tree>/`.
 *
 * This is the sharp instrument the floors above are not. A floor catches a tree
 * that vanished WHOLE — measured, dropping `lib/typescript/` takes the pack to
 * 1150 entries and 874 under `lib/`, under both floors. What it cannot catch is
 * the PARTIAL version: a tsc step that died halfway, or one declaration lost to
 * the `delete-dts.js`/`delete-debug-view` cleanups. Measured, deleting a single
 * `.d.ts` moves the total from 2017 to 2016 and no count can see that; this rule
 * names the module.
 *
 * Measured today: 214 `.js` per tree, 0 without a matching `.d.ts`.
 */
const DECLARED_TREES = ['commonjs', 'module'];

/**
 * Dependency-range protocols bun is expected to have substituted away by the
 * time the tarball exists. A literal one surviving means the tarball was built
 * by something other than `bun pm pack` — `@oxyhq/core@12.10.1` shipped exactly
 * that and was unresolvable for every consumer.
 *
 * Scope, stated because it is easy to overread: this script does its own
 * packing, so what it proves is that BUN still substitutes, not that the release
 * used bun. `scripts/assert-bun-publish.mjs` is what enforces the second, and
 * only on publish paths that run `prepublishOnly` at all.
 */
const UNRESOLVABLE_PROTOCOLS = ['workspace:', 'catalog:'];
const MANIFEST_RANGE_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/** Collect every file path an `exports` entry references, at any nesting depth. */
function collectTargets(node, out) {
  if (typeof node === 'string') {
    if (node.startsWith('./')) out.add(node.slice(2));
    return out;
  }
  if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node)) collectTargets(value, out);
  }
  return out;
}

/**
 * Pack for real and read the artefact back, rather than asking a packer to
 * describe what it would have done. The tarball is the thing that ships, and
 * reading it is also what makes the manifest check below possible — a dry run
 * reports paths, not the substituted dependency ranges.
 */
function packTarball() {
  const outDir = mkdtempSync(join(tmpdir(), 'oxy-services-verify-'));
  try {
    execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--destination', outDir], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, [REENTRY_ENV]: '1' },
    });

    const packed = readdirSync(outDir).filter((name) => name.endsWith('.tgz'));
    if (packed.length !== 1) {
      throw new Error(`expected exactly one tarball in ${outDir}, found ${packed.length}`);
    }
    return { outDir, tarball: join(outDir, packed[0]) };
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Every path in the tarball, with npm's `package/` prefix stripped and directory
 * entries dropped — an `exports` target is always a file.
 */
function tarballFiles(tarball) {
  const listing = execFileSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(
    listing
      .split('\n')
      .filter((line) => line.startsWith('package/') && !line.endsWith('/'))
      .map((line) => line.slice('package/'.length)),
  );
}

function tarballManifest(tarball) {
  return JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
}

/**
 * An `exports` PATTERN resolves to whatever `*` expands to, so "the target
 * exists" is the wrong question — the right one is whether the expansion has any
 * match at all. `./plugins/*` -> `./plugins/*.js` covers 4 config plugins today;
 * zero matches means every `@oxyhq/services/plugins/withX` import in every app's
 * `app.config.js` fails, and a literal-path check would call that file present
 * and be wrong twice over (there is no file named `plugins/*.js`).
 *
 * `*` in an exports pattern matches across `/`, unlike a glob.
 */
function patternMatches(pattern, files) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '(.+)')}$`);
  return [...files].filter((path) => re.test(path));
}

function checkExports(targets, files) {
  const problems = [];

  const literal = targets.filter((target) => !target.includes('*'));
  const patterns = targets.filter((target) => target.includes('*'));

  const missing = literal.filter((target) => !files.has(target));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} of ${targets.length} exports targets are absent from the tarball — ` +
        'every consumer that resolves one of these fails at bundle time, before any typecheck ' +
        'runs:\n' +
        missing.map((path) => `    - ${path}`).join('\n'),
    );
  }

  const unmatched = patterns.filter((pattern) => patternMatches(pattern, files).length === 0);
  if (unmatched.length > 0) {
    problems.push(
      `${unmatched.length} exports pattern(s) expand to nothing in the tarball:\n` +
        unmatched.map((pattern) => `    - ${pattern}`).join('\n'),
    );
  }

  if (targets.length < MIN_EXPORTS_TARGETS) {
    problems.push(
      `the exports walk found only ${targets.length} targets (expected >= ${MIN_EXPORTS_TARGETS}) — ` +
        'the map did not shrink, this scan did, and the every-target-ships rule above is vacuous ' +
        'until it is fixed',
    );
  }

  return problems;
}

function checkFloors(files) {
  const problems = [];
  const libCount = [...files].filter((path) => path.startsWith('lib/')).length;

  if (files.size < MIN_PACKED_FILES) {
    problems.push(
      `only ${files.size} files packed (expected >= ${MIN_PACKED_FILES}) — run \`bun run build\` ` +
        'and check every step of it, not just the exit code',
    );
  }
  if (libCount < MIN_LIB_FILES) {
    problems.push(
      `lib/ contributes only ${libCount} files (expected >= ${MIN_LIB_FILES}). This is the 30.0.0 ` +
        'failure exactly: `files` lists lib/, the react-native conditions point at src/ and keep ' +
        'working, and every other consumer breaks.',
    );
  }

  return { problems, libCount };
}

function checkDeclarations(files) {
  const problems = [];

  for (const tree of DECLARED_TREES) {
    const prefix = `lib/${tree}/`;
    const modules = [...files].filter(
      (path) => path.startsWith(prefix) && path.endsWith('.js') && !path.endsWith('.d.js'),
    );

    if (modules.length === 0) {
      problems.push(
        `lib/${tree}/ contains no .js at all — the ${tree} target did not run, or did not pack`,
      );
      continue;
    }

    const undeclared = modules.filter((path) => {
      const relative = path.slice(prefix.length).replace(/\.js$/, '.d.ts');
      return !files.has(`lib/typescript/${tree}/${relative}`);
    });

    if (undeclared.length > 0) {
      problems.push(
        `${undeclared.length} of ${modules.length} modules in lib/${tree}/ have no declaration in ` +
          `lib/typescript/${tree}/ — consumers resolve types there and get an implicit any, or ` +
          'TS2307, depending on their config:\n' +
          undeclared
            .slice(0, 10)
            .map((path) => `    - ${path}`)
            .join('\n') +
          (undeclared.length > 10 ? `\n    ... and ${undeclared.length - 10} more` : ''),
      );
    }
  }

  return problems;
}

function checkManifestRanges(manifest) {
  const problems = [];
  let rangeCount = 0;

  for (const field of MANIFEST_RANGE_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      rangeCount += 1;
      const protocol = UNRESOLVABLE_PROTOCOLS.find((p) => String(range).startsWith(p));
      if (protocol) {
        problems.push(
          `${field}["${name}"] is the literal "${range}" — the "${protocol}" protocol was not ` +
            'substituted, so no consumer can install this. The tarball was not built by ' +
            '`bun pm pack`.',
        );
      }
    }
  }

  // Positive control: the walk above reports nothing either when every range is
  // clean or when it read no ranges at all.
  if (rangeCount < 10) {
    problems.push(
      `the packed manifest exposed only ${rangeCount} dependency ranges (expected >= 10) — ` +
        'the protocol check above measured nothing',
    );
  }

  return problems;
}

function main() {
  if (process.env[REENTRY_ENV] === '1') {
    console.log('[verify-package] skipped — already running (re-entered from a pack lifecycle)');
    return;
  }

  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const targets = [...collectTargets(pkg.exports, new Set())].sort();

  const { outDir, tarball } = packTarball();
  let files;
  let manifest;
  try {
    files = tarballFiles(tarball);
    manifest = tarballManifest(tarball);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  const { problems: floorProblems, libCount } = checkFloors(files);
  const problems = [
    ...checkExports(targets, files),
    ...floorProblems,
    ...checkDeclarations(files),
    ...checkManifestRanges(manifest),
  ];

  if (problems.length > 0) {
    console.error(`[verify-package] FAILED for ${pkg.name}@${pkg.version}\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  const declared = DECLARED_TREES.map(
    (tree) =>
      `${[...files].filter((p) => p.startsWith(`lib/${tree}/`) && p.endsWith('.js')).length} in lib/${tree}/`,
  ).join(', ');

  console.log(
    `[verify-package] ok — ${pkg.name}@${pkg.version} packs ${files.size} files (${libCount} under ` +
      `lib/), all ${targets.length} exports targets resolve, every module declared (${declared}), ` +
      'no unsubstituted dependency protocol',
  );
}

main();
