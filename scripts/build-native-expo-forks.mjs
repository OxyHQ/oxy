import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor/expo-native');
const original = path.join(vendor, 'expo-cli-57.0.23-upstream.tgz');
const expected = JSON.parse(fs.readFileSync(path.join(vendor, 'upstream-integrity.json'), 'utf8'));
const bytes = fs.readFileSync(original);
assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, expected.integrity);
assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-expo-fork-'));
try {
  execFileSync('tar', ['-xzf', original, '-C', scratch]);
  const fork = path.join(scratch, 'package');
  const manifest = path.join(fork, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(pkg.name, '@expo/cli');
  assert.equal(pkg.version, '57.0.23');
  assert.equal(pkg.dependencies['node-forge'], '^1.3.3');
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies).filter(([name]) => name !== 'node-forge'),
  );
  pkg.name = '@oxy.so/expo-cli-native';
  pkg.version = '57.0.23+oxy.native.3';
  pkg.oxyUpstream = {
    name: '@expo/cli',
    version: '57.0.23',
    integrity: expected.integrity,
  };
  fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
  const security = path.join(fork, 'build/src/run/ios/codeSigning/Security.js');
  let source = fs.readFileSync(security, 'utf8');
  assert.equal(source.split('require("node-forge")').length, 2);
  assert.equal(source.split('_nodeforge().default.pki.certificateFromPem(pem)').length, 2);
  source = source
    .replaceAll('_nodeforge', '_nativeCodeSigning')
    .replace('require("node-forge")', 'require("@expo/code-signing-certificates")')
    .replace(
      '_nativeCodeSigning().default.pki.certificateFromPem(pem)',
      '_nativeCodeSigning().default.convertCertificatePEMToCertificate(pem)',
    );
  fs.writeFileSync(security, source);
  // This compiled-file fork has no regenerated source map; prevent a stale map
  // from presenting the upstream Forge implementation as the executed code.
  fs.rmSync(`${security}.map`);
  fs.writeFileSync(
    security,
    source.replace(/\n\/\/# sourceMappingURL=Security\.js\.map\s*$/, '\n'),
  );
  // Self lookups must remain inside this explicitly named private package.
  // Its installed physical package has no @expo/cli self alias under Bun.
  for (const [relative, before, after] of [
    [
      'build/src/start/server/metro/externals.js',
      "_path().default.join(require.resolve('@expo/cli/package.json'), '../static/shims')",
      "_path().default.resolve(__dirname, '../../../../../static/shims')",
    ],
    [
      'build/src/prebuild/resolveLocalTemplate.js',
      "_path().default.dirname(require.resolve('@expo/cli/package.json'))",
      "_path().default.resolve(__dirname, '../../../')",
    ],
    [
      'build/src/start/server/metro/withMetroMultiPlatform.js',
      "require.resolve('@expo/cli/build/metro-require/require')",
      "require.resolve('../../../../metro-require/require')",
    ],
    [
      'build/src/start/server/metro/MetroBundlerDevServer.js',
      "require.resolve('@expo/cli/static/template/[...rsc]+api.ts')",
      "require.resolve('../../../../../static/template/[...rsc]+api.ts')",
    ],
    [
      'build/src/start/server/metro/createServerRouteMiddleware.js',
      "require.resolve('@expo/cli/static/template/[...rsc]+api.ts')",
      "require.resolve('../../../../../static/template/[...rsc]+api.ts')",
    ],
    [
      'build/src/lint/ESlintPrerequisite.js',
      'require.resolve(`@expo/cli/static/template/eslint.config.js`)',
      'require.resolve(`../../../static/template/eslint.config.js`)',
    ],
    [
      'build/src/customize/templates.js',
      'require.resolve(`@expo/cli/static/template/${moduleId}`)',
      'require.resolve(`../../../static/template/${moduleId}`)',
    ],
  ]) {
    const file = path.join(fork, relative);
    const originalSource = fs.readFileSync(file, 'utf8');
    assert.equal(originalSource.split(before).length, 2);
    fs.writeFileSync(
      file,
      originalSource.replace(before, after).replace(/\n\/\/# sourceMappingURL=[^\n]+\s*$/, '\n'),
    );
    fs.rmSync(`${file}.map`);
  }
  execFileSync('bun', ['pm', 'pack', '--destination', vendor], {
    cwd: fork,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const native = path.join(root, 'tooling/expo-code-signing-native');
  execFileSync('bun', ['run', 'build'], {
    cwd: native,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('bun', ['pm', 'pack', '--destination', scratch], {
    cwd: native,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const adapterArchive = 'oxy.so-expo-code-signing-native-0.1.2.tgz';
  // Bun archive headers/compression may vary across invocations. Validate
  // contents exactly (manifest formatting semantically), never overwrite an existing adapter version.
  execFileSync(
    'python3',
    [
      '-c',
      `
import json,tarfile,sys
def files(path):
 with tarfile.open(path) as archive:
  return {m.name:archive.extractfile(m).read() for m in archive if m.isfile()}
a,b=map(files,sys.argv[1:])
assert a.keys()==b.keys(), 'Immutable adapter archive member set changed'
for name in a:
 assert (json.loads(a[name])==json.loads(b[name]) if name=='package/package.json' else a[name]==b[name]), 'Immutable adapter member changed: '+name
`,
      path.join(scratch, adapterArchive),
      path.join(vendor, adapterArchive),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  console.log(
    'Verified upstream archive; built private native adapter and explicitly identified Expo CLI fork.',
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
