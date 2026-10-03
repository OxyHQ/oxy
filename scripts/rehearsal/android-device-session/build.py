#!/usr/bin/env python3
"""Build and inspect disposable fixture APKs only. Never invokes adb."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
GRADLE_SHA = '20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--java-home', type=Path, required=True)
    args = parser.parse_args()
    sdk, java = args.sdk.resolve(strict=True), args.java_home.resolve(strict=True)
    tools = ROOT / '.tooling'
    tools.mkdir(exist_ok=True)
    (tools / 'tmp').mkdir(exist_ok=True)
    archive = tools / 'gradle-8.13-bin.zip'
    if not archive.exists():
        with urllib.request.urlopen('https://services.gradle.org/distributions/gradle-8.13-bin.zip', timeout=60) as response:
            data = response.read(150 * 1024 * 1024 + 1)
        assert len(data) <= 150 * 1024 * 1024 and hashlib.sha256(data).hexdigest() == GRADLE_SHA
        archive.write_bytes(data)
    assert digest(archive) == GRADLE_SHA, 'Gradle archive differs from fixed distribution'
    distribution = tools / 'gradle-8.13'
    with zipfile.ZipFile(archive) as zipped:
        if not distribution.exists():
            for name in zipped.namelist():
                assert name.startswith('gradle-8.13/') and '..' not in Path(name).parts
            zipped.extractall(tools)
            (distribution / 'bin/gradle').chmod(0o755)
        for item in zipped.infolist():
            if not item.is_dir():
                assert hashlib.sha256(zipped.read(item)).hexdigest() == digest(tools / item.filename), item.filename
    env = {key: value for key, value in os.environ.items()
           if key not in ('GRADLE_OPTS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS')}
    env.update(JAVA_HOME=str(java), GRADLE_USER_HOME=str(tools / 'gradle-home'))
    env['PATH'] = str(java / 'bin') + os.pathsep + env['PATH']
    signing = ROOT / '.signing'
    signing.mkdir(exist_ok=True)
    for name in ('allowed', 'foreign'):
        path = signing / (name + '.jks')
        if not path.exists():
            subprocess.run([str(java / 'bin/keytool'), '-genkeypair', '-keystore', str(path),
                            '-storepass', 'oxy1519fixture', '-keypass', 'oxy1519fixture',
                            '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048',
                            '-validity', '14', '-dname', f'CN=Oxy1519 disposable {name} fixture',
                            '-noprompt'], env=env, check=True)
    (ROOT / 'local.properties').write_text('sdk.dir=' + str(sdk) + '\n')
    command = [str(distribution / 'bin/gradle'), '--no-daemon',
               f'-Djava.io.tmpdir={tools}/tmp', ':host:assembleDebug',
               ':peer:assembleDebug', ':foreign:assembleDebug']
    built = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (tools / 'build.log').write_text(built.stdout)
    print(built.stdout)
    built.check_returncode()
    reports = []
    packages = {'host': 'so.oxy.accounts.dev', 'peer': 'earth.mention.app.dev', 'foreign': 'onl.alia.app.dev'}
    for module, package in packages.items():
        apk = ROOT / module / 'build/outputs/apk/debug' / (module + '-debug.apk')
        cert = subprocess.check_output([str(sdk / 'build-tools/35.0.0/apksigner'), 'verify',
                                       '--print-certs', str(apk)], env=env, text=True)
        fingerprints = re.findall(r'^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})$', cert, re.MULTILINE)
        assert len(fingerprints) == 1
        manifest = subprocess.check_output([str(sdk / 'build-tools/35.0.0/aapt2'), 'dump',
                                           'xmltree', '--file', 'AndroidManifest.xml', str(apk)], env=env, text=True)
        assert 'sharedUserId' not in manifest and package in manifest
        reports.append({'module': module, 'applicationId': package, 'apk': str(apk),
                        'sha256': digest(apk), 'certificateSha256': fingerprints[0],
                        'sharedUidDeclared': False, 'manifestSha256': hashlib.sha256(manifest.encode()).hexdigest()})
        (tools / (module + '-manifest.txt')).write_text(manifest)
    assert reports[0]['certificateSha256'] == reports[1]['certificateSha256']
    assert reports[0]['certificateSha256'] != reports[2]['certificateSha256']
    provider = ROOT.parents[2] / 'packages/services/android/src/main/java'
    paths = ['so/oxy/devicesession/OxyDeviceSessionProvider.kt', 'so/oxy/devicesession/OxyDeviceSessionStore.kt',
             'so/oxy/security/OxyCallerPolicy.kt', 'so/oxy/storage/OxyEncryptedPrefs.kt']
    sources = []
    for path in paths:
        original, copied = provider / path, ROOT / 'host/build/generated/provider-sources' / path
        assert original.read_bytes() == copied.read_bytes()
        sources.append({'path': str(original.relative_to(ROOT.parents[2])), 'sha256': digest(original), 'copiedByteIdentical': True})
    report = {'buildOnly': True, 'adbInvoked': False, 'gradleArchiveSha256': GRADLE_SHA,
              'java': subprocess.check_output([str(java / 'bin/java'), '-version'], env=env, stderr=subprocess.STDOUT, text=True).strip(),
              'command': command, 'apks': reports, 'providerSources': sources}
    (tools / 'apk-proof.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
