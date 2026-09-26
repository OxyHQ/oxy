const assert = require('node:assert/strict');
const test = require('node:test');
const packageJson = require('../package.json');

test('Oxy peers accept compatible patches without crossing a major', () => {
  assert.equal(packageJson.peerDependencies['@oxy.so/bloom'], '^2.0.0 || ^3.0.0 || ^4.2.0');
  assert.equal(packageJson.peerDependencies['@oxy.so/services'], '^2.0.0 || ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0');
});
