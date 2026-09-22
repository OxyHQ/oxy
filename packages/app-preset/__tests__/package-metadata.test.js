const assert = require('node:assert/strict');
const test = require('node:test');
const packageJson = require('../package.json');
const rootPackageJson = require('../../../package.json');

const major = (range) => {
  const match = /^\^(\d+)\./.exec(range);
  assert.ok(match, `expected a caret range with a major cap, got ${range}`);
  return match[1];
};

test('Oxy peers accept compatible patches without crossing a major', () => {
  // A caret range is the whole point: the floor records what was measured, the
  // implied major cap records that nothing beyond it was. `*` or a bare `>=`
  // here is what once let bun pair a consumer with a breaking major and warn
  // about nothing — see the `//@oxy.so/bloom` note in packages/services.
  assert.equal(packageJson.peerDependencies['@oxy.so/bloom'], '^4.5.0');
  assert.equal(packageJson.peerDependencies['@oxy.so/services'], '^3.1.0');
});

test('the Bloom peer shares a major with the workspace catalog', () => {
  // This package couples to Bloom by FILE PATH — `css/base.css` imports
  // `@oxy.so/bloom/design-tokens/theme.css` — so it does not need the catalog's
  // exact floor. It does need the same MAJOR: on different majors bun resolves a
  // second, nested Bloom under one of them, and Bloom's composition contracts
  // (BloomScope, Screen, the navigation scope) are React contexts that cannot
  // cross two copies. Nothing at install time says so; this is the only gate.
  const catalogRange = rootPackageJson.workspaces.catalog['@oxy.so/bloom'];
  assert.equal(
    major(packageJson.peerDependencies['@oxy.so/bloom']),
    major(catalogRange),
    `app-preset peers Bloom ${packageJson.peerDependencies['@oxy.so/bloom']} but the catalog pins ${catalogRange}`,
  );
});
