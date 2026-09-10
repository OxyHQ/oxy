const assert = require('node:assert/strict');
const test = require('node:test');
const packageJson = require('../package.json');

test('Oxy peers accept compatible patches without crossing a major', () => {
  assert.equal(packageJson.peerDependencies['@oxy.so/bloom'], '^1.0.7');
  assert.equal(packageJson.peerDependencies['@oxy.so/services'], '^1.0.1');
});
