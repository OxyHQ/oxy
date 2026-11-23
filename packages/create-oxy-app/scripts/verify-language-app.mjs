#!/usr/bin/env node
/**
 * Scaffolds a language app (`--language`), installs it and runs its own gates:
 * the frontend's `typecheck` (tsc) and `test` (Jest through the Bloom language
 * compiler).
 *
 * Usage: node scripts/verify-language-app.mjs <app-dir> [packs-dir]
 *
 * Run `bun run build` first: the app is scaffolded by `dist/index.js`. With a
 * packs directory, every `@oxy.so/*` tarball in it (`oxy.so-<name>-<version>.tgz`,
 * from `npm pack` or `bun pm pack`) replaces that package over the whole tree,
 * through the root `overrides` and `resolutions`, as the scaffold smoke does
 * with HEAD packs; without one the app installs from npm. Packs are how the
 * template is proved before its packages are released (`pending-releases.mjs`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [appArg, packsArg] = process.argv.slice(2);
if (!appArg) {
  console.error('usage: node scripts/verify-language-app.mjs <app-dir> [packs-dir]');
  process.exit(2);
}
const appDir = path.resolve(appArg);
if (existsSync(appDir)) {
  console.error(`${appDir} already exists`);
  process.exit(2);
}
const cli = path.join(import.meta.dirname, '..', 'dist', 'index.js');

/** Runs a command, streaming its output; a failure ends the run. */
function run(command, args, cwd) {
  console.log(`\n$ ${[command, ...args].join(' ')}   (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

run(
  'node',
  [cli, appDir, '--yes', '--language', '--no-register', '--no-git', '--no-install'],
  process.cwd(),
);

if (packsArg) {
  const packsDir = path.resolve(packsArg);
  const packs = {};
  for (const file of readdirSync(packsDir)) {
    const match = /^oxy\.so-(.+)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/.exec(file);
    if (match) packs[`@oxy.so/${match[1]}`] = `file:${path.join(packsDir, file)}`;
  }
  if (Object.keys(packs).length === 0) throw new Error(`no @oxy.so packs in ${packsDir}`);
  const manifestPath = path.join(appDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.overrides = { ...manifest.overrides, ...packs };
  manifest.resolutions = { ...manifest.resolutions, ...packs };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\noverriding ${Object.keys(packs).join(', ')} with packs from ${packsDir}`);
}

run('bun', ['install'], appDir);
const frontend = path.join(appDir, 'packages', 'frontend');
run('bun', ['run', 'typecheck'], frontend);
run('bun', ['run', 'test'], frontend);
console.log('\nthe language app installs, typechecks and passes its tests');
