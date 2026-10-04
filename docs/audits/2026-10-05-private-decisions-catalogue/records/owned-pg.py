#!/usr/bin/env python3
"""Test final composition live credential context only on a new, locally owned PostgreSQL process.

No connection-string input is accepted. Every libpq override is scrubbed. The
server is started from a fresh initdb inside this worktree, and its PID, data
directory, executable and listening socket are checked before CREATE
DATABASE. A loopback tunnel cannot satisfy those checks.
"""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

ROOT = Path('/home/nate/Oxy/oxy/.worktrees/1572-decisions-catalogue-output-20261005')
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5813


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
    scratch = Path('/home/nate/Oxy/.agent-evidence/integration-decisions-catalogue-20261005')
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
            migration = subprocess.run(['bun', '--no-env-file', 'run', 'db:migrate'], cwd=ROOT / 'packages/api', env=env,
                                       text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
            migration_log = owned / f'migrate-{stage}.txt'
            migration_log.write_text(migration.stdout)
            print(json.dumps({'stage': stage, 'exitCode': migration.returncode, 'log': str(migration_log)}))
            migration.check_returncode()
        source = ROOT / 'packages/api/src/services/kaanaCatalogueSync.service.ts'
        final_source = source.read_bytes()
        try:
            source.write_bytes(subprocess.check_output(['git', 'show', 'b26725db4:packages/api/src/services/kaanaCatalogueSync.service.ts'], cwd=ROOT))
            red = subprocess.run(['bun', '--no-env-file', 'run', 'test', '--runInBand', '--runTestsByPath', 'src/services/__tests__/scopedCataloguePublication.test.ts'], cwd=ROOT / 'packages/api', env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            (scratch / 'baseline-product-red.txt').write_text(red.stdout)
            print(json.dumps({'baselineExit': red.returncode}), flush=True)
            assert red.returncode != 0 and "1 failed, 5 passed" in red.stdout
        finally:
            source.write_bytes(final_source)
            assert source.read_bytes() == final_source
        command = ['bun', '--no-env-file', 'run', 'test', '--runInBand', '--runTestsByPath', 'src/services/__tests__/kaanaCatalogueSync.test.ts', 'src/services/__tests__/scopedCataloguePublication.test.ts', 'src/services/__tests__/privateAutoTransport.test.ts', 'src/services/__tests__/privateAutoAdmission.integration.test.ts', 'src/services/__tests__/scopedAdmission.test.ts', 'src/db/schema/__tests__/protectedColumns.test.ts', 'src/db/schema/__tests__/inferenceCatalogue.test.ts']
        env = {k: v for k, v in clean_env().items()
               if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')} | {
            'DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/{db}',
            'NODE_ENV': 'test', 'BUN_OPTIONS': '--no-env-file'}
        result = subprocess.run(command, cwd=ROOT / 'packages/api', env=env,
                                text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, check=False)
        log = owned / 'focused.txt'
        log.write_text(result.stdout)
        print(json.dumps({'newLocalServerPid': pid, 'dataDirectory': str(data),
                          'database': db, 'command': command,
                          'exitCode': result.returncode, 'log': str(log),
                          'productionAccess': False}), flush=True)
        result.check_returncode()
        routes = ['bun', '--no-env-file', 'run', 'test', '--runInBand', '--runTestsByPath', 'src/routes/__tests__/inferenceEdge.test.ts', '--testNamePattern', 'decisions']
        route_result = subprocess.run(routes, cwd=ROOT / 'packages/api', env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (scratch / 'decisions-http-focal.txt').write_text(route_result.stdout)
        print(json.dumps({'httpDecisionsExit': route_result.returncode}), flush=True)
        route_result.check_returncode()
    finally:
        if server_started:
            print(run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop']))
        shutil.rmtree(socket_dir)


if __name__ == '__main__':
    main()
