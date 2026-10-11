import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ResolvedConfig } from '../context';

/**
 * Runs `bun install` in the generated project. Non-fatal: on failure the user is
 * told to install manually, and the scaffold still succeeds.
 * @returns whether dependencies were installed.
 */
export function installDeps(config: ResolvedConfig): boolean {
  if (!config.install) {
    return false;
  }

  const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  if (bunCheck.status !== 0) {
    p.log.warn(
      pc.yellow('bun is not available — skipping install. Install bun, then run `bun install`.'),
    );
    return false;
  }

  const spinner = p.spinner();
  spinner.start('Installing dependencies with bun…');
  const result = spawnSync('bun', ['install'], { cwd: config.targetDir, stdio: 'ignore' });
  if (result.status === 0) {
    spinner.stop('Dependencies installed.');
    return true;
  }

  spinner.stop(pc.yellow('`bun install` failed — run it manually in the project directory.'));
  return false;
}
