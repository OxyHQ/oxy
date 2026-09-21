#!/usr/bin/env node
/**
 * Asserts that every `@oxy.so/*` range a GENERATED app names resolves to a real
 * version on the public registry.
 *
 * Why this exists as a step of its own: `scaffold-smoke` installs the generated
 * app with each Oxy dependency OVERRIDDEN by a tarball packed from HEAD, which is
 * deliberate (a release may be unpublished at HEAD) but means the smoke install
 * never exercises the ranges the scaffolder actually ships. `oxyCore` sat at a
 * pre-rename `^23.3.0` behind that blind spot: an E404, repeated into the
 * generated root `package.json`'s `overrides` AND `resolutions`, so no generated
 * app could `bun install` at all — and every CI signal was green.
 *
 * Usage: node assert-oxy-ranges-resolve.mjs <generated-app-dir>
 *
 * Reads every `package.json` in the tree (node_modules excluded) and checks
 * `dependencies`, `devDependencies`, `peerDependencies`, `overrides` and
 * `resolutions`. A registry that cannot be reached fails the run too: a gate that
 * passes when it could not check is not a gate.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'overrides', 'resolutions'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.expo', 'android', 'ios']);
const ATTEMPTS = 3;

/** Every package.json under `dir`, skipping installed/generated trees. */
function findManifests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...findManifests(path.join(dir, entry.name)));
    } else if (entry.name === 'package.json') {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** `{ "@oxy.so/core@^1.7.1": ["package.json#overrides", …] }` across the tree. */
function collectOxyRanges(appDir) {
  const specs = new Map();
  for (const manifestPath of findManifests(appDir)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const field of MANIFEST_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!name.startsWith('@oxy.so/') || typeof range !== 'string') continue;
        // `file:`/`link:`/`workspace:` are not registry ranges; nothing to resolve.
        if (/^(file|link|workspace|npm|git\+|https?):/.test(range)) continue;
        const spec = `${name}@${range}`;
        const where = `${path.relative(appDir, manifestPath)}#${field}`;
        specs.set(spec, [...(specs.get(spec) ?? []), where]);
      }
    }
  }
  return specs;
}

/**
 * Resolves one `name@range` against the registry. Returns the matched version.
 * An E404 (the range matches nothing published) fails immediately; anything else
 * is treated as transient and retried before failing.
 */
async function resolve(spec) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('npm', ['view', spec, 'version'], { encoding: 'utf8' });
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) throw new Error(`E404 npm view printed no version for ${spec}`);
      // A multi-version match prints `<name>@<version> '<version>'` per line; a
      // single match prints the bare version.
      const last = lines[lines.length - 1];
      return last.includes("'") ? last.split("'")[1] : last;
    } catch (error) {
      const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}${error?.message ?? ''}`;
      if (detail.includes('E404')) {
        throw new Error(`${spec} matches NO published version (E404)`);
      }
      if (attempt === ATTEMPTS) {
        throw new Error(`could not reach the registry for ${spec}: ${detail.trim().split('\n')[0]}`);
      }
      await new Promise((done) => setTimeout(done, attempt * 3000));
    }
  }
  throw new Error(`unreachable: ${spec}`);
}

async function main() {
  const appDir = path.resolve(process.argv[2] ?? '.');
  if (!statSync(appDir).isDirectory()) throw new Error(`not a directory: ${appDir}`);

  const specs = collectOxyRanges(appDir);
  if (specs.size === 0) {
    console.error(`::error::no @oxy.so ranges found under ${appDir} — the scaffold did not render, or this is the wrong directory`);
    process.exit(1);
  }

  const failures = [];
  for (const [spec, sites] of specs) {
    try {
      const version = await resolve(spec);
      console.log(`ok  ${spec} -> ${version}   (${sites.join(', ')})`);
    } catch (error) {
      failures.push(`${error.message}   named by ${sites.join(', ')}`);
      console.log(`FAIL ${spec}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${failure}`);
    console.error(
      `::error::${failures.length} generated range(s) do not resolve on the public registry — a scaffolded app cannot install. Fix packages/create-oxy-app/src/versions.ts.`,
    );
    process.exit(1);
  }

  console.log(`all ${specs.size} generated @oxy.so ranges resolve on the public registry`);
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});
