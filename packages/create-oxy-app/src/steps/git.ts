import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ResolvedConfig } from '../context';

function run(cwd: string, args: string[]): boolean {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Initializes a git repo and records an initial commit. Non-fatal: if git is
 * unavailable or any step fails, the scaffold continues without version control.
 */
export function initGit(config: ResolvedConfig): void {
  if (!config.git) {
    return;
  }

  const gitCheck = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (gitCheck.status !== 0) {
    p.log.warn(pc.yellow('git is not available — skipping repository initialization.'));
    return;
  }

  const ok =
    run(config.targetDir, ['init', '-q']) &&
    run(config.targetDir, ['add', '-A']) &&
    run(config.targetDir, ['commit', '-q', '-m', 'Initial commit from create-oxy-app']);

  if (!ok) {
    p.log.warn(
      pc.yellow('Could not create the initial git commit — initialize the repo manually.'),
    );
  }
}
