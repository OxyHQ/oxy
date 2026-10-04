#!/usr/bin/env python3
import importlib.util
import io
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest

MODULE = Path(__file__).with_name('verify-native-expo-forks.py')
loader = importlib.util.spec_from_file_location('native_fork', MODULE)
verifier = importlib.util.module_from_spec(loader)
loader.loader.exec_module(verifier)
ORIGINAL_ROOT = verifier.ROOT


class NativeForkSeal(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='oxy-native-fork-controls-')
        verifier.ROOT = Path(self.scratch.name)
        verifier.VENDOR = verifier.ROOT / 'vendor/expo-native'
        shutil.copytree(ORIGINAL_ROOT / 'vendor/expo-native', verifier.VENDOR)
        shutil.copytree(ORIGINAL_ROOT / 'tooling/expo-code-signing-native', verifier.ROOT / 'tooling/expo-code-signing-native', ignore=shutil.ignore_patterns('node_modules'))
        for relative in ['package.json', 'bun.lock'] + [f'packages/{name}/package.json' for name in ['core', 'contracts', 'services', 'protocol', 'mcp', 'db']]:
            target = verifier.ROOT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ORIGINAL_ROOT / relative, target)

    def tearDown(self):
        self.scratch.cleanup()
        verifier.ROOT = ORIGINAL_ROOT
        verifier.VENDOR = ORIGINAL_ROOT / 'vendor/expo-native'

    def mutate_archive(self, archive, name, transform):
        archive = verifier.VENDOR / archive
        records = verifier.files(archive)
        records[name] = transform(records[name])
        with tarfile.open(archive, 'w:gz') as writer:
            for name, value in records.items():
                member = tarfile.TarInfo('package/' + name)
                member.size = len(value)
                writer.addfile(member, io.BytesIO(value))

    def test_exact_archives_and_shipping_manifests(self):
        self.assertFalse(verifier.verify()['forgeInLock'])

    def test_cli_extra_compiled_statement_is_denied(self):
        self.mutate_archive('oxy.so-expo-cli-native-57.0.23+oxy.native.1.tgz', 'build/src/run/ios/codeSigning/Security.js', lambda value: value + b'\nexports.injected = true;\n')
        with self.assertRaises(AssertionError):
            verifier.verify()

    def test_adapter_archive_drift_is_denied(self):
        self.mutate_archive('oxy.so-expo-code-signing-native-0.1.1.tgz', 'index.cjs', lambda value: value + b'\nexports.injected = true;\n')
        with self.assertRaises(AssertionError):
            verifier.verify()

    def test_upstream_mutation_is_denied_before_delta_comparison(self):
        self.mutate_archive('expo-cli-57.0.23-upstream.tgz', 'README.md', lambda value: value + b'\nchanged\n')
        with self.assertRaises(AssertionError):
            verifier.verify()

    def test_forge_reintroduced_lock_is_denied(self):
        with (verifier.ROOT / 'bun.lock').open('a') as lock:
            lock.write('\n// node-forge@1.4.0 reintroduced\n')
        with self.assertRaises(AssertionError):
            verifier.verify()

    def test_local_native_reference_in_published_sdk_manifest_is_denied(self):
        import json
        manifest = verifier.ROOT / 'packages/core/package.json'
        value = json.loads(manifest.read_text())
        value['dependencies']['unsafe-local'] = 'file:../../vendor/expo-native/native.tgz'
        manifest.write_text(json.dumps(value))
        with self.assertRaises(AssertionError):
            verifier.verify()

    def test_retained_installed_forge_copy_is_denied(self):
        (verifier.ROOT / 'node_modules/.bun/node-forge@1.4.0').mkdir(parents=True)
        with self.assertRaises(AssertionError):
            verifier.verify()


if __name__ == '__main__':
    unittest.main()
