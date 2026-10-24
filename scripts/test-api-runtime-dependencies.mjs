import assert from 'node:assert/strict';
import { inventory } from './forge-remediation-proof-proposal.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  inspectImage,
  readDeclaredNativePackageInventory,
} from './native-expo-image-inventory.mjs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  prepareWorkspaceManifests,
  buildRuntimeValidators,
  stageRuntimeValidators,
  verifyRuntimeValidators,
} from './image-workspace-fixture.mjs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
for (const file of ['Dockerfile', 'packages/node/Dockerfile']) {
  const source = readFileSync(join(root, file), 'utf8');
  const builder = source.split(/FROM [^\n]+ AS builder\n/)[1]?.split('\nFROM ')[0];
  assert.match(builder ?? '', /^RUN apk add --no-cache git$/m, `${file} builder needs git apply`);
}
const stage = dockerfile
  .split('FROM bun-node AS production-deps')[1]
  // Up to the next stage (the Bun runtime image), whatever its base.
  ?.split('\nFROM ')[0];
assert.ok(stage, 'Production dependency stage must be present');
const install = stage
  .match(/^RUN bun (install[^\n]*?)(?:\s*\\)?$/m)?.[1]
  ?.trim()
  .split(/\s+/);
assert.ok(install, 'Exercise the production stage’s actual Bun install flags');
assert.ok(install.includes('--production') && install.includes('--frozen-lockfile'));

// Stay outside the checkout: an ancestor's development node_modules must never
// satisfy a missing peer. The resolution assertion also rejects that fallback.
const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(join(cache, 'oxy-runtime-closure-'));
const fixture = join(temporary, 'api-runtime');
try {
  const builder = join(temporary, 'builder');
  prepareWorkspaceManifests(root, builder);
  const builderStage = dockerfile.split('FROM bun-node AS builder')[1]?.split('\nFROM ')[0];
  const builderInstall = builderStage
    ?.match(/^RUN bun (install[^\n]*?)(?:\s*\\)?$/m)?.[1]
    ?.trim()
    .split(/\s+/);
  assert.ok(
    builderInstall?.includes('--frozen-lockfile'),
    'Exercise the real filtered builder install',
  );
  execFileSync('bun', [...builderInstall, '--ignore-scripts'], {
    cwd: builder,
    stdio: 'inherit',
    timeout: 600_000,
  });
  buildRuntimeValidators(root, builder);
  prepareWorkspaceManifests(root, fixture);
  // Native build hooks are unrelated to JS resolution and are not run in this
  // portable fixture. The final Docker image separately loads Sharp and the
  // complete compiled migration entrypoint on its target architecture.
  execFileSync('bun', [...install, '--ignore-scripts'], {
    cwd: fixture,
    stdio: 'inherit',
    timeout: 600_000,
  });
  stageRuntimeValidators(builder, fixture);
  verifyRuntimeValidators(fixture);
  // Loading the real MCP SDK also traverses zod-to-json-schema's peer import.
  // A parser census alone cannot prove that a consumer can resolve its peer.
  execFileSync(
    'bun',
    [
      '-e',
      `
    const r = require('node:module').createRequire(process.cwd() + '/packages/mcp/package.json');
    const { McpServer } = r('@modelcontextprotocol/sdk/server/mcp.js');
    if (typeof McpServer !== 'function') throw new Error('MCP server runtime did not load');
  `,
    ],
    { cwd: fixture, stdio: 'inherit', timeout: 30_000 },
  );
  execFileSync(
    process.execPath,
    [
      '-e',
      `
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
  `,
    ],
    { cwd: fixture, stdio: 'inherit', timeout: 30_000 },
  );
  assert.equal(
    inventory(fixture).length,
    0,
    'The actual production graph must contain no Forge copies',
  );
  const expected = readDeclaredNativePackageInventory(root);
  const packages = inspectImage(fixture, expected);
  const adapter = packages.find((pkg) => pkg.name === '@oxy.so/expo-code-signing-native');
  assert.ok(
    adapter.root.startsWith(`${fixture}/`),
    'Native package escaped isolated production graph',
  );
  // The API only uses this API in tests (a devDependency); production deliberately
  // has no API alias. Exercise the physically present, byte-verified package.
  execFileSync(
    process.execPath,
    [
      join(root, 'scripts/forge-independent-expo-compat.cjs'),
      join(fixture, 'packages/api'),
      join(adapter.root, 'index.cjs'),
    ],
    { cwd: fixture, stdio: 'inherit', timeout: 30_000 },
  );
  const nodeDockerfile = readFileSync(join(root, 'packages/node/Dockerfile'), 'utf8');
  const nodeRuntime = nodeDockerfile.split('FROM oven/bun:').at(-1);
  const nodeInstall = nodeRuntime
    .match(/^RUN bun (install[^\n]*?)(?:\s*\\)?$/m)?.[1]
    ?.trim()
    .split(/\s+/);
  assert.ok(
    nodeInstall?.includes('--production') && nodeInstall.includes('--frozen-lockfile'),
    'The data-node production graph must be frozen and scoped',
  );
  const nodeFixture = join(temporary, 'node-runtime');
  prepareWorkspaceManifests(root, nodeFixture);
  execFileSync('bun', [...nodeInstall, '--ignore-scripts'], {
    cwd: nodeFixture,
    stdio: 'inherit',
    timeout: 600_000,
  });
  stageRuntimeValidators(builder, nodeFixture);
  verifyRuntimeValidators(nodeFixture);
  console.log(
    'Forge absent; sealed native API/CLI production bytes and installed Expo compatibility verified.',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
