import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_slot', Path(__file__).with_name('prepare-corrupt-slot.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
VALID = ('<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n'
         '<string name="' + module.KEY + '">' + 'a0' * 40 + '</string>\n'
         '<string name="other-encrypted-entry">unchanged</string>\n</map>').encode()

class SlotPreparation(unittest.TestCase):
    def test_changes_exactly_one_byte_and_preserves_all_other_entries(self):
        changed = module.corrupt_slot(VALID, module.digest(VALID))
        self.assertEqual(len(changed), len(VALID))
        self.assertEqual(sum(a != b for a, b in zip(changed, VALID)), 1)
        self.assertIn(b'<string name="other-encrypted-entry">unchanged</string>', changed)

    def test_rejects_wrong_cas_hash(self):
        with self.assertRaises(ValueError): module.corrupt_slot(VALID, '0' * 64)

    def test_rejects_duplicate_keyset(self):
        data = VALID.replace(b'</map>', ('<string name="' + module.KEY + '">' + 'ab' * 40 + '</string></map>').encode())
        with self.assertRaises(ValueError): module.corrupt_slot(data, module.digest(data))

    def test_rejects_malformed_or_missing_keyset(self):
        for data in [b'<map/>', b'<map>', VALID.replace(b'a0a0', b'zzzz')]:
            with self.assertRaises((ValueError, module.ET.ParseError)): module.corrupt_slot(data, module.digest(data))

    def test_rejects_dtd_invalid_utf8_and_oversize(self):
        for data in [b'<!DOCTYPE map>' + VALID, VALID + b'\xff', b'a' * (module.MAX_BYTES + 1)]:
            with self.assertRaises(ValueError): module.corrupt_slot(data, module.digest(data))

    def test_private_backup_receipt_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / module.TARGET
            source.write_bytes(VALID); source.chmod(0o600)
            output = root / 'attempt'
            receipt = module.prepare(source, module.digest(VALID), output)
            self.assertFalse(receipt['deviceMutated'])
            self.assertEqual((output / 'original.xml').read_bytes(), VALID)
            self.assertEqual(source.read_bytes(), VALID)
            for file in output.iterdir(): self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError): module.prepare(source, module.digest(VALID), output)

    def test_refuses_wrong_file_name_symlink_and_broad_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / module.TARGET
            source.write_bytes(VALID); source.chmod(0o644)
            with self.assertRaises(ValueError): module.read_private_input(source)
            with self.assertRaises(ValueError): module.read_private_input(root / 'oxy_identity_signer.xml')
            source.unlink(); source.symlink_to('/dev/null')
            with self.assertRaises(OSError): module.read_private_input(source)

if __name__ == '__main__': unittest.main()
