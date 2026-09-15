/**
 * Build the workspace packages a package's own `build` needs, in the order
 * given — unless Turbo is running that build.
 *
 * A package built on its own (`bun run --filter @oxy.so/core build`, a CI job,
 * a Docker stage) has nobody else to build its workspace dependencies first,
 * so its build script does it. Under `turbo run build` that work is already
 * done: every package declares these dependencies, and the `^build` edge in
 * `turbo.json` builds them before it. Repeating it there is not merely
 * redundant — several packages rebuild the same dependency at once, and one
 * build deletes `dist/` (telemetry's `clean`) while another type-checks
 * against it, failing `build:all` at random.
 *
 * Turbo sets `TURBO_HASH` in every task's environment; that is the signal.
 *
 * Lives in core's `scripts/` (not the repo root) because every Docker build
 * context that runs one of these builds copies `packages/core/` whole.
 *
 * Usage: node <path-to>/build-workspace-deps.mjs @oxy.so/contracts @oxy.so/core
 */

import { spawnSync } from 'node:child_process';

const packages = process.argv.slice(2);
if (packages.length === 0) {
  console.error('build-workspace-deps: name at least one workspace package to build');
  process.exit(2);
}

if (process.env.TURBO_HASH) {
  process.exit(0);
}

for (const name of packages) {
  const result = spawnSync('bun', ['run', '--filter', name, 'build'], { stdio: 'inherit' });
  if (result.error) {
    console.error(`build-workspace-deps: could not run the ${name} build`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
