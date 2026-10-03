#!/usr/bin/env python3
"""Explicit handover of this owned fixture API; keeps PG/IdP/RPs, never reseeds.
Prepare has no process mutation. Execute pauses the original supervisor, replaces
only its API child, and keeps cleanup ownership until interrupted: replacement
stops first, then the original supervisor resumes its existing full teardown.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path('/usr/lib/postgresql/17/bin')
API = ROOT / 'packages/api/scripts/real-oauth-browser-api.ts'
ROUTE = ROOT / 'packages/api/src/routes/sessionDevice.ts'
SUPERVISOR = ROOT / 'scripts/rehearsal/start-real-oauth-browser.py'
ALLOW = {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'BUN_OPTIONS', 'DATABASE_URL',
         'NODE_ENV', 'PORT', 'ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET',
         'DEVICE_ID_SALT', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
         'AWS_S3_BUCKET', 'AUTH_WEB_ORIGIN', 'OXY_API_URL', 'ASSET_CDN_URL',
         'LOG_LEVEL', 'SMTP_RELAY_HOST', 'SMTP_RELAY_PORT'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def process(pid):
    path = Path(f'/proc/{pid}')
    assert path.stat().st_uid == os.getuid(), 'Process owner mismatch'
    # The comm field can contain spaces; the starttime index follows its final ).
    fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'parent': int(fields[1]), 'group': int(fields[2]),
            'starttime': fields[19], 'exe': str((path / 'exe').resolve()),
            'cwd': str((path / 'cwd').resolve()),
            'argv': [part.decode() for part in (path / 'cmdline').read_bytes().split(b'\0') if part]}


def listener(port, pid):
    sockets = {os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}
    rows = [line.split() for line in Path('/proc/net/tcp').read_text().splitlines()[1:]]
    matches = [row for row in rows if row[1] == f'0100007F:{port:04X}' and row[3] == '0A']
    assert len(matches) == 1 and f'socket:[{matches[0][9]}]' in sockets, 'Listener owner mismatch'


def capture(manifest_path):
    manifest_path = manifest_path.resolve()
    owned = manifest_path.parent
    assert owned.parent == ROOT / '.integration-evidence' and owned.name.startswith('oauth1519-')
    assert manifest_path.name == 'manifest.json' and not manifest_path.is_symlink()
    assert manifest_path.stat().st_uid == os.getuid() and manifest_path.stat().st_mode & 0o077 == 0
    manifest = json.loads(manifest_path.read_text())
    assert manifest['fixtureOnly'] is True and manifest['origins']['api'] == 'http://127.0.0.1:17960'
    rows = (owned / 'data/postmaster.pid').read_text().splitlines()
    postgres = process(int(rows[0]))
    assert postgres['exe'] == str(PG / 'postgres')
    assert Path(rows[1]).resolve() == owned / 'data' and rows[3] == '5589'
    assert '-D' in postgres['argv'] and str(owned / 'data') in postgres['argv']
    listener(5589, postgres['pid'])
    candidates = []
    for item in Path('/proc').iterdir():
        if not item.name.isdecimal(): continue
        try:
            record = process(int(item.name))
            if record['argv'][1:] == ['--no-env-file', str(API), str(manifest_path)]: candidates.append(record)
        except (FileNotFoundError, ProcessLookupError, PermissionError, AssertionError): pass
    assert len(candidates) == 1, 'Exactly one original API child required'
    api = candidates[0]
    parent = process(api['parent'])
    assert parent['argv'][1:] == ['-u', str(SUPERVISOR.relative_to(ROOT))]
    assert parent['cwd'] == str(ROOT) and 'python3' in Path(parent['exe']).name
    assert api['cwd'] == str(owned) and api['group'] == api['pid'] and 'bun' in Path(api['exe']).name
    listener(17960, api['pid']); listener(17964, api['pid'])
    raw_env = {item.split(b'=', 1)[0].decode(): item.split(b'=', 1)[1].decode()
               for item in Path(f'/proc/{api["pid"]}/environ').read_bytes().split(b'\0') if item}
    env = {key: value for key, value in raw_env.items() if key in ALLOW}
    assert env['NODE_ENV'] == 'test' and env['PORT'] == '17960'
    assert re.fullmatch(r'postgresql://oxy@127\.0\.0\.1:5589/oxy_browser_1519_[a-f0-9]{16}', env['DATABASE_URL'])
    assert env['ACCESS_TOKEN_SECRET'] == 'fixture-real-oauth-access-secret-64-characters-no-production'
    assert env['REFRESH_TOKEN_SECRET'] == 'fixture-real-oauth-refresh-secret-64-characters-no-production'
    assert env['AWS_ACCESS_KEY_ID'] == 'fixture-no-aws-key' and env['AWS_SECRET_ACCESS_KEY'] == 'fixture-no-aws-secret'
    assert env['SMTP_RELAY_HOST'] == '127.0.0.1' and env['SMTP_RELAY_PORT'] == '17964'
    env['BUN_OPTIONS'] = '--no-env-file'
    env_hash = hashlib.sha256(json.dumps(env, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    plan = {'manifest': str(manifest_path), 'manifestSha256': sha(manifest_path),
            'postgres': postgres, 'originalApi': api, 'supervisor': parent,
            'sourceInputs': {str(path.relative_to(ROOT)): sha(path) for path in [API, ROUTE, SUPERVISOR, Path(__file__)]},
            'environmentKeys': sorted(env), 'environmentSha256': env_hash,
            'replacementCommand': [api['exe'], '--no-env-file', str(API), str(manifest_path), '--resume'],
            'noReseed': True, 'cleanup': 'stop replacement, then resume original supervisor for full fixture teardown'}
    return plan, env


def write_json(path, value):
    with path.open('x') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2); stream.write('\n')


def main():
    assert len(sys.argv) == 4 and sys.argv[1] in ['--prepare', '--execute']
    manifest, output = Path(sys.argv[2]), Path(sys.argv[3]).resolve()
    assert output.parent == manifest.resolve().parent
    current, env = capture(manifest)
    if sys.argv[1] == '--prepare':
        write_json(output, current)
        print(json.dumps({'prepared': True, 'plan': str(output), 'sha256': sha(output), 'noProcessMutation': True}), flush=True)
        return
    previous = json.loads(output.read_text())
    assert current == previous, 'Fixture process/source/config drift; prepare again'
    supervisor_pid, api_pid = current['supervisor']['pid'], current['originalApi']['pid']
    receipt = output.with_name(output.stem + '-receipt.json')
    assert not receipt.exists()
    interrupted = False
    def interrupt(_sig, _frame):
        nonlocal interrupted
        interrupted = True
    signal.signal(signal.SIGTERM, interrupt); signal.signal(signal.SIGINT, interrupt)
    replacement, paused = None, False
    result = {'planSha256': sha(output), 'noReseed': True, 'cleanup': []}
    try:
        os.kill(supervisor_pid, signal.SIGSTOP); paused = True
        deadline = time.monotonic() + 5
        while True:
            assert process(supervisor_pid) == current['supervisor']
            state = Path(f'/proc/{supervisor_pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
            if state in ('T', 't'): break
            assert not interrupted and time.monotonic() < deadline, 'Supervisor pause not confirmed'
            time.sleep(0.05)
        os.killpg(api_pid, signal.SIGTERM)
        deadline = time.monotonic() + 20
        while True:
            try:
                state = Path(f'/proc/{api_pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
                if state == 'Z': break  # stopped supervisor has not reaped its child yet
            except FileNotFoundError: break
            assert not interrupted and time.monotonic() < deadline, 'Graceful original API stop timeout'
            time.sleep(0.1)
        with output.with_name(output.stem + '-replacement-api.log').open('x') as log:
            os.chmod(log.name, 0o600)
            replacement = subprocess.Popen(current['replacementCommand'], cwd=manifest.parent, env=env,
                                           stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 60
            while True:
                assert replacement.poll() is None, 'Replacement API exited during startup'
                assert not interrupted and time.monotonic() < deadline, 'Replacement startup timeout'
                try:
                    listener(17960, replacement.pid); listener(17964, replacement.pid)
                    assert '"resumed":true' in Path(log.name).read_text()
                    break
                except AssertionError: time.sleep(0.1)
            assert sha(manifest) == current['manifestSha256'], 'Resume changed fixture manifest'
            assert process(current['postgres']['pid']) == current['postgres']
            result.update({'replacement': process(replacement.pid), 'ready': True, 'manifestUnchanged': True, 'postgresUnchanged': True})
            write_json(receipt, result)
            print(json.dumps({'replacementReady': True, 'apiPid': replacement.pid, 'receipt': str(receipt), 'originalSupervisorPaused': True}), flush=True)
            while not interrupted:
                assert replacement.poll() is None, 'Replacement API exited unexpectedly'
                assert process(current['postgres']['pid']) == current['postgres']
                time.sleep(0.5)
    finally:
        if replacement and replacement.poll() is None:
            os.killpg(replacement.pid, signal.SIGTERM)
            try: replacement.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(replacement.pid, signal.SIGKILL); replacement.wait(timeout=10)
                result['cleanup'].append('replacement required forced stop')
        if paused:
            os.kill(supervisor_pid, signal.SIGCONT)
            result['cleanup'].append('original supervisor resumed for normal full teardown')
        write_json(output.with_name(output.stem + '-cleanup.json'), result)


if __name__ == '__main__':
    main()
