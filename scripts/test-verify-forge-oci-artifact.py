#!/usr/bin/env python3
"""Actual streaming ZIP/tar fixtures, offline. No real OCI image or authority."""
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("oci_verifier", Path(__file__).with_name("verify-forge-oci-artifact.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
HEAD = "a" * 40

def payload(mutator=None):
    config = json.dumps({"architecture": "arm64", "os": "linux", "config": {"Labels": {"org.opencontainers.image.revision": HEAD}}}).encode()
    config_hash = hashlib.sha256(config).hexdigest()
    manifest = json.dumps({"schemaVersion": 2, "config": {"digest": "sha256:" + config_hash}, "layers": []}).encode()
    manifest_hash = hashlib.sha256(manifest).hexdigest()
    files = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}',
             "index.json": json.dumps({"schemaVersion": 2, "manifests": [{"digest": "sha256:" + manifest_hash}]}).encode(),
             "blobs/sha256/" + config_hash: config, "blobs/sha256/" + manifest_hash: manifest}
    if mutator:
        mutator(files, config_hash, manifest_hash)
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, value in files.items():
            info = tarfile.TarInfo(name)
            if isinstance(value, tuple):
                info.type, info.linkname = value
                tar.addfile(info)
            else:
                info.size = len(value)
                tar.addfile(info, io.BytesIO(value))
    archive = data.getvalue()
    return archive, {"id": 123, "archiveSha256": hashlib.sha256(archive).hexdigest(), "manifestDigest": "sha256:" + manifest_hash, "configDigest": "sha256:" + config_hash, "sourceSha": HEAD}

class StreamingFixtures(unittest.TestCase):
    def verify(self, mutate=None, expected_mutate=None, extra_zip=False):
        archive, expected = payload(mutate)
        with tempfile.TemporaryDirectory(prefix="forge-stream-offline-") as directory:
            path = Path(directory) / "fixture.zip"
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as output:
                output.writestr("forge-image.oci.tar", archive)
                if extra_zip:
                    output.writestr("unexpected.txt", "synthetic")
            raw = path.read_bytes()
            expected.update({"digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "size_in_bytes": len(raw)})
            if expected_mutate:
                expected_mutate(expected)
            return module.verify_zip(path, expected)
    def test_valid_stream(self):
        result = self.verify()
        self.assertGreater(result["archiveSizeBytes"], 0)
        self.assertEqual(result["artifactId"], 123)
        self.assertNotIn("authorized", result)
    def test_zip_digest_mismatch(self):
        with self.assertRaisesRegex(ValueError, "ZIP digest"):
            self.verify(expected_mutate=lambda x: x.update(digest="sha256:" + "f" * 64))
    def test_zip_size_mismatch(self):
        with self.assertRaisesRegex(ValueError, "ZIP size"):
            self.verify(expected_mutate=lambda x: x.update(size_in_bytes=1))
    def test_archive_digest_mismatch(self):
        with self.assertRaisesRegex(ValueError, "scanned archive"):
            self.verify(expected_mutate=lambda x: x.update(archiveSha256="f" * 64))
    def test_ambiguous_zip(self):
        with self.assertRaisesRegex(ValueError, "precisely one"):
            self.verify(extra_zip=True)
    def test_unsafe_tar_path(self):
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            self.verify(lambda x, c, m: x.update({"../escape": b"synthetic"}))
    def test_symlink(self):
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            self.verify(lambda x, c, m: x.update({"blobs/sha256/" + "f" * 64: (tarfile.SYMTYPE, "/etc/passwd")}))
    def test_blob_hash_mismatch(self):
        with self.assertRaisesRegex(ValueError, "filename/hash"):
            self.verify(lambda x, c, m: x.update({"blobs/sha256/" + c: b"tampered"}))
    def test_index_wrong_manifest(self):
        with self.assertRaisesRegex(ValueError, "index"):
            self.verify(lambda x, c, m: x.update({"index.json": b'{"schemaVersion":2,"manifests":[]}'}))
    def test_wrong_config_digest(self):
        with self.assertRaisesRegex(ValueError, "config"):
            self.verify(expected_mutate=lambda x: x.update(configDigest="sha256:" + "f" * 64))
    def test_wrong_source(self):
        with self.assertRaisesRegex(ValueError, "execution SHA"):
            self.verify(expected_mutate=lambda x: x.update(sourceSha="b" * 40))
    def test_metadata_limit(self):
        with self.assertRaisesRegex(ValueError, "metadata exceeds"):
            self.verify(lambda x, c, m: x.update({"index.json": b" " * (module.MAX_JSON_BYTES + 1)}))
    def test_sparse_zip_limit_without_reading_gigabytes(self):
        with tempfile.TemporaryDirectory(prefix="forge-stream-limit-") as directory:
            path = Path(directory) / "sparse.zip"
            with path.open("wb") as stream:
                stream.truncate(module.MAX_ZIP_BYTES + 1)
            with self.assertRaisesRegex(ValueError, "4 GiB"):
                module.verify_zip(path, {"size_in_bytes": module.MAX_ZIP_BYTES + 1})

if __name__ == "__main__":
    unittest.main()
