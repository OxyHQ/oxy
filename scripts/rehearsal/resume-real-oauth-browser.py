#!/usr/bin/env python3
"""Resume the exact stopped owned OAuth fixture without initdb, DDL or reseed.
Reject any conflicting listener/PID/data/config/manifest. Preserves existing
subjects, clients and sessions; restarts only its PG/API/IdP/third-party RPs.
First-party RPs and native Metros are independently owned and untouched.
"""
import hashlib
import re
import json
import os
from pathlib import Path
import secrets
import signal
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5589


def clean_env():
    return {k: v for k, v in os.environ.items()
            if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')} | {
                'BUN_OPTIONS': '--no-env-file'}


def run(args, **kwargs):
    return subprocess.check_output([str(x) for x in args], env=clean_env(),
                                   text=True, stderr=subprocess.STDOUT, **kwargs)


def main():
    if len(os.sys.argv) != 2:
        raise SystemExit('Exactly one owned existing manifest path required')
    interrupted = False
    def interrupt(_signal, _frame):
        nonlocal interrupted
        interrupted = True
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    manifest = Path(os.sys.argv[1]).resolve()
    owned = manifest.parent
    assert owned.parent == ROOT / '.integration-evidence' and owned.name.startswith('oauth1519-')
    assert manifest.name == 'manifest.json' and not manifest.is_symlink()
    assert manifest.stat().st_uid == os.getuid() and manifest.stat().st_mode & 0o077 == 0
    manifest_sha = hashlib.sha256(manifest.read_bytes()).hexdigest()
    prior_plan = json.loads((owned / 'web04-api-replacement-reviewed-plan.json').read_text())
    assert prior_plan['manifestSha256'] == manifest_sha, 'Original fixture manifest changed'
    saved = json.loads(manifest.read_text())
    assert saved['fixtureOnly'] is True and saved['origins']['api'] == 'http://127.0.0.1:17960'
    assert saved['origins']['idp'] == 'http://127.0.0.1:17961'
    pg_data = owned / 'data'
    assert pg_data.stat().st_uid == os.getuid() and not pg_data.is_symlink()
    assert (pg_data / 'PG_VERSION').read_text().strip() == '17'
    assert not (pg_data / 'postmaster.pid').exists(), 'Existing fixture PG is not stopped'
    for row in Path('/proc/net/tcp').read_text().splitlines()[1:]:
        parts = row.split()
        assert parts[3] != '0A' or int(parts[1].split(':')[1], 16) not in (5589, 17960, 17961, 17962, 17963, 17964), 'Fixture port already listening'
    prefix = 'resume-' + str(time.time_ns())
    socket_dir = Path(tempfile.mkdtemp(prefix='oxy-browser-pg-'))
    started = int(time.time())
    server_started = False
    try:
        print(run([PG / 'pg_ctl', '-D', pg_data, '-l', owned / f'{prefix}-postgres.log', '-w',
                   '-o', f'-h 127.0.0.1 -p {PORT} -k {socket_dir}', 'start']))
        server_started = True
        pid_rows = (pg_data / 'postmaster.pid').read_text().splitlines()
        pid = int(pid_rows[0])
        assert Path(pid_rows[1]).resolve() == pg_data.resolve()
        assert int(pid_rows[2]) >= started
        assert int(pid_rows[3]) == PORT
        assert Path(pid_rows[4]).resolve() == socket_dir.resolve()
        assert Path(f'/proc/{pid}').stat().st_uid == os.getuid()
        assert Path(f'/proc/{pid}/exe').resolve() == (PG / 'postgres').resolve()
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        assert b'-D' in args and str(pg_data).encode() in args
        sockets = set()
        for fd in Path(f'/proc/{pid}/fd').iterdir():
            try: sockets.add(os.readlink(fd))
            except FileNotFoundError: continue
        listeners = [row.split() for row in Path('/proc/net/tcp').read_text().splitlines()[1:]]
        matches = [row for row in listeners
                   if row[1] == f'0100007F:{PORT:04X}' and row[3] == '0A']
        assert len(matches) == 1 and f'socket:[{matches[0][9]}]' in sockets

        def sql(query, db='postgres'):
            return run([PG / 'psql', '-X', '-h', '127.0.0.1', '-p', PORT,
                        '-U', 'oxy', '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atc', query]).strip()

        reported = sql("SELECT current_setting('data_directory') || '|' || pg_backend_pid()")
        reported_data, backend = reported.split('|')
        assert Path(reported_data).resolve() == pg_data.resolve()
        # The port-owning process itself was independently validated above.
        assert sql("SELECT system_identifier FROM pg_control_system()")
        names = sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10000'; SELECT datname FROM pg_database WHERE datname ~ '^oxy_browser_1519_[a-f0-9]{16}$'; ROLLBACK").splitlines()
        names = [name for name in names if re.fullmatch(r'oxy_browser_1519_[a-f0-9]{16}', name)]
        assert len(names) == 1
        db = names[0]
        prior_database = prior_plan['originalApi']['cwd']  # Path binding, never another URL
        assert prior_database == str(owned)
        before_counts = sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10000'; SELECT json_build_object('users',(SELECT count(*) FROM users),'applications',(SELECT count(*) FROM applications),'credentials',(SELECT count(*) FROM application_credentials),'sessions',(SELECT count(*) FROM sessions)); ROLLBACK", db)
        # Source-owned synthetic constants below are the original fixture's.
        # Cwd is the same owned namespace; no inherited .env is allowed.
        children = []
        opened_logs = []
        def start(command, label, env, cwd=ROOT):
            log = (owned / f'{prefix}-{label}.log').open('x')
            os.chmod(log.name, 0o600)
            opened_logs.append(log)
            child = subprocess.Popen(command, cwd=cwd, env=env,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            children.append(child)
            return child
        manifest = owned / 'manifest.json'
        fixture_env = clean_env() | {
            'DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/{db}',
            'NODE_ENV': 'test', 'PORT': '17960',
            'ACCESS_TOKEN_SECRET': 'fixture-real-oauth-access-secret-64-characters-no-production',
            'REFRESH_TOKEN_SECRET': 'fixture-real-oauth-refresh-secret-64-characters-no-production',
            'DEVICE_ID_SALT': 'fixture-real-oauth-device-salt-64-characters-no-production',
            'AWS_REGION': 'us-west-2', 'AWS_ACCESS_KEY_ID': 'fixture-no-aws-key',
            'AWS_SECRET_ACCESS_KEY': 'fixture-no-aws-secret', 'AWS_S3_BUCKET': 'fixture-no-bucket',
            'AUTH_WEB_ORIGIN': 'http://127.0.0.1:17961',
            'OXY_API_URL': 'http://127.0.0.1:17960', 'ASSET_CDN_URL': 'http://127.0.0.1:17960',
            'LOG_LEVEL': 'warn', 'SMTP_RELAY_HOST': '127.0.0.1', 'SMTP_RELAY_PORT': '17964'}
        api = start(['bun', '--no-env-file', str(ROOT / 'packages/api/scripts/real-oauth-browser-api.ts'),
                     str(manifest), '--resume'], 'api', fixture_env, owned)
        try:
            deadline = time.monotonic() + 60
            while '"resumed":true' not in (owned / f'{prefix}-api.log').read_text():
                if interrupted: raise KeyboardInterrupt
                if api.poll() is not None: raise RuntimeError('API exited before ready; inspect api.log')
                if time.monotonic() > deadline: raise RuntimeError('API ready timeout')
                time.sleep(0.1)
            assert hashlib.sha256(manifest.read_bytes()).hexdigest() == manifest_sha
            after_counts = sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10000'; SELECT json_build_object('users',(SELECT count(*) FROM users),'applications',(SELECT count(*) FROM applications),'credentials',(SELECT count(*) FROM application_credentials),'sessions',(SELECT count(*) FROM sessions)); ROLLBACK", db)
            assert before_counts == after_counts, 'Resume changed subjects/applications/credentials/session counts'
            manifest_data = saved
            # The actual auth frontend, no replacement authorize page.
            start(['bun', '--no-env-file', str(ROOT / 'packages/auth/node_modules/vite/bin/vite.js'),
                   str(ROOT / 'packages/auth'), '--host', '127.0.0.1', '--port', '17961', '--strictPort'],
                  'idp', clean_env() | {'VITE_OXY_API_URL': manifest_data['origins']['api'],
                      'VITE_OXY_AUTH_URL': manifest_data['origins']['api'],
                      'VITE_OXY_CLIENT_ID': manifest_data['clients']['idp']['clientId']})
            for lane, port in [('a', '17962'), ('b', '17963')]:
                start(['bun', '--no-env-file', str(ROOT / 'node_modules/vite/bin/vite.js'),
                       str(ROOT / 'scripts/rehearsal/real-oauth-browser'), '--config',
                       str(ROOT / 'scripts/rehearsal/real-oauth-browser/vite.config.ts'),
                       '--host', '127.0.0.1', '--port', port, '--strictPort'],
                      f'rp-{lane}', clean_env() | {'VITE_OXY_CLIENT_ID': manifest_data['clients'][lane]['clientId'],
                          'VITE_FIXTURE_LANE': lane})
            print(json.dumps({'fixtureReady': True, 'manifest': str(manifest),
                              'postgresPid': pid, 'origins': manifest_data['origins'],
                              'rootBrowserExecutionRequired': True, 'resumedExistingData': True, 'manifestSha256': manifest_sha, 'noInitdbNoMigrationNoSeed': True, 'countsUnchanged': True}), flush=True)
            # Foreground host: root operates Chromium in a separate process.
            # Interrupting this launcher always tears down its children + PG.
            while True:
                if interrupted: raise KeyboardInterrupt
                if any(child.poll() is not None for child in children):
                    raise RuntimeError('Fixture server exited unexpectedly')
                time.sleep(0.5)
        finally:
            for child in reversed(children):
                if child.poll() is None:
                    try: os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
            for child in reversed(children):
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=10)
                    print(json.dumps({'forcedChildStop': child.pid, 'cleanupIncomplete': True}), flush=True)
            for log in opened_logs: log.close()
    finally:
        if server_started:
            print(run([PG / 'pg_ctl', '-D', pg_data, '-m', 'fast', '-w', 'stop']))
        shutil.rmtree(socket_dir)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({'fixtureInterrupted': True, 'ownedCleanupFinished': True}), flush=True)
