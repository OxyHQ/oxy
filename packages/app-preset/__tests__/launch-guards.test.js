/**
 * The two Metro guards added after Commons 1.3.0 crashed on launch: a stale
 * `@expo/ui` (an unlinked native package) reached through an optional probe,
 * and workspace build output older than its sources.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  withLinkedNativePackagesOnly,
  computeLinkedPackageNames,
} = require('../metro/linked-native-packages');
const { withFreshWorkspaceBuilds, staleBuild } = require('../metro/fresh-workspace-builds');
const { STAMP_FILE, writeStamp } = require('../metro/source-stamp');

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function setMtime(file, ms) {
  const date = new Date(ms);
  fs.utimesSync(file, date, date);
}

/** A monorepo: an app, a router with an OPTIONAL native peer, a linked native dep. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-launch-guards-'));
  const nm = path.join(root, 'node_modules');
  write(path.join(root, 'apps/app/package.json'), {
    name: 'app',
    dependencies: { router: '1.0.0', 'linked-native': '1.0.0' },
  });
  write(path.join(nm, 'router/package.json'), {
    name: 'router',
    version: '1.0.0',
    dependencies: { 'router-native-dep': '1.0.0' },
    peerDependencies: { 'optional-native': '*', 'required-native': '*' },
    peerDependenciesMeta: { 'optional-native': { optional: true } },
  });
  write(path.join(nm, 'router/build/probe.js'), '');
  for (const name of ['optional-native', 'required-native', 'linked-native', 'router-native-dep']) {
    write(path.join(nm, name, 'package.json'), { name, version: '57.0.17' });
    write(path.join(nm, name, 'expo-module.config.json'), {});
    write(path.join(nm, name, 'index.js'), '');
  }
  write(path.join(nm, 'plain-js/package.json'), { name: 'plain-js', version: '1.0.0' });
  write(path.join(nm, 'plain-js/index.js'), '');
  return { root, nm, app: path.join(root, 'apps/app') };
}

function resolverOver(config) {
  return (moduleName, { optional, origin }) =>
    config.resolver.resolveRequest(
      { originModulePath: origin, dependency: { data: { isOptional: optional } } },
      moduleName,
      'android',
    );
}

test('autolinking closure: app deps, their deps and non-optional peers; never optional peers', () => {
  const { app } = makeRepo();
  const linked = computeLinkedPackageNames(app);
  assert.ok(linked.has('router'));
  assert.ok(linked.has('linked-native'));
  assert.ok(linked.has('router-native-dep'));
  assert.ok(linked.has('required-native'));
  assert.ok(!linked.has('optional-native'));
});

test('an optional probe that lands on an unlinked native package is answered "not found"', () => {
  const { nm, app } = makeRepo();
  const warnings = [];
  const config = {
    resolver: {
      resolveRequest: (_context, moduleName) => ({
        type: 'sourceFile',
        filePath: path.join(nm, moduleName, 'index.js'),
      }),
    },
  };
  withLinkedNativePackagesOnly(config, app, { warn: (message) => warnings.push(message) });
  const resolve = resolverOver(config);
  const origin = path.join(nm, 'router/build/probe.js');

  // Optional + unlinked native: refused, so Metro records the optional dep as missing.
  assert.throws(
    () => resolve('optional-native', { optional: true, origin }),
    /optional-native@57\.0\.17, a native package this build does not link/,
  );
  // Linked natives, plain JS and static imports resolve exactly as before.
  assert.equal(resolve('linked-native', { optional: true, origin }).type, 'sourceFile');
  assert.equal(resolve('required-native', { optional: true, origin }).type, 'sourceFile');
  assert.equal(resolve('plain-js', { optional: true, origin }).type, 'sourceFile');
  assert.equal(resolve('optional-native', { optional: false, origin }).type, 'sourceFile');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /left optional-native@57\.0\.17 out of an optional require/);
  assert.match(warnings[1], /is bundled .* does not autolink/);
});

test('web resolutions are never touched', () => {
  const { nm, app } = makeRepo();
  const config = {
    resolver: {
      resolveRequest: (_context, moduleName) => ({
        type: 'sourceFile',
        filePath: path.join(nm, moduleName, 'index.js'),
      }),
    },
  };
  withLinkedNativePackagesOnly(config, app, { warn: () => {} });
  const resolution = config.resolver.resolveRequest(
    { originModulePath: app, dependency: { data: { isOptional: true } } },
    'optional-native',
    'web',
  );
  assert.equal(resolution.type, 'sourceFile');
});

/** packages/core, opted into source stamps, built once. */
function makeWorkspace({ stamped = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-fresh-builds-'));
  const pkg = path.join(root, 'packages/core');
  write(path.join(pkg, 'package.json'), {
    name: '@oxy.so/core',
    ...(stamped ? { oxySourceStamp: 'dist' } : {}),
  });
  write(path.join(pkg, 'src/index.ts'), 'export const a = 1;');
  write(path.join(pkg, 'src/__tests__/index.test.ts'), '');
  write(path.join(pkg, 'dist/esm/index.js'), 'export const a = 1;');
  if (stamped) writeStamp(pkg);
  return { root, pkg, entry: path.join(pkg, 'dist/esm/index.js') };
}

function guarded(root, entry, deps) {
  return withFreshWorkspaceBuilds(
    { resolver: { resolveRequest: () => ({ type: 'sourceFile', filePath: entry }) } },
    root,
    deps,
  );
}

test('a stamped build is fresh until its sources change, whatever their mtimes', () => {
  const { pkg } = makeWorkspace();
  assert.equal(staleBuild(pkg, 'dist'), null);
  // A checkout round trip: new mtimes, same bytes. Turbo replays its cache
  // without rewriting dist/, so this must stay fresh.
  setMtime(path.join(pkg, 'src/index.ts'), Date.now() + 60_000);
  assert.equal(staleBuild(pkg, 'dist'), null);
  // A test edited after the build changes nothing the build compiles.
  write(path.join(pkg, 'src/__tests__/index.test.ts'), 'it("x", () => {});');
  assert.equal(staleBuild(pkg, 'dist'), null);
  // A real edit does.
  write(path.join(pkg, 'src/index.ts'), 'export const a = 2;');
  assert.deepEqual(staleBuild(pkg, 'dist'), {
    stamped: true,
    reason: 'src/ changed since dist/ was built',
  });
  writeStamp(pkg);
  assert.equal(staleBuild(pkg, 'dist'), null);
});

test('a release bundle refuses stale or unstamped output; development warns once', () => {
  const { root, pkg, entry } = makeWorkspace();
  write(path.join(pkg, 'src/index.ts'), 'export const a = 2;');

  // What the Gradle/Xcode release task's `expo export:embed` hands the resolver.
  assert.throws(
    () => guarded(root, entry).resolver.resolveRequest({ dev: false }, '@oxy.so/core', 'android'),
    /refusing to bundle packages\/core\/dist: src\/ changed since dist\/ was built.*turbo run build --filter=\.\/packages\/core/s,
  );
  assert.throws(
    () =>
      guarded(root, entry, { production: true }).resolver.resolveRequest({}, '@oxy.so/core', 'ios'),
    /refusing to bundle/,
  );

  const warnings = [];
  const development = guarded(root, entry, {
    production: false,
    warn: (message) => warnings.push(message),
  });
  assert.equal(development.resolver.resolveRequest({}, '@oxy.so/core', 'android').filePath, entry);
  development.resolver.resolveRequest({}, '@oxy.so/core', 'android');
  assert.equal(warnings.length, 1);

  // Output from before stamping (the Commons 1.3.0 checkout): refused too.
  fs.rmSync(path.join(pkg, 'dist', STAMP_FILE));
  assert.throws(
    () => guarded(root, entry, { production: true }).resolver.resolveRequest({}, 'x', 'android'),
    /carries no source stamp/,
  );
});

test('a package that does not stamp is only ever warned about, by mtime', () => {
  const { root, pkg, entry } = makeWorkspace({ stamped: false });
  const t = Date.now() - 60_000;
  setMtime(entry, t);
  setMtime(path.join(pkg, 'src/index.ts'), t + 10_000);
  const warnings = [];
  const config = guarded(root, entry, {
    production: true,
    warn: (message) => warnings.push(message),
  });
  assert.equal(config.resolver.resolveRequest({}, '@oxy.so/core', 'android').filePath, entry);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /may be out of date: src\/index\.ts is newer than dist\//);
});

test('files outside packages/*/(dist|lib|build) are never checked', () => {
  const { root } = makeWorkspace();
  const appFile = path.join(root, 'packages/app/lib/thing.ts');
  write(appFile, '');
  // `packages/app` has no src/, so its own `lib/` is source, not output.
  const config = guarded(root, appFile, { production: true });
  assert.equal(config.resolver.resolveRequest({}, './lib/thing', 'android').filePath, appFile);
});

test('every workspace package an app bundles from dist/ writes the stamp in its build', () => {
  const packagesDir = path.resolve(__dirname, '../..');
  for (const name of ['core', 'contracts', 'protocol', 'telemetry', 'expo-splash']) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packagesDir, name, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.oxySourceStamp, 'dist', `${name} declares oxySourceStamp`);
    assert.match(manifest.scripts.build, /node \.\.\/app-preset\/metro\/source-stamp\.js$/, name);
    assert.ok(manifest.files.includes(`!dist/${STAMP_FILE}`), `${name} keeps the stamp off npm`);
  }
});
