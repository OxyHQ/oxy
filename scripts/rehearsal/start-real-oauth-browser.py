#!/usr/bin/env python3
"""Prepare disposable real OAuth API/IdP/RP servers only on a new, locally owned PostgreSQL process.

No connection-string input is accepted. Every libpq override is scrubbed. The
server is started from a fresh initdb inside this worktree, and its PID, data
directory, executable and listening socket are checked before CREATE
DATABASE. A loopback tunnel cannot satisfy those checks.
"""
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
    if len(os.sys.argv) != 1:
        raise SystemExit('No connection or runtime overrides are accepted')
    interrupted = False
    def interrupt(_signal, _frame):
        nonlocal interrupted
        interrupted = True
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    scratch = ROOT / '.integration-evidence'
    scratch.mkdir(exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix='oauth1519-', dir=scratch))
    pg_data = owned / 'data'
    socket_dir = Path(tempfile.mkdtemp(prefix='oxy-browser-pg-'))
    started = int(time.time())
    print(run([PG / 'initdb', '-D', pg_data, '-U', 'oxy', '-A', 'trust', '--no-locale']))
    server_started = False
    try:
        print(run([PG / 'pg_ctl', '-D', pg_data, '-l', owned / 'server.log', '-w',
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
        sockets = {os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}
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
        db = 'oxy_browser_1519_' + secrets.token_hex(8)
        sql(f'CREATE DATABASE "{db}"')
        env = clean_env() | {'DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/{db}',
                            'NODE_ENV': 'test'}
        for stage in ('fresh', 'repeat'):
            migration = subprocess.run(['bun', '--no-env-file', 'run', 'db:migrate'], cwd=ROOT / 'packages/api', env=env,
                                       text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
            migration_log = owned / f'migrate-{stage}.txt'
            migration_log.write_text(migration.stdout)
            print(json.dumps({'stage': stage, 'exitCode': migration.returncode, 'log': str(migration_log)}))
            migration.check_returncode()
        # Every public frontend points to the same freshly initialized API.
        # Cwd has no .env; the real API's explicit dotenv.config() reads only it.
        children = []
        opened_logs = []
        def start(command, label, env, cwd=ROOT):
            log = (owned / f'{label}.log').open('w')
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
                     str(manifest)], 'api', fixture_env, owned)
        try:
            deadline = time.monotonic() + 60
            while not manifest.exists():
                if interrupted: raise KeyboardInterrupt
                if api.poll() is not None: raise RuntimeError('API exited before ready; inspect api.log')
                if time.monotonic() > deadline: raise RuntimeError('API ready timeout')
                time.sleep(0.1)
            manifest_data = json.loads(manifest.read_text())
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
                              'rootBrowserExecutionRequired': True}), flush=True)
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
