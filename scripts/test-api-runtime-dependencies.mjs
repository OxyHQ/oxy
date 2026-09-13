import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const stage = dockerfile.split('FROM bun-node AS production-deps')[1]?.split('FROM node:24-alpine')[0];
assert.ok(stage, 'Production dependency stage must be present');
const install = stage.match(/^RUN bun (install[^\n]*?)(?:\s*\\)?$/m)?.[1]?.trim().split(/\s+/);
assert.ok(install, 'Exercise the production stage’s actual Bun install flags');
assert.ok(install.includes('--production') && install.includes('--frozen-lockfile'));

// Stay outside the checkout: an ancestor's development node_modules must never
// satisfy a missing peer. The resolution assertion also rejects that fallback.
const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const fixture = mkdtempSync(join(cache, 'oxy-runtime-closure-'));
try {
  for (const file of ['package.json', 'bun.lock']) copyFileSync(join(root, file), join(fixture, file));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces.packages;
  for (const workspace of workspaces) {
    assert.ok(!workspace.includes('*'), 'Fixture must expand a newly introduced workspace glob');
    mkdirSync(join(fixture, workspace), { recursive: true });
    copyFileSync(join(root, workspace, 'package.json'), join(fixture, workspace, 'package.json'));
  }
  // Native build hooks are unrelated to JS resolution and are not run in this
  // portable fixture. The final Docker image separately loads Sharp and the
  // complete compiled migration entrypoint on its target architecture.
  execFileSync('bun', [...install, '--ignore-scripts'], { cwd: fixture, stdio: 'inherit', timeout: 600_000 });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const { join } = require('node:path');
    const root = process.cwd();
    const load = createRequire(join(root, 'packages/db/package.json'));
    const manifest = load('./package.json');
    const required = Object.keys(manifest.peerDependencies).filter(name => !manifest.peerDependenciesMeta?.[name]?.optional);
    assert.ok(required.includes('postgres') && required.includes('drizzle-orm'));
    for (const dependency of required) {
      assert.ok(load.resolve(dependency).startsWith(root + '/'), 'Peer escaped production graph: ' + dependency);
      load(dependency);
    }
    console.log('Required database peers load from the frozen production graph without connecting.');
  `], { cwd: fixture, stdio: 'inherit', timeout: 30_000 });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
