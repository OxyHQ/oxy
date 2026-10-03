import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('archive-proof.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
SOURCE = 'a' * 40

def fixture(directory, change=None):
    layer = b'owned synthetic layer' * 20000
    diff = 'sha256:' + hashlib.sha256(layer).hexdigest()
    config = json.dumps({'architecture': 'arm64', 'os': 'linux', 'rootfs': {'type': 'layers', 'diff_ids': [diff]}}).encode()
    image_id = 'sha256:' + hashlib.sha256(config).hexdigest()
    inspected = {'Architecture': 'arm64', 'Os': 'linux', 'Id': image_id,
        'Config': {'Labels': {'org.opencontainers.image.revision': SOURCE}}, 'RootFS': {'Layers': [diff]}}
    items = {'config.json': config, 'layer.tar': layer,
        'manifest.json': json.dumps([{'Config': 'config.json', 'Layers': ['layer.tar']}]).encode()}
    if change: change(items, inspected)
    path = directory / 'image.tar'
    with tarfile.open(path, 'w') as tar:
        for name, value in items.items():
            entry = tarfile.TarInfo(name); entry.size = len(value); tar.addfile(entry, io.BytesIO(value))
    return path, inspected

class ArchiveProof(unittest.TestCase):
    def check_fixture(self, change=None, valid=False):
        with tempfile.TemporaryDirectory(prefix='auth-only-archive-') as temp:
            path, inspected = fixture(Path(temp), change)
            if valid:
                result = module.bind(path, inspected, SOURCE, '123')
                self.assertFalse(result['productionReady']); self.assertEqual(result['archiveSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                return result
            with self.assertRaises((ValueError, KeyError)): module.bind(path, inspected, SOURCE, '123')
    def test_exact_scanned_config_and_layers(self): self.check_fixture(valid=True)
    def test_changed_config(self): self.check_fixture(lambda items, _: items.update({'config.json': b'{}'}))
    def test_changed_layer(self): self.check_fixture(lambda items, _: items.update({'layer.tar': b'changed' * 90000}))
    def test_wrong_source(self): self.check_fixture(lambda _, inspected: inspected['Config']['Labels'].update({'org.opencontainers.image.revision': 'b' * 40}))
    def test_wrong_platform(self): self.check_fixture(lambda _, inspected: inspected.update({'Architecture': 'amd64'}))
    def test_extra_image(self): self.check_fixture(lambda items, _: items.update({'manifest.json': b'[{},{}]'}))
    def test_unsafe_path(self): self.check_fixture(lambda items, _: items.update({'../outside': b'forbidden'}))
    def test_missing_layers(self): self.check_fixture(lambda _, inspected: inspected['RootFS'].update({'Layers': []}))
    def test_compressed_blob(self):
        import gzip
        result = self.check_fixture(lambda items, _: items.update({'layer.tar': gzip.compress(items['layer.tar'])}), valid=True)
        self.assertEqual(len(result['rootfsDiffIds']), 1)

class BootstrapBinding(unittest.TestCase):
    def check(self, mutate=None, valid=False):
        with tempfile.TemporaryDirectory() as tmp:
            row = {'variantSource': SOURCE, 'imageConfigId': 'sha256:'+'a'*64,
                'imageMode': True, 'bootstrapNodeEnv': 'production', 'productionAccess': False,
                'schemaSource': '38d5ce28c0a5ec0338775810d5681e2834416f25',
                'probePassed': True, 'externalAttempts': 0, 'checkpoints': [str(i) for i in range(14)],
                'preservedBefore': {str(i): {'rows': 1, 'sha256': 'b'*64} for i in range(14)},
                'cleanupErrors': [], 'databaseAbsent': True, 'postgresStopped': True,
                'containerCleanup': [{'absent': True, 'image': 'sha256:'+'a'*64}]*2,
                'hostContainer': {'image': 'sha256:'+'a'*64, 'script': 'host.mjs'},
                'probeContainer': {'image': 'sha256:'+'a'*64, 'script': 'probe.mjs', 'exitCode': 0},
                'variantHost': {'nodeEnv': 'production'}}
            row['preservedAfter'] = copy.deepcopy(row['preservedBefore'])
            if mutate: mutate(row)
            path = Path(tmp)/'receipt.json';path.write_text(json.dumps(row))
            proof = {'sourceSha': SOURCE, 'imageConfigId': 'sha256:'+'a'*64, 'securityApproved': False, 'productionReady': False}
            if valid:
                result = module.bind_bootstrap(proof, path)
                self.assertTrue(result['bootstrapImageVerified'])
                self.assertFalse(result['securityApproved']);self.assertFalse(result['productionReady'])
            else:
                with self.assertRaises(ValueError):module.bind_bootstrap(proof, path)
    def test_exact_receipt(self):self.check(valid=True)
    def test_wrong_image(self):self.check(lambda row:row.update(imageConfigId='sha256:'+'c'*64))
    def test_wrong_source(self):self.check(lambda row:row.update(variantSource='d'*40))
    def test_development_bootstrap(self):self.check(lambda row:row.update(bootstrapNodeEnv='test'))
    def test_changed_financial_table(self):self.check(lambda row:row['preservedAfter']['1'].update(rows=2))
    def test_missing_checkpoint(self):self.check(lambda row:row['checkpoints'].pop())
    def test_external_attempt(self):self.check(lambda row:row.update(externalAttempts=1))
    def test_unresolved_cleanup(self):self.check(lambda row:row.update(databaseAbsent=False))
    def test_different_probe_image(self):self.check(lambda row:row['probeContainer'].update(image='sha256:'+'d'*64))

if __name__ == '__main__': unittest.main()
