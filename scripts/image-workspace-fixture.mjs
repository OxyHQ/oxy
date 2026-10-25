/** Isolated replicas of the Docker manifest, validator-build and runtime inputs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function prepareWorkspaceManifests(root, destination) {
  mkdirSync(destination, { recursive: true });
  for (const file of ['package.json', 'bun.lock'])
    copyFileSync(join(root, file), join(destination, file));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const patch of Object.values(manifest.patchedDependencies ?? {})) {
    assert.ok(typeof patch === 'string' && patch.startsWith('patches/') && !patch.includes('..'));
    mkdirSync(dirname(join(destination, patch)), { recursive: true });
    copyFileSync(join(root, patch), join(destination, patch));
  }
  for (const dependency of ['@expo/cli', '@expo/code-signing-certificates']) {
    const specifier = manifest.overrides[dependency];
    assert.match(specifier, /^file:\.\/vendor\/expo-native\/oxy\.so-[A-Za-z0-9.+-]+\.tgz$/);
    const file = specifier.slice('file:./'.length);
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    copyFileSync(join(root, file), join(destination, file));
  }
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces.packages;
  for (const workspace of workspaces) {
    assert.ok(!workspace.includes('*'), 'Fixture must expand a newly introduced workspace glob');
    mkdirSync(join(destination, workspace), { recursive: true });
    copyFileSync(
      join(root, workspace, 'package.json'),
      join(destination, workspace, 'package.json'),
    );
  }
}

export function buildRuntimeValidators(root, builder, names = ['zod3', 'zod4']) {
  // Check the actual filtered install, not an ancestor development dependency.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  mkdirSync(join(builder, 'scripts'), { recursive: true });
  for (const name of ['build-zod-fork.mjs', 'check-zod-forks.mjs', 'prepare-api-workspaces.mjs'])
    copyFileSync(join(root, 'scripts', name), join(builder, 'scripts', name));
  for (const name of names) {
    const directory = join(builder, 'packages', name);
    const load = createRequire(join(directory, 'package.json'));
    const compiler = load.resolve('zshy');
    assert.ok(compiler.startsWith(`${builder}/`), 'Validator compiler escaped filtered builder');
    assert.equal(
      JSON.parse(readFileSync(join(dirname(dirname(compiler)), 'package.json'), 'utf8')).version,
      manifest.workspaces.catalog.zshy,
    );
    // The Docker context excludes generated source/runtime. Start from exactly
    // the committed source inputs so host builds cannot satisfy this test.
    for (const input of ['LICENSE', 'NOTICE', 'tsconfig.build.json', 'upstream', 'patches'])
      cpSync(join(root, 'packages', name, input), join(directory, input), { recursive: true });
    execFileSync('bun', ['run', '--filter', `@oxy.so/${name}`, 'build'], {
      cwd: builder,
      stdio: 'inherit',
      timeout: 300_000,
    });
  }
}

export function stageRuntimeValidators(builder, runtime, names = ['zod3', 'zod4']) {
  execFileSync(
    process.execPath,
    ['scripts/prepare-api-workspaces.mjs', join(runtime, 'packages'), ...names],
    {
      cwd: builder,
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
  mkdirSync(join(runtime, 'scripts'), { recursive: true });
  copyFileSync(
    join(builder, 'scripts/check-zod-forks.mjs'),
    join(runtime, 'scripts/check-zod-forks.mjs'),
  );
}

export function verifyRuntimeValidators(runtime, names = ['zod3', 'zod4']) {
  const load = createRequire(join(runtime, 'package.json'));
  assert.throws(
    () => load.resolve('zshy'),
    { code: 'MODULE_NOT_FOUND' },
    'The production graph must not contain the validator compiler',
  );
  // Exercise the exact final-image command on Bun, including source exports.
  execFileSync('bun', ['scripts/check-zod-forks.mjs', '--installation', ...names], {
    cwd: runtime,
    stdio: 'inherit',
    timeout: 300_000,
  });
}
