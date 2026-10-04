#!/usr/bin/env python3
"""Verify the truthful tooling fork, adapter source archive, and Forge-free lock."""
import base64
import hashlib
import json
from pathlib import Path
import tarfile
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor/expo-native'


def files(archive):
    result = {}
    with tarfile.open(archive, 'r:gz') as source:
        for member in source.getmembers():
            if member.isdir():
                continue
            assert member.isfile(), 'Only regular files are admitted in tooling archives'
            assert member.name.startswith('package/') and '..' not in Path(member.name).parts
            assert member.name not in result, 'Duplicate archive member'
            result[member.name.removeprefix('package/')] = source.extractfile(member).read()
    return result


def verify(include_installed=False):
    upstream = (VENDOR / 'expo-cli-57.0.23-upstream.tgz').read_bytes()
    identity = json.loads((VENDOR / 'upstream-integrity.json').read_text())
    assert identity['integrity'] == 'sha512-' + base64.b64encode(hashlib.sha512(upstream).digest()).decode()
    assert identity['sha256'] == hashlib.sha256(upstream).hexdigest()
    assert identity['size'] == len(upstream)
    old = files(VENDOR / 'expo-cli-57.0.23-upstream.tgz')
    cli = files(VENDOR / 'oxy.so-expo-cli-native-57.0.23+oxy.native.1.tgz')
    native = files(VENDOR / 'oxy.so-expo-code-signing-native-0.1.1.tgz')
    modified = sorted(name for name in old.keys() | cli.keys() if old.get(name) != cli.get(name))
    expected = ['build/src/run/ios/codeSigning/Security.js', 'build/src/run/ios/codeSigning/Security.js.map', 'package.json']
    assert modified == expected, f'Unreviewed CLI delta: {modified}'
    previous = json.loads(old['package.json'])
    current = json.loads(cli['package.json'])
    assert previous['name'] == '@expo/cli' and previous['version'] == '57.0.23'
    assert current['name'] == '@oxy.so/expo-cli-native' and current['version'] == '57.0.23+oxy.native.1'
    current_without_identity = dict(current)
    current_without_identity.pop('oxyUpstream')
    current_without_identity['name'] = previous['name']
    current_without_identity['version'] = previous['version']
    current_without_identity['dependencies'] = dict(current['dependencies'], **{'node-forge': '^1.3.3'})
    assert current_without_identity == previous, 'Other upstream manifest fields changed'
    expected_security = old['build/src/run/ios/codeSigning/Security.js'].decode().replace('_nodeforge', '_nativeCodeSigning').replace('require("node-forge")', 'require("@expo/code-signing-certificates")').replace('_nativeCodeSigning().default.pki.certificateFromPem(pem)', '_nativeCodeSigning().default.convertCertificatePEMToCertificate(pem)')
    import re
    expected_security = re.sub(r'\n//# sourceMappingURL=Security\.js\.map\s*$', '\n', expected_security)
    source = cli['build/src/run/ios/codeSigning/Security.js'].decode()
    assert source == expected_security, 'Other compiled CLI parser bytes changed'
    assert 'node-forge' not in source and 'pki.certificateFromPem' not in source
    assert 'convertCertificatePEMToCertificate(pem)' in source
    assert 'sourceMappingURL' not in source, 'Stale upstream source map retained'
    assert sorted(native) == ['LICENSE', 'README.md', 'index.cjs', 'index.d.ts', 'package.json']
    for name, data in native.items():
        source_data = (ROOT / 'tooling/expo-code-signing-native' / name).read_bytes()
        if name == 'package.json':
            # Formatting only: every manifest field remains semantically sealed.
            assert json.loads(data) == json.loads(source_data), 'Adapter manifest fields differ'
        else:
            assert data == source_data, f'Adapter archive/source differs: {name}'
    assert json.loads(native['package.json'])['name'] == '@oxy.so/expo-code-signing-native'
    lock = (ROOT / 'bun.lock').read_text()
    assert 'node-forge' not in lock, 'Forge is still in the actual dependency graph'
    assert not list((ROOT / 'node_modules/.bun').glob('node-forge@*')), 'An installed Forge copy remains'
    root = json.loads((ROOT / 'package.json').read_text())
    assert 'patchedDependencies' not in root, 'Temporary Forge patch still active'
    for package, archive in [('@expo/cli', 'oxy.so-expo-cli-native-57.0.23+oxy.native.1.tgz'), ('@expo/code-signing-certificates', 'oxy.so-expo-code-signing-native-0.1.1.tgz')]:
        assert root['overrides'][package] == 'file:./vendor/expo-native/' + archive
    for package in ['core', 'contracts', 'services', 'protocol', 'mcp', 'db']:
        manifest = json.loads((ROOT / 'packages' / package / 'package.json').read_text())
        for group in ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']:
            for specifier, value in manifest.get(group, {}).items():
                assert 'expo-native' not in value and 'expo-code-signing-native' not in value and not value.startswith('file:'), f'Local tooling reference leaked to published manifest {package}/{specifier}'
    installed = None
    if include_installed:
        code = """const fs=require('node:fs'),p=require('node:path'),{createRequire}=require('node:module');
const api=createRequire(p.resolve('packages/api/package.json'));
const expo=createRequire(require.resolve('expo/package.json'));
const cliPath=expo.resolve('@expo/cli/package.json');const cli=createRequire(cliPath);
for(const r of [api,cli]){try{r.resolve('node-forge');throw Error('Forge remains resolvable')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}}
console.log(JSON.stringify({cli:p.dirname(cliPath),adapter:p.dirname(api.resolve('@expo/code-signing-certificates/package.json')),cliAdapter:p.dirname(cli.resolve('@expo/code-signing-certificates/package.json'))}));"""
        env = dict(os.environ)
        for key in ['NODE_OPTIONS', 'NODE_PATH']:
            env.pop(key, None)
        locations = json.loads(subprocess.check_output(['node', '-e', code], cwd=ROOT, env=env, text=True))
        counts = {}
        for label, records in [('cli', cli), ('adapter', native), ('cliAdapter', native)]:
            location = Path(locations[label])
            for name, data in records.items():
                actual = (location / name).read_bytes()
                if name == 'package.json':
                    assert json.loads(actual) == json.loads(data), f'Installed {label} manifest differs'
                else:
                    assert actual == data, f'Installed {label} archive bytes differ: {name}'
            counts[label] = len(records)
        installed = {'comparedFiles': counts, 'forgeResolvableFromAPIOrCLI': False}
    return {'schemaVersion': 1, 'cliUpstream': '57.0.23', 'cliFork': current['name'], 'changedUpstreamFiles': modified, 'unchangedUpstreamFiles': len(old) - len(modified), 'adapterFiles': len(native), 'forgeInLock': False, 'installedValidation': installed, 'publishedManifestLocalReferences': False, 'archives': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in VENDOR.glob('*.tgz')}}


if __name__ == '__main__':
    print(json.dumps(verify(include_installed=True), indent=2))
