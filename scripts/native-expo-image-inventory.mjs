import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Host-only: select the exact archives Docker installs, never historical siblings. */
export function readDeclaredNativePackageInventory(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const selections = [
    ['@expo/cli', '@oxy.so/expo-cli-native'],
    ['@expo/code-signing-certificates', '@oxy.so/expo-code-signing-native'],
  ].map(([alias, identity]) => {
    const specifier = manifest.overrides?.[alias];
    assert.equal(typeof specifier, 'string');
    assert.match(specifier, /^file:\.\/vendor\/expo-native\/oxy\.so-[A-Za-z0-9.+-]+\.tgz$/);
    return {
      archive: path.join(root, specifier.slice('file:./'.length)),
      identity,
    };
  });
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import hashlib,json,sys,tarfile
expected={}
for selection in json.loads(sys.argv[1]):
 with tarfile.open(selection['archive']) as source:
  files={m.name.removeprefix('package/'):source.extractfile(m).read() for m in source.getmembers() if m.isfile()}
  package=json.loads(files['package.json'])
  assert package['name']==selection['identity']
  expected[package['name']]={'version':package['version'],'files':{k:hashlib.sha256(v).hexdigest() for k,v in files.items()}}
print(json.dumps(expected))
`,
        JSON.stringify(selections),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ),
  );
}
export function inspectImage(root, expected) {
  const packages = [];
  const forbidden = [];
  assert.deepEqual(Object.keys(expected).sort(), [
    '@oxy.so/expo-cli-native',
    '@oxy.so/expo-code-signing-native',
  ]);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.name === 'node-forge' || entry.name.startsWith('node-forge@')) forbidden.push(file);
      if (entry.isDirectory()) {
        if (!['/proc', '/sys', '/dev', '/native-expo-proof'].includes(file)) walk(file);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (pkg.name === 'node-forge') forbidden.push(file);
        const identity = expected[pkg.name];
        if (identity) {
          assert.equal(pkg.version, identity.version);
          const root = path.dirname(file);
          for (const [name, wanted] of Object.entries(identity.files)) {
            const installedFile = path.join(root, name);
            assert(
              fs.lstatSync(installedFile).isFile(),
              'Native package file must be physical, not a symlink',
            );
            const bytes = fs.readFileSync(installedFile);
            assert.equal(
              sha256(bytes),
              wanted,
              `Installed image bytes differ: ${pkg.name}/${name}`,
            );
          }
          packages.push({
            name: pkg.name,
            version: pkg.version,
            root,
            verifiedFiles: Object.keys(identity.files).length,
          });
        }
      }
    }
  }
  walk(root);
  assert.equal(forbidden.length, 0, 'Actual image retains a Forge copy');
  for (const name of Object.keys(expected))
    assert(
      packages.some((pkg) => pkg.name === name),
      `Expected native package missing: ${name}`,
    );
  return packages;
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  const [expectedPath, sourceSha, imageId] = process.argv.slice(2);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const packages = inspectImage('/', expected);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      sourceSha,
      imageId,
      forgeCopies: 0,
      installedNativePackages: packages,
      expectedFilesSha256: sha256(fs.readFileSync(expectedPath)),
      approval: false,
    }),
  );
}
