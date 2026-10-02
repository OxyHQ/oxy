#!/usr/bin/env python3
"""Streaming OCI transport verification. No publication, extraction or policy authority."""
import hashlib
import json
import os
import re
import subprocess
import sys
import signal
import tarfile
import tempfile
import zipfile
from pathlib import Path

MAX_ZIP_BYTES = 4 * 1024**3
MAX_ARCHIVE_BYTES = 8 * 1024**3
MAX_JSON_BYTES = 2 * 1024**2
CHUNK = 1024**2
HEX = re.compile(r"^[a-f0-9]{64}$")

class BoundedTarInfo(tarfile.TarInfo):
    def _proc_pax(self, archive):
        if self.size > MAX_JSON_BYTES:
            raise ValueError("Tar metadata exceeds 2 MiB")
        return super()._proc_pax(archive)
    def _proc_gnulong(self, archive):
        if self.size > MAX_JSON_BYTES:
            raise ValueError("Tar long-name metadata exceeds 2 MiB")
        return super()._proc_gnulong(archive)

class HashReader:
    def __init__(self, stream):
        self.stream, self.digest, self.count = stream, hashlib.sha256(), 0
    def read(self, size=-1):
        data = self.stream.read(CHUNK if size < 0 else size)
        self.count += len(data)
        if self.count > MAX_ARCHIVE_BYTES:
            raise ValueError("OCI archive exceeds 8 GiB limit")
        self.digest.update(data)
        return data

def verify_zip(path, expected):
    size = Path(path).stat().st_size
    if size <= 0 or size > MAX_ZIP_BYTES or size != expected["size_in_bytes"]:
        raise ValueError("ZIP size differs from authenticated artifact or exceeds 4 GiB")
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
    if "sha256:" + digest.hexdigest() != expected["digest"]:
        raise ValueError("ZIP digest differs from authenticated artifact")
    desired_manifest = expected["manifestDigest"].removeprefix("sha256:")
    desired_config = expected["configDigest"].removeprefix("sha256:")
    if not all(HEX.fullmatch(value) for value in [desired_manifest, desired_config, expected["archiveSha256"]]):
        raise ValueError("Invalid expected digest")
    json_blobs, seen = {}, set()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) != 1 or entries[0].filename != "forge-image.oci.tar" or entries[0].flag_bits & 1:
            raise ValueError("OCI ZIP must contain precisely one unencrypted forge-image.oci.tar")
        entry = entries[0]
        if entry.file_size <= 0 or entry.file_size > MAX_ARCHIVE_BYTES or entry.compress_type not in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]:
            raise ValueError("OCI archive size or compression invalid")
        with archive.open(entry) as stream:
            reader = HashReader(stream)
            with tarfile.open(fileobj=reader, mode="r|", tarinfo=BoundedTarInfo) as tar:
                for member in tar:
                    name = member.name.removeprefix("./")
                    if name in seen:
                        raise ValueError("Duplicate OCI member")
                    seen.add(name)
                    if member.isdir() and name in ["blobs", "blobs/sha256"]:
                        continue
                    if not member.isfile() or not (name in ["index.json", "oci-layout"] or re.fullmatch(r"blobs/sha256/[a-f0-9]{64}", name)):
                        raise ValueError("Unsafe or unexpected OCI member")
                    data = tar.extractfile(member)
                    blob_digest, count, retained = hashlib.sha256(), 0, []
                    retain = name in ["index.json", "oci-layout", "blobs/sha256/" + desired_manifest, "blobs/sha256/" + desired_config]
                    while chunk := data.read(CHUNK):
                        count += len(chunk)
                        if retain and count > MAX_JSON_BYTES:
                            raise ValueError("OCI metadata exceeds 2 MiB")
                        blob_digest.update(chunk)
                        if retain:
                            retained.append(chunk)
                    if count != member.size:
                        raise ValueError("Truncated OCI member")
                    if name.startswith("blobs/") and blob_digest.hexdigest() != name.split("/")[-1]:
                        raise ValueError("OCI blob filename/hash mismatch")
                    if retain:
                        json_blobs[name] = json.loads(b"".join(retained))
            # Drain padding/trailing data to verify ALL raw archive bytes and ZIP CRC.
            while reader.read(CHUNK):
                pass
            if reader.count != entry.file_size or reader.digest.hexdigest() != expected["archiveSha256"]:
                raise ValueError("OCI archive differs from the scanned archive receipt")
    index = json_blobs.get("index.json", {})
    descriptors = index.get("manifests", [])
    if index.get("schemaVersion") != 2 or len(descriptors) != 1 or descriptors[0].get("digest") != "sha256:" + desired_manifest:
        raise ValueError("OCI index does not bind exactly the scanned manifest")
    if json_blobs.get("oci-layout") != {"imageLayoutVersion": "1.0.0"}:
        raise ValueError("Invalid OCI layout")
    manifest = json_blobs.get("blobs/sha256/" + desired_manifest, {})
    config = json_blobs.get("blobs/sha256/" + desired_config, {})
    if manifest.get("schemaVersion") != 2 or manifest.get("config", {}).get("digest") != "sha256:" + desired_config:
        raise ValueError("OCI manifest does not bind inspected config")
    if config.get("architecture") != "arm64" or config.get("os") != "linux" or config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != expected["sourceSha"]:
        raise ValueError("OCI config does not bind execution SHA and ARM")
    for layer in manifest.get("layers", []):
        value = layer.get("digest", "").removeprefix("sha256:")
        if not HEX.fullmatch(value) or "blobs/sha256/" + value not in seen:
            raise ValueError("OCI layer missing from transported archive")
    return {"schemaVersion": 1, "artifactId": expected["id"], "zipDigest": expected["digest"],
            "zipSizeBytes": size, "archiveSha256": expected["archiveSha256"], "archiveSizeBytes": reader.count}

def main():
    if len(sys.argv) != 1:
        raise ValueError("No file, program or evidence-path overrides accepted")
    def timeout(signum, frame):
        raise TimeoutError("Streaming download/verification exceeded 600 seconds")
    signal.signal(signal.SIGALRM, timeout)
    signal.signal(signal.SIGTERM, timeout)
    signal.alarm(600)
    expected = json.load(sys.stdin)
    if not isinstance(expected.get("id"), int) or expected["id"] <= 0 or not 0 < expected.get("size_in_bytes", 0) <= MAX_ZIP_BYTES:
        raise ValueError("Invalid authenticated OCI artifact metadata")
    env = os.environ.copy()
    for key in list(env):
        if re.match(r"^(GH_|GITHUB_|GIT_|BUN_|NPM_CONFIG_|XDG_CONFIG_HOME$)", key, re.I):
            del env[key]
    with tempfile.TemporaryDirectory(prefix="forge-oci-authenticated-") as owned:
        path = Path(owned) / "transport.zip"
        command = ["/usr/bin/gh", "api", "--hostname", "github.com", "--method", "GET",
                   f'repos/OxyHQ/oxy/actions/artifacts/{expected["id"]}/zip']
        process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            count = 0
            with path.open("xb") as output:
                while chunk := process.stdout.read(CHUNK):
                    count += len(chunk)
                    if count > MAX_ZIP_BYTES or count > expected["size_in_bytes"]:
                        raise ValueError("Downloaded OCI ZIP exceeds authenticated size/limit")
                    output.write(chunk)
            if process.wait(timeout=60) != 0:
                raise ValueError("Authenticated OCI artifact download failed")
            print(json.dumps(verify_zip(path, expected)))
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
