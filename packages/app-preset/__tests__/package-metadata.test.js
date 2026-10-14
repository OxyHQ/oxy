const assert = require('node:assert/strict');
const test = require('node:test');
const packageJson = require('../package.json');

// Oxy apps always run the latest Bloom and Services, so the last alternative of
// each peer must be open-ended: a cap would make every new major a peer
// conflict until this package republished.
const lastAlternative = (range) => range.split('||').pop().trim();

test('the Oxy peers keep a floor and have no cap above it', () => {
  assert.match(lastAlternative(packageJson.peerDependencies['@oxy.so/bloom']), /^>=\d+\.\d+\.\d+$/);
  assert.match(
    lastAlternative(packageJson.peerDependencies['@oxy.so/services']),
    /^>=\d+\.\d+\.\d+$/,
  );
});
