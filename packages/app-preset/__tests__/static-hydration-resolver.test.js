const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withStaticHydrationBoundary } = require('../metro/static-hydration/resolver');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-static-hydration-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function project(version) {
  const directory = path.join(root, version);
  const pkg = path.join(directory, 'node_modules/@expo/router-server');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@expo/router-server', version }),
  );
  return directory;
}
const renderer = '/app/node_modules/@expo/router-server/build/server/renderStreamingContent.js';
function config() {
  return {
    resolver: { resolveRequest: (_context, name) => ({ type: 'sourceFile', filePath: name }) },
  };
}
test('redirects only the Expo renderer in web node bundles; delegates other platforms and adapter imports', () => {
  const resolve = withStaticHydrationBoundary(config(), project('58.0.14')).resolver.resolveRequest;
  const context = {
    originModulePath: '/app/export.js',
    customResolverOptions: { environment: 'node' },
  };
  const adapted = resolve(context, renderer, 'web');
  assert.match(adapted.filePath, /static-hydration[/\\]renderer.js$/);
  assert.equal(
    resolve({ ...context, originModulePath: adapted.filePath }, renderer, 'web').filePath,
    renderer,
  );
  assert.equal(resolve(context, renderer, 'ios').filePath, renderer);
  assert.equal(
    resolve({ ...context, customResolverOptions: {} }, renderer, 'web').filePath,
    renderer,
  );
  assert.equal(
    resolve({ ...context, customResolverOptions: { environment: 'react-server' } }, renderer, 'web')
      .filePath,
    renderer,
  );
  assert.equal(resolve(context, '/app/something.js', 'web').filePath, '/app/something.js');
});
test('refuses unreviewed upstream versions when the compatibility adapter is enabled', () => {
  assert.throws(
    () => withStaticHydrationBoundary(config(), project('58.0.17')),
    /Review the upstream renderer/,
  );
  assert.throws(() => withStaticHydrationBoundary(config(), project('57.0.0')), /58.0.14–58.0.16/);
});
