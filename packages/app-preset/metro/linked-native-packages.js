/**
 * Keep native packages the build does not link out of the bundle's OPTIONAL
 * requires.
 *
 * An optional require (`try { require('x') } catch {}`, an `import()` in a
 * `try`) is how libraries probe for an optional peer: expo-router probes for
 * `@expo/ui`, @oxy.so/protocol for `expo-crypto`, @oxy.so/services for
 * `expo-clipboard`. Metro resolves the probe against whatever is on disk. Expo
 * autolinking decides what native code the binary carries by a different rule:
 * the app's dependencies and devDependencies, then, recursively, each
 * package's dependencies and NON-optional peers. When the two disagree, the JS
 * of a package whose native half is not in the binary is bundled, the probe
 * succeeds, and that JS runs against native code that is not there.
 *
 * Measured on Commons 1.3.0 (2026-10-25): a checkout's bun store kept a stale
 * `node_modules/.bun/node_modules/@expo/ui` (@expo/ui 57.0.17, from an old
 * install, absent from bun.lock). Node's resolution walks up into that hoisted
 * fallback, so expo-router's `@expo/ui/jetpack-compose` probe found it, the
 * SDK 57 JS ran its side effects against an SDK 58 binary that never linked
 * it, and the release crashed on launch (`Exception in HostFunction:
 * ... getClass() on a null object reference`, then `TypeError: undefined is not
 * a function`). A clean install has no such file and the same commit ran.
 *
 * So an optional request that resolves into a native package autolinking will
 * not link is answered "not found", which is what the probe sees on a clean
 * install: the library takes its documented fallback. Non-optional requests
 * are left alone (a static import of an unlinked native package is reported
 * once as a warning, not turned into a build failure), so this never changes
 * what an app that builds today bundles, except for those probes.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

/** Expo autolinking's own recursion limit (`resolution.js` MAX_DEPTH). */
const MAX_DEPTH = 9;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isOptionalPeer(manifest, name) {
  const meta = manifest.peerDependenciesMeta;
  return Boolean(meta?.[name]?.optional);
}

/**
 * The names Expo autolinking links for the app at `projectRoot`, computed by
 * the rules of expo-modules-autolinking 58 (`dependencies/resolution.js`): the
 * app's dependencies + devDependencies, then each package's dependencies and
 * non-optional peers, resolved through the node_modules chain of the package
 * that declares them, to depth {@link MAX_DEPTH}.
 *
 * @param {string} projectRoot
 * @returns {Set<string>}
 */
function computeLinkedPackageNames(projectRoot) {
  const linked = new Set();
  const shallowestDepth = new Map();

  const visit = (packageDir, depth) => {
    const seen = shallowestDepth.get(packageDir);
    if (seen !== undefined && seen <= depth) return;
    shallowestDepth.set(packageDir, depth);
    const manifest = readJson(path.join(packageDir, 'package.json'));
    if (!manifest || depth >= MAX_DEPTH) return;

    const names = new Set(Object.keys(manifest.dependencies || {}));
    if (depth === 0) {
      for (const name of Object.keys(manifest.devDependencies || {})) names.add(name);
    }
    for (const name of Object.keys(manifest.peerDependencies || {})) {
      if (!isOptionalPeer(manifest, name)) names.add(name);
    }

    const lookupDirs = Module._nodeModulePaths(packageDir);
    for (const name of names) {
      for (const dir of lookupDirs) {
        const resolved = realpathOrNull(path.join(dir, name));
        if (resolved) {
          linked.add(name);
          visit(resolved, depth + 1);
          break;
        }
      }
    }
  };

  const root = realpathOrNull(projectRoot);
  if (root) visit(root, 0);
  return linked;
}

/**
 * The package a file belongs to: the nearest ancestor `package.json` that has
 * a `name` (a nested `{"type":"module"}` manifest has none and is skipped).
 */
function createPackageLookup() {
  const cache = new Map();
  return function packageOf(filePath) {
    let dir = path.dirname(filePath);
    const visited = [];
    let found = null;
    for (;;) {
      if (cache.has(dir)) {
        found = cache.get(dir);
        break;
      }
      visited.push(dir);
      const manifest = readJson(path.join(dir, 'package.json'));
      if (manifest && typeof manifest.name === 'string') {
        found = { name: manifest.name, version: manifest.version, dir };
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const entry of visited) cache.set(entry, found);
    return found;
  };
}

/** True when a package carries native code autolinking would have to link. */
function createNativeCheck() {
  const cache = new Map();
  return function isNativePackage(pkg) {
    if (!cache.has(pkg.dir)) {
      cache.set(
        pkg.dir,
        fs.existsSync(path.join(pkg.dir, 'expo-module.config.json')) ||
          fs.existsSync(path.join(pkg.dir, 'android', 'build.gradle')) ||
          fs.existsSync(path.join(pkg.dir, 'android', 'build.gradle.kts')),
      );
    }
    return cache.get(pkg.dir);
  };
}

/**
 * Wrap `config.resolver.resolveRequest` so an OPTIONAL request on a native
 * platform that resolves into a native package autolinking does not link
 * throws, which Metro records as a missing optional dependency.
 *
 * @param {import('metro-config').MetroConfig} config
 * @param {string} projectRoot
 * @param {{ computeLinked?: (projectRoot: string) => Set<string>, warn?: (message: string) => void }} [deps]
 *   Test seams.
 * @returns {import('metro-config').MetroConfig}
 */
function withLinkedNativePackagesOnly(config, projectRoot, deps = {}) {
  const computeLinked = deps.computeLinked ?? computeLinkedPackageNames;
  const warn = deps.warn ?? ((message) => console.warn(message));
  const parentResolveRequest = config.resolver.resolveRequest;
  const packageOf = createPackageLookup();
  const isNativePackage = createNativeCheck();
  const reported = new Set();
  let linked = null;

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolution = (parentResolveRequest ?? context.resolveRequest)(
      context,
      moduleName,
      platform,
    );
    if (platform === 'web' || resolution?.type !== 'sourceFile') return resolution;
    const pkg = packageOf(resolution.filePath);
    if (!pkg || !isNativePackage(pkg)) return resolution;
    linked ??= computeLinked(projectRoot);
    if (linked.has(pkg.name)) return resolution;

    const optional = context.dependency?.data?.isOptional === true;
    const key = `${pkg.name}@${pkg.version}`;
    if (optional) {
      if (!reported.has(`optional:${key}`)) {
        reported.add(`optional:${key}`);
        warn(
          `[@oxy.so/app-preset/metro] left ${key} out of an optional require ` +
            `('${moduleName}'): it has native code this build does not autolink ` +
            '(not a dependency of the app, nor a non-optional dependency of one). ' +
            `Found at ${pkg.dir}.`,
        );
      }
      throw new Error(
        `${moduleName} resolves to ${key}, a native package this build does not link`,
      );
    }
    if (!reported.has(`static:${key}`)) {
      reported.add(`static:${key}`);
      warn(
        `[@oxy.so/app-preset/metro] ${key} is bundled ('${moduleName}') but has native code ` +
          'this build does not autolink; declare it as a dependency of the app.',
      );
    }
    return resolution;
  };

  return config;
}

module.exports = { withLinkedNativePackagesOnly, computeLinkedPackageNames };
