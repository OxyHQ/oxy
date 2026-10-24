/**
 * Refuse to put a workspace package's build output into a RELEASE bundle when
 * it was not built from the sources the checkout holds.
 *
 * An app in this monorepo consumes `@oxy.so/core`, `@oxy.so/contracts`,
 * `@oxy.so/protocol`, `@oxy.so/telemetry` and `@oxy.so/expo-splash` through
 * their BUILT entry points (`dist/`), which nothing rebuilds when the checkout
 * moves. Measured on Commons 1.3.0 (2026-10-25): the checkout was at the
 * release commit but its `packages/contracts/dist` dated from five days
 * earlier, written for Zod 3. `app/+native-intent.ts` imported
 * `@oxy.so/contracts`, expo-router loads that file while it builds the linking
 * config, and the stale `oauth.js` called `catalogToolSchema.innerType()` at
 * module scope against Zod 4: `TypeError: undefined is not a function` on every
 * launch. The bundle also carried a core from before the commit's own
 * KeyManager changes. Nothing failed at build time; a phone found it.
 *
 * A package that opts in (`"oxySourceStamp": "dist"`, see `source-stamp.js`)
 * writes a digest of its `src/` into its output at the end of every build. A
 * release bundle (Metro `dev: false`, or NODE_ENV=production) that reaches that
 * output fails when the stamp is missing or does not match the sources, naming
 * the command that rebuilds it; a development bundle warns once. A package that
 * does not opt in is only compared by mtime, and only ever warned about: an
 * mtime cannot tell a checkout round trip from an edit.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readStamp, sourceDigest, stampedOutputDir } = require('./source-stamp');

const OUTPUT_DIRS = new Set(['dist', 'lib', 'build']);
const IGNORED =
  /(?:^|[/\\])(?:__tests__|__mocks__)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.md$/;

function newestMtime(dir, ignore) {
  let newest = 0;
  let newestFile = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (ignore?.test(full)) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(full);
      } else if (entry.isFile()) {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newest) {
          newest = mtimeMs;
          newestFile = full;
        }
      }
    }
  }
  return { newest, newestFile };
}

/**
 * Whether `packageDir/outputDir` was built from `packageDir/src` as it is now.
 * `null` when it was (or there is nothing to compare); otherwise
 * `{ stamped, reason }`, where `stamped` says the verdict is exact (a source
 * stamp) rather than an mtime guess.
 */
function staleBuild(packageDir, outputDir) {
  const srcDir = path.join(packageDir, 'src');
  const outDir = path.join(packageDir, outputDir);
  if (!fs.existsSync(srcDir) || !fs.existsSync(outDir)) return null;

  if (stampedOutputDir(packageDir) === outputDir) {
    const stamp = readStamp(packageDir, outputDir);
    if (stamp === null) {
      return {
        stamped: true,
        reason: `${outputDir}/ carries no source stamp (built before stamping)`,
      };
    }
    if (stamp !== sourceDigest(packageDir)) {
      return { stamped: true, reason: `src/ changed since ${outputDir}/ was built` };
    }
    return null;
  }

  const source = newestMtime(srcDir, IGNORED);
  const output = newestMtime(outDir, null);
  if (source.newest > output.newest) {
    return {
      stamped: false,
      reason: `${path.relative(packageDir, source.newestFile)} is newer than ${outputDir}/`,
    };
  }
  return null;
}

/**
 * @param {import('metro-config').MetroConfig} config
 * @param {string} monorepoRoot
 * @param {{ production?: boolean, warn?: (message: string) => void }} [deps] Test seams.
 * @returns {import('metro-config').MetroConfig}
 */
function withFreshWorkspaceBuilds(config, monorepoRoot, deps = {}) {
  // A release bundle: Metro's own `dev: false` (what `expo export:embed` in the
  // Gradle/Xcode release task passes), or NODE_ENV=production.
  const isProduction = (context) =>
    deps.production ?? (context.dev === false || process.env.NODE_ENV === 'production');
  const warn = deps.warn ?? ((message) => console.warn(message));
  const packagesDir = `${path.resolve(monorepoRoot, 'packages')}${path.sep}`;
  const parentResolveRequest = config.resolver.resolveRequest;
  const verdicts = new Map();
  const warned = new Set();

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolution = (parentResolveRequest ?? context.resolveRequest)(
      context,
      moduleName,
      platform,
    );
    if (resolution?.type !== 'sourceFile') return resolution;
    let filePath = resolution.filePath;
    try {
      filePath = fs.realpathSync(filePath);
    } catch {
      return resolution;
    }
    if (!filePath.startsWith(packagesDir)) return resolution;
    const [packageName, outputDir] = filePath.slice(packagesDir.length).split(path.sep);
    if (!packageName || !OUTPUT_DIRS.has(outputDir)) return resolution;

    const key = `${packageName}/${outputDir}`;
    if (!verdicts.has(key)) {
      verdicts.set(key, staleBuild(path.join(packagesDir, packageName), outputDir));
    }
    const stale = verdicts.get(key);
    if (!stale) return resolution;

    const rebuild = `bunx turbo run build --filter=./packages/${packageName}`;
    if (stale.stamped && isProduction(context)) {
      throw new Error(
        `[@oxy.so/app-preset/metro] refusing to bundle packages/${key}: ${stale.reason}. ` +
          'A release would ship code this checkout does not contain. Run ' +
          `\`${rebuild}\` (or \`bun run build:all\`) at the repository root, then build again.`,
      );
    }
    if (!warned.has(key)) {
      warned.add(key);
      warn(
        `[@oxy.so/app-preset/metro] packages/${key} may be out of date: ${stale.reason}; ` +
          `run \`${rebuild}\`.`,
      );
    }
    return resolution;
  };

  return config;
}

module.exports = { withFreshWorkspaceBuilds, staleBuild };
