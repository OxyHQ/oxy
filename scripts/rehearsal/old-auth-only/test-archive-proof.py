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

if __name__ == '__main__': unittest.main()
