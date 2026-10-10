import { spawnSync } from 'node:child_process';
import { normalizeExpoConfig } from './metadata';
import type { ShipPlatform } from './metadata';

/**
 * Run `expo export` for the given platforms into `dist/` (relative to the
 * project). Uses `bunx expo` so the project's pinned Expo CLI is used. Throws on
 * a non-zero exit.
 */
export function runExpoExport(
  projectDir: string,
  platforms: ShipPlatform[],
  distDir: string,
): void {
  const args = ['expo', 'export', '--output-dir', distDir];
  for (const platform of platforms) {
    args.push('--platform', platform);
  }
  const result = spawnSync('bunx', args, {
    cwd: projectDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`expo export failed (exit ${result.status ?? 'unknown'})`);
  }
}

/**
 * Run `expo config --json --type public` and return the normalized public
 * ExpoConfig — used both for `runtimeVersion` resolution and the manifest's
 * `extra.expoClient` (so `Constants.expoConfig` works after an OTA update).
 */
export function readExpoPublicConfig(projectDir: string): Record<string, unknown> {
  const result = spawnSync('bunx', ['expo', 'config', '--json', '--type', 'public'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `expo config failed (exit ${result.status ?? 'unknown'}): ${(result.stderr || '').slice(0, 300)}`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error('Could not parse `expo config --json` output as JSON');
  }
  return normalizeExpoConfig(parsed);
}
