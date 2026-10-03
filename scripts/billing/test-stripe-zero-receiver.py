#!/usr/bin/env python3
"""Reproduce an owned zero-invoice event through the real raw-body webhook receiver only on a new, locally owned PostgreSQL process.

No connection-string input is accepted. Every libpq override is scrubbed. The
server is started from a fresh initdb inside this worktree, and its PID, data
directory, executable and listening socket are checked before CREATE
DATABASE. A loopback tunnel cannot satisfy those checks.
"""
import json
import importlib.util
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5597

# Reuse the reviewed process-group coordinator; this entrypoint creates no
# provider objects, but still must stop its child before its owned database.
_spec = importlib.util.spec_from_file_location('stripe_owned_launcher', ROOT / 'scripts/billing/stripe-oxy-sandbox.py')
_launcher = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_launcher)
SignalCoordinator = _launcher.SignalCoordinator



def clean_env():
    return {k: v for k, v in os.environ.items()
            if k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')} | {'BUN_OPTIONS':'--no-env-file'}


def run(args, **kwargs):
    return subprocess.check_output([str(x) for x in args], env=clean_env(),
                                   text=True, stderr=subprocess.STDOUT, **kwargs)


def main_owned(coordinator):
    if len(os.sys.argv) != 2:
        raise SystemExit('No connection or runtime overrides are accepted')
    scratch = ROOT / '.billing-evidence'
    scratch.mkdir(exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix='pg1519-', dir=scratch))
    data = owned / 'data'
    socket_dir = Path(tempfile.mkdtemp(prefix='oxy-billing-pg-'))
    started = int(time.time())
    print(run([PG / 'initdb', '-D', data, '-U', 'oxy', '-A', 'trust', '--no-locale']))
    server_started = False
    try:
        print(run([PG / 'pg_ctl', '-D', data, '-l', owned / 'server.log', '-w',
                   '-o', f'-h 127.0.0.1 -p {PORT} -k {socket_dir}', 'start']))
        server_started = True
        pid_rows = (data / 'postmaster.pid').read_text().splitlines()
        pid = int(pid_rows[0])
        assert Path(pid_rows[1]).resolve() == data.resolve()
        assert int(pid_rows[2]) >= started
        assert int(pid_rows[3]) == PORT
        assert Path(pid_rows[4]).resolve() == socket_dir.resolve()
        assert Path(f'/proc/{pid}').stat().st_uid == os.getuid()
        assert Path(f'/proc/{pid}/exe').resolve() == (PG / 'postgres').resolve()
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        assert b'-D' in args and str(data).encode() in args
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
        assert Path(reported_data).resolve() == data.resolve()
        # The port-owning process itself was independently validated above.
        assert sql("SELECT system_identifier FROM pg_control_system()")
        db = 'oxy_rehearsal_1519_' + secrets.token_hex(8)
        sql(f'CREATE DATABASE "{db}"')
        env = clean_env() | {'DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/{db}',
                            'NODE_ENV': 'test'}
        for stage in ('fresh', 'repeat'):
            migration = coordinator.run(['bun', '--no-env-file', 'run', 'db:migrate'], cwd=ROOT / 'packages/api', env=env,
                                       text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            migration_log = owned / f'migrate-{stage}.txt'
            migration_log.write_text(migration.stdout)
            print(json.dumps({'stage': stage, 'exitCode': migration.returncode, 'log': str(migration_log)}))
            migration.check_returncode()
        # Separate newly-created sandbox DB; never mark an existing database.
        sandbox = 'oxy_crypto_1519_' + secrets.token_hex(8)
        sql(f'CREATE DATABASE "{sandbox}"')
        assert sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'", sandbox) == '0'
        sql(f'ALTER DATABASE "{sandbox}" SET oxy.billing_namespace TO \'test:test\'')
        fixture_env = clean_env() | {
            'DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/{sandbox}',
            'NODE_ENV':'test', 'BILLING_PROCESSOR_ENVIRONMENT':'test', 'LOG_LEVEL':'silent',
            'STRIPE_SECRET_KEY':'sk_test_offline_fixture','STRIPE_WEBHOOK_SECRET':'whsec_offline_fixture'}
        migration = coordinator.run(['bun','--no-env-file','run','db:migrate'],cwd=ROOT/'packages/api',env=fixture_env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (owned/'sandbox-migration.log').write_text(migration.stdout);migration.check_returncode()
        command = ['bun','--no-env-file','scripts/billing/test-stripe-zero-receiver.mjs',os.sys.argv[1]]
        result = coordinator.run(command,cwd=ROOT,env=fixture_env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        log=owned/'zero-receiver.log';log.write_text(result.stdout)
        print(json.dumps({'childStopped':coordinator.last_child_stopped,'forced':coordinator.forced,'requestedSignal':coordinator.requested_signal,'newLocalServerPid':pid,'exitCode':result.returncode,'log':str(log),'output':result.stdout,'productionAccess':False}))
        result.check_returncode()

    finally:
        print(json.dumps({'phase':'beforeOwnedPgStop','childStopped':coordinator.last_child_stopped,'forced':coordinator.forced,'requestedSignal':coordinator.requested_signal}))
        if server_started:
            print(run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop']))
        shutil.rmtree(socket_dir)


def main():
    with SignalCoordinator(cleanup_timeout_seconds=30) as coordinator:
        main_owned(coordinator)


if __name__ == '__main__':
    main()
