#!/usr/bin/env python3
"""Bind a Docker save archive to the already inspected candidate image; no promotion."""
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

LIMIT = 32 * 1024 ** 3
SMALL = 256 * 1024

def digest(stream):
    value = hashlib.sha256(); count = 0
    while True:
        block = stream.read(1024 * 1024)
        if not block: break
        count += len(block)
        if count > LIMIT: raise ValueError('Archive bound exceeded')
        value.update(block)
    return value.hexdigest()

def bind(archive, inspected, source, run):
    if not re.fullmatch('[a-f0-9]{40}', source) or not re.fullmatch('[1-9][0-9]*', run):
        raise ValueError('Invalid immutable provenance')
    if inspected['Architecture'] != 'arm64' or inspected['Os'] != 'linux':
        raise ValueError('Wrong candidate platform')
    if inspected['Config']['Labels'].get('org.opencontainers.image.revision') != source:
        raise ValueError('Source label differs')
    image_id = inspected['Id']
    if not re.fullmatch('sha256:[a-f0-9]{64}', image_id): raise ValueError('Invalid image config id')
    diff_ids = inspected['RootFS']['Layers']
    if not diff_ids or not all(re.fullmatch('sha256:[a-f0-9]{64}', v) for v in diff_ids):
        raise ValueError('Missing inspected rootfs')
    path = Path(archive)
    if not path.is_file() or not 0 < path.stat().st_size <= LIMIT: raise ValueError('Invalid archive size')
    with path.open('rb') as handle: archive_sha = digest(handle)
    # No extraction or whole-layer buffering. Metadata is bounded; blobs stream.
    small = {}; blobs = {}; names = set(); metadata_bytes = 0
    with tarfile.open(path, mode='r|') as tar:
        for member in tar:
            name = member.name
            if name in names or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts:
                raise ValueError('Ambiguous archive path')
            names.add(name)
            if len(names) > 4096: raise ValueError('Archive entry count exceeded')
            if member.isdir(): continue
            if not member.isfile() or member.size > LIMIT: raise ValueError('Unexpected archive entry')
            with tar.extractfile(member) as raw:
                if member.size <= SMALL:
                    data = raw.read(SMALL + 1)
                    metadata_bytes += len(data)
                    if metadata_bytes > 2 * 1024 * 1024: raise ValueError('Archive metadata bound exceeded')
                    small[name] = data
                    blobs[name] = 'sha256:' + (digest(gzip.GzipFile(fileobj=io.BytesIO(data)))
                        if data.startswith(b'\x1f\x8b') else hashlib.sha256(data).hexdigest())
                else:
                    prefix = raw.read(2)
                    # Docker save may carry OCI compressed blobs; diffIDs bind uncompressed bytes.
                    stream = io.BufferedReader(_PrefixStream(prefix, raw))
                    decoded = gzip.GzipFile(fileobj=stream) if prefix == b'\x1f\x8b' else stream
                    blobs[name] = 'sha256:' + digest(decoded)
    manifest = json.loads(small['manifest.json'])
    if not isinstance(manifest, list) or len(manifest) != 1: raise ValueError('Archive must contain one image')
    entry = manifest[0]
    config = small[entry['Config']]
    if 'sha256:' + hashlib.sha256(config).hexdigest() != image_id: raise ValueError('Archive config differs from scan image')
    actual = json.loads(config)
    if actual['architecture'] != 'arm64' or actual['os'] != 'linux' or actual['rootfs']['diff_ids'] != diff_ids:
        raise ValueError('Archive config/rootfs differs')
    if [blobs[name] for name in entry['Layers']] != diff_ids: raise ValueError('Archive layers differ from scanned rootfs')
    return {'schemaVersion': 1, 'kind': 'old-auth-only-candidate-archive', 'format': 'docker-save-tar',
        'sourceSha': source, 'githubRunId': run, 'imageConfigId': image_id, 'architecture': 'arm64', 'os': 'linux',
        'archiveSha256': archive_sha, 'archiveBytes': path.stat().st_size, 'rootfsDiffIds': diff_ids,
        'requiredTaskMode': 'rollback-auth-only', 'requiredNodeEnv': 'production',
        'bootstrapImageVerified': False, 'securityApproved': False, 'productionReady': False}

class _PrefixStream(io.RawIOBase):
    def __init__(self, prefix, stream): self.prefix = prefix; self.stream = stream
    def readable(self): return True
    def readinto(self, output):
        data = self.prefix[:len(output)]; self.prefix = self.prefix[len(data):]
        if len(data) < len(output): data += self.stream.read(len(output) - len(data))
        output[:len(data)] = data
        return len(data)

if __name__ == '__main__':
    if len(sys.argv) != 5: raise SystemExit('archive inspection-json source-sha run-id required')
    inspected = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps(bind(sys.argv[1], inspected, sys.argv[3], sys.argv[4]), indent=2))
