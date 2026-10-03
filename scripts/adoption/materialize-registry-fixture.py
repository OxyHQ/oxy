#!/usr/bin/env python3
"""Copy reviewed standalone inputs only. Never install, launch, or touch a device."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
TEMPLATES = Path(__file__).resolve().parent / 'registry-fixtures'

def materialize(kind, output):
    if kind not in ('native', 'web'): raise ValueError('Unknown fixture kind')
    output = output.resolve()
    for parent in output.parents:
        if (parent / 'package.json').exists() or (parent / 'node_modules').exists():
            raise ValueError('Fixture must be outside existing package/workspace resolution')
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    records = []
    for source in sorted((TEMPLATES / kind).rglob('*')):
        if not source.is_file():
            continue
        if source.is_symlink():
            raise ValueError('Symlink template refused')
        relative = source.relative_to(TEMPLATES / kind)
        destination = output / relative
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destination.chmod(0o600)
        records.append({'path': str(relative), 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()})
    receipt = {'kind': kind, 'output': str(output), 'files': records, 'installed': False, 'launched': False}
    fd = os.open(output / 'materialized.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(receipt, stream, indent=2);stream.write('\n')
    return receipt

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', choices=['native', 'web'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(materialize(args.kind, args.output)))
