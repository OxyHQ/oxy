/**
 * The build identity `@oxy.so/services` busts every persisted query cache on
 * (`getOxyBuildId`): a cache written by an older bundle, in an older shape, is
 * never served to a newer one.
 *
 * The commit in CI, `git rev-parse HEAD` locally, and a constant in development
 * so the dev transform cache survives commits. Metro's config resolves it
 * first and publishes it as `OXY_BUILD_ID`, so the Babel workers it forks read
 * the same value.
 */
const { execFileSync } = require('child_process');

function resolveOxyBuildId(projectRoot = process.cwd()) {
  if (process.env.OXY_BUILD_ID) return process.env.OXY_BUILD_ID;
  if (process.env.NODE_ENV !== 'production') return 'development';
  const ciCommit = process.env.GITHUB_SHA || process.env.EAS_BUILD_GIT_COMMIT_HASH;
  if (ciCommit) return ciCommit;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return `time-${Date.now()}`;
  }
}

module.exports = { resolveOxyBuildId };
