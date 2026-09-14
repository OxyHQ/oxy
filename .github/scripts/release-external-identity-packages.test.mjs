import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELEASES, integrity, releaseDecision, validateSource, validateArtifactManifest } from './release-external-identity-packages.mjs';

test('release scope is the exact dependency-ordered pair', () => {
  assert.deepEqual(RELEASES.map(({ name, version }) => `${name}@${version}`), ['@oxy.so/contracts@1.1.0', '@oxy.so/federation@1.0.1']);
});
test('source guard rejects branch execution, stale SHA and unspecified write mode', () => {
  const sha = 'a'.repeat(40);
  validateSource(sha, sha, 'refs/heads/main', 'true', 'true');
  validateSource(sha, sha, 'refs/heads/main', 'false', 'true');
  assert.throws(() => validateSource(sha, sha, 'refs/heads/main', 'false', 'false'));
  for (const args of [[sha, sha, 'refs/heads/feature', 'false'], [sha, 'b'.repeat(40), 'refs/heads/main', 'false'], ['main', 'main', 'refs/heads/main', 'false'], [sha, sha, 'refs/heads/main', undefined]]) {
    assert.throws(() => validateSource(...args, 'true'));
  }
});
test('immutable publication is idempotent only for identical artifact bytes', () => {
  const built = integrity(Buffer.from('reviewed package'));
  assert.equal(releaseDecision(null, built), 'missing');
  assert.equal(releaseDecision(built, built), 'already-published');
  assert.throws(() => releaseDecision(integrity(Buffer.from('other package')), built), /refusing overwrite/);
  assert.throws(() => releaseDecision(undefined, built));
});

test('artifact verification rejects missing exports and unresolved workspace manifests', () => {
  const release = RELEASES[0];
  const manifest = { name: release.name, version: release.version, main: 'dist/cjs/index.js', module: 'dist/esm/index.js', types: 'dist/types/index.d.ts', exports: { '.': { require: './dist/cjs/index.js' } } };
  const entries = ['package/dist/cjs/index.js', 'package/dist/esm/index.js', 'package/dist/types/index.d.ts'];
  validateArtifactManifest(release, manifest, entries);
  assert.throws(() => validateArtifactManifest(release, manifest, entries.slice(1)), /Missing concrete export/);
  assert.throws(() => validateArtifactManifest(release, { ...manifest, dependencies: { zod: 'catalog:' } }, entries), /Unresolved/);
  assert.throws(() => validateArtifactManifest(release, { ...manifest, version: '9.0.0' }, entries), /mismatch/);
});
