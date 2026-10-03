#!/usr/bin/env python3
"""Start only WEB04 RPs against the existing owned API/IdP fixture.

No database writes, server restart, session injection or native Metro changes.
The reviewed registrar must first create webFirst/webSecond in that fixture.
"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    if len(sys.argv) != 2:
        raise SystemExit('One owned manifest path required')
    manifest_path = Path(sys.argv[1]).resolve()
    namespace = ROOT / '.integration-evidence'
    assert manifest_path.parent.parent == namespace
    assert manifest_path.name == 'manifest.json'
    assert manifest_path.parent.name.startswith('oauth1519-')
    manifest = json.loads(manifest_path.read_text())
    assert manifest['fixtureOnly'] is True
    assert manifest['origins']['api'] == 'http://127.0.0.1:17960'
    assert manifest['origins']['idp'] == 'http://127.0.0.1:17961'
    lanes = [('webFirst', 17972), ('webSecond', 17973)]
    for lane, port in lanes:
        client = manifest['clients'][lane]
        assert client['origin'] == f'http://127.0.0.1:{port}'
        assert client['redirectUri'] == f'http://127.0.0.1:{port}/'
        assert client['clientId'].startswith('oxy_dk_')
        # Fail before spawning either RP if either port is owned already.
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    stopping = False

    def interrupted(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    children = []
    logs = []
    try:
        for lane, port in lanes:
            log = (manifest_path.parent / f'{lane}.log').open('w')
            logs.append(log)
            env = {key: value for key, value in os.environ.items()
                   if key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')}
            env.update(BUN_OPTIONS='--no-env-file',
                       VITE_OXY_CLIENT_ID=manifest['clients'][lane]['clientId'],
                       VITE_FIXTURE_LANE=lane)
            command = ['bun', '--no-env-file', str(ROOT / 'node_modules/vite/bin/vite.js'),
                       str(ROOT / 'scripts/rehearsal/real-oauth-browser'), '--config',
                       str(ROOT / 'scripts/rehearsal/real-oauth-browser/vite.config.ts'),
                       '--host', '127.0.0.1', '--port', str(port), '--strictPort']
            children.append(subprocess.Popen(command, cwd=ROOT, env=env,
                            stdout=log, stderr=subprocess.STDOUT, start_new_session=True))
        print(json.dumps({'started': True, 'fixtureOnly': True, 'manifest': str(manifest_path),
                          'origins': [f'http://127.0.0.1:{port}' for _, port in lanes],
                          'pids': [child.pid for child in children],
                          'browserExecutionRequired': True}), flush=True)
        while not stopping:
            if any(child.poll() is not None for child in children):
                raise RuntimeError('RP exited; inspect its owned log')
            time.sleep(0.5)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        forced = []
        for child in reversed(children):
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
                forced.append(child.pid)
        for log in logs:
            log.close()
        print(json.dumps({'rpCleanupComplete': not forced, 'forcedStops': forced,
                          'apiIdpDatabaseUntouched': True}), flush=True)


if __name__ == '__main__':
    main()
