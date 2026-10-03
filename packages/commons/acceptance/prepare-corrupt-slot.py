#!/usr/bin/env python3
"""Prepare owned-fixture bytes offline. Never invokes ADB or changes a device."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import xml.etree.ElementTree as ET

TARGET = 'oxy_shared_device_session.xml'
KEY = '__androidx_security_crypto_encrypted_prefs_key_keyset__'
MAX_BYTES = 131072

def digest(value):
    return hashlib.sha256(value).hexdigest()

def corrupt_slot(data, expected_sha256):
    if len(data) > MAX_BYTES or digest(data) != expected_sha256:
        raise ValueError('Input size or expected hash mismatch')
    text = data.decode('utf-8', errors='strict')
    if '<!' in text:
        raise ValueError('Declarations/entities are not accepted')
    tree = ET.fromstring(text)
    if tree.tag != 'map':
        raise ValueError('Expected Android preferences map')
    nodes = [node for node in tree if node.tag == 'string' and node.get('name') == KEY]
    if len(nodes) != 1 or not re.fullmatch(r'[0-9a-fA-F]{32,}', nodes[0].text or ''):
        raise ValueError('Expected one hexadecimal encrypted keyset')
    pattern = re.compile(rb'(<string name="' + KEY.encode() + rb'">)([0-9a-fA-F]+)(</string>)')
    matches = list(pattern.finditer(data))
    if len(matches) != 1:
        raise ValueError('Expected exact Android serialization once')
    match = matches[0]
    position = match.end(2) - 1
    replacement = b'1' if data[position:position + 1] == b'0' else b'0'
    changed = data[:position] + replacement + data[position + 1:]
    if sum(a != b for a, b in zip(data, changed)) != 1:
        raise ValueError('Expected exactly one changed ASCII byte')
    ET.fromstring(changed)
    return changed

def read_private_input(path):
    if path.name != TARGET:
        raise ValueError('Only the owned derived session preferences file is allowed')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Input must be an owned private regular file')
        if info.st_size > MAX_BYTES:
            raise ValueError('Input is too large')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(MAX_BYTES + 1)
    finally:
        os.close(fd)

def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)

def prepare(input_path, expected_sha256, output_directory):
    original = read_private_input(input_path)
    changed = corrupt_slot(original, expected_sha256)
    output_directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    write_private(output_directory / 'original.xml', original)
    write_private(output_directory / 'corrupt.xml', changed)
    receipt = {
        'fixturePackage': 'so.oxy.commons.dev',
        'deviceRelativePath': 'shared_prefs/' + TARGET,
        'inputSha256': digest(original), 'corruptSha256': digest(changed),
        'inputBytes': len(original), 'changedBytes': 1,
        'keyName': KEY, 'deviceMutated': False,
        'applyRequirements': ['root-only emulator-5580 preflight', 'owned fixture certificate and empty/prior-approved slot',
            'stop owned target and verify no .bak exists', 'CAS current device file against inputSha256',
            'private backup and readback before write', 'write only this path; verify corruptSha256 before launch'],
        'rollbackRequirement': 'Restore backup only while current device bytes still equal corruptSha256; never overwrite a subsequently healed/reseeded file',
    }
    write_private(output_directory / 'receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())
    return receipt

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        receipt = prepare(args.input, args.expected_sha256, args.output_directory)
        print(json.dumps(receipt))
    except (OSError, ValueError, ET.ParseError) as error:
        raise SystemExit('Fixture preparation refused: ' + type(error).__name__) from None

if __name__ == '__main__':
    main()
