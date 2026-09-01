#!/usr/bin/env node
/**
 * Block publishes that bypass Bun's workspace: protocol substitution.
 *
 * @oxyhq/core@12.10.1 was broken because `npm publish` left literal
 * `workspace:^` strings in the published manifest. `bun publish` substitutes
 * them to real semver ranges before packing.
 *
 * The same now applies to `catalog:`, and this guard is what makes the catalog
 * safe to use in a PUBLISHED package: measured on bun 1.3.14, `bun pm pack`
 * rewrites a catalogued dependency to the catalog's own range (`^2.1.3` stayed
 * `^2.1.3`) while `npm pack` shipped the literal string `catalog:`, which no
 * consumer can resolve — the identical failure mode, one protocol later.
 *
 * Wired into publishable packages' prepublishOnly scripts.
 */

const userAgent = process.env.npm_config_user_agent ?? '';
const execPath = process.env.npm_execpath ?? '';

const viaBun =
  userAgent.includes('bun/') ||
  execPath.includes('bun') ||
  process.env.BUN_PUBLISH === '1';

if (!viaBun) {
  console.error(
    'Publish blocked: use `bun publish` from the package directory (not `npm publish`).\n' +
      'npm does not substitute workspace: protocol and will ship broken dependency ranges.\n' +
      `Detected user agent: ${userAgent || '(empty)'}`,
  );
  process.exit(1);
}
