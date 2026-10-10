import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  inspectImage,
  readDeclaredNativePackageInventory,
} from './native-expo-image-inventory.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-image-'));
  try {
    const expected = {};
    for (const name of ['@oxy.so/expo-cli-native', '@oxy.so/expo-code-signing-native']) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      const files = {
        'package.json': JSON.stringify({
          name,
          version: name === '@oxy.so/expo-cli-native' ? '57.0.23+oxy.native.3' : '0.1.2',
        }),
        'index.cjs': 'module.exports = {}',
      };
      for (const [file, bytes] of Object.entries(files))
        fs.writeFileSync(path.join(dir, file), bytes);
      expected[name] = {
        version: name === '@oxy.so/expo-cli-native' ? '57.0.23+oxy.native.3' : '0.1.2',
        files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, sha(bytes)])),
      };
    }
    fn(root, expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('actual native files and two identities are required', () =>
  fixture((root, expected) => assert.equal(inspectImage(root, expected).length, 2)));
test('cached unreachable Forge path is rejected', () =>
  fixture((root, expected) => {
    fs.mkdirSync(path.join(root, 'node-forge@1.4.0'));
    assert.throws(() => inspectImage(root, expected), /Forge/);
  }));
test('renamed Forge package identity is rejected', () =>
  fixture((root, expected) => {
    const dir = path.join(root, 'renamed');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'node-forge' }));
    assert.throws(() => inspectImage(root, expected), /Forge/);
  }));
test('tampered native code fails byte integrity', () =>
  fixture((root, expected) => {
    fs.appendFileSync(path.join(root, '@oxy.so/expo-cli-native/index.cjs'), 'tamper');
    assert.throws(() => inspectImage(root, expected), /bytes differ/);
  }));
test('missing native package fails even when Forge is absent', () =>
  fixture((root, expected) => {
    fs.rmSync(path.join(root, '@oxy.so/expo-cli-native'), { recursive: true });
    assert.throws(() => inspectImage(root, expected), /missing/);
  }));

test('native file symlink cannot substitute mounted proof bytes', () =>
  fixture((root, expected) => {
    const file = path.join(root, '@oxy.so/expo-cli-native/index.cjs');
    const replacement = path.join(root, 'replacement.cjs');
    fs.renameSync(file, replacement);
    fs.symlinkSync(replacement, file);
    assert.throws(() => inspectImage(root, expected), /physical/);
  }));

test('historical archive cannot override the exact manifest selection', () => {
  const root = path.resolve(import.meta.dirname, '..');
  assert(
    fs.existsSync(
      path.join(root, 'vendor/expo-native/oxy.so-expo-cli-native-57.0.23+oxy.native.1.tgz'),
    ),
  );
  const expected = readDeclaredNativePackageInventory(root);
  assert.equal(expected['@oxy.so/expo-cli-native'].version, '57.0.23+oxy.native.3');
  assert.equal(expected['@oxy.so/expo-code-signing-native'].version, '0.1.2');
});

test('declared archive must be local, present and have the exact package identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-declared-'));
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    assert.throws(() => readDeclaredNativePackageInventory(root));
    // Both archives exist, but selecting the adapter as CLI must fail identity.
    const archive = 'vendor/expo-native/oxy.so-expo-code-signing-native-0.1.2.tgz';
    fs.mkdirSync(path.dirname(path.join(root, archive)), { recursive: true });
    fs.copyFileSync(path.resolve(import.meta.dirname, '..', archive), path.join(root, archive));
    manifest.overrides['@expo/cli'] = `file:./${archive}`;
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    assert.throws(() => readDeclaredNativePackageInventory(root));
    manifest.overrides['@expo/cli'] = 'file:./vendor/expo-native/../../secret.tgz';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    assert.throws(() => readDeclaredNativePackageInventory(root), /regular expression/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('old declared version cannot accept newly installed CLI bytes', () =>
  fixture((root, expected) => {
    expected['@oxy.so/expo-cli-native'].version = '57.0.23+oxy.native.1';
    assert.throws(() => inspectImage(root, expected), /strictly equal/);
  }));

test('each file-install Docker stage receives both declared native archives', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const required = ['@expo/cli', '@expo/code-signing-certificates'].map((name) =>
    manifest.overrides[name].slice('file:./'.length),
  );
  for (const file of ['Dockerfile', 'packages/node/Dockerfile']) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    const copies = contents
      .split('\n')
      .filter((line) => line.startsWith('COPY vendor/expo-native/'));
    assert.equal(copies.length, file === 'Dockerfile' ? 1 : 2);
    for (const copy of copies)
      for (const archive of required)
        assert(copy.split(/\s+/).includes(archive), `${file} omits ${archive}`);
  }
});
