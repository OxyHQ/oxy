#!/usr/bin/env python3
"""Upgrade a 0141 fixture with the shared normal migrator, then apply/repeat actual 0142.

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

ROOT = Path(__file__).resolve().parents[2]
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5600


def clean_env():
    return {k: v for k, v in os.environ.items()
            if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')}


def run(args, **kwargs):
    return subprocess.check_output([str(x) for x in args], env=clean_env(),
                                   text=True, stderr=subprocess.STDOUT, **kwargs)


def main():
    if len(os.sys.argv) != 1:
        raise SystemExit('No connection or runtime overrides are accepted')
    scratch = Path('/home/nate/Oxy/.agent-evidence/integration-i05-foreground-20261003')
    scratch.mkdir(parents=True, exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix='pg1519-', dir=scratch))
    data = owned / 'data'
    started = int(time.time())
    print(run([PG / 'initdb', '-D', data, '-U', 'oxy', '-A', 'trust', '--no-locale', '--encoding=UTF8']))
    server_started = False
    try:
        print(run([PG / 'pg_ctl', '-D', data, '-l', owned / 'server.log', '-w',
                   '-o', f'-h 127.0.0.1 -p {PORT} -k {owned}', 'start']))
        server_started = True
        pid_rows = (data / 'postmaster.pid').read_text().splitlines()
        pid = int(pid_rows[0])
        assert Path(pid_rows[1]).resolve() == data.resolve()
        assert int(pid_rows[2]) >= started
        assert int(pid_rows[3]) == PORT
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
                            'NODE_ENV': 'test', 'BUN_OPTIONS': '--no-env-file'}
        def logged(command, name):
            result = subprocess.run(command, cwd=ROOT / 'packages/api', env=env,
                                    text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, check=False)
            (owned / name).write_text(result.stdout)
            print(json.dumps({'command': command, 'exitCode': result.returncode,
                              'log': str(owned / name)}))
            result.check_returncode()
        # A fixture journal prefix; repository snapshots/journal are never edited.
        prefix = owned / 'drizzle-0141-fixture'
        (prefix / 'meta').mkdir(parents=True)
        original = json.loads((ROOT / 'packages/api/drizzle/meta/_journal.json').read_text())
        original['entries'] = original['entries'][:141]
        assert len(original['entries']) == 141
        (prefix / 'meta/_journal.json').write_text(json.dumps(original))
        for entry in original['entries']:
            shutil.copyfile(ROOT / 'packages/api/drizzle' / (entry['tag'] + '.sql'),
                            prefix / (entry['tag'] + '.sql'))
        bootstrap = owned / 'prefix-migrate.ts'
        bootstrap.write_text(
            'import { runMigrations } from ' + json.dumps(str(ROOT / 'packages/db/src/migrate/runner.ts')) + ';\n'
            + 'import { REQUIRED_EXTENSIONS } from ' + json.dumps(str(ROOT / 'packages/api/src/db/extensions.ts')) + ';\n'
            + 'await runMigrations({ databaseUrl: process.env.DATABASE_URL!, migrationsFolder: '
            + json.dumps(str(prefix)) + ', extensions: REQUIRED_EXTENSIONS, run: "all", logger: console });\n')
        logged(['bun', '--no-env-file', str(bootstrap)], 'upgrade-baseline-0141.txt')
        assert sql('SELECT count(*) FROM drizzle.__drizzle_migrations', db) == '141'
        sql("INSERT INTO users (id,color) VALUES ('upgrade-owner','teal');", db)
        sql("INSERT INTO applications (id, name, owner_account_id) VALUES ('upgrade-app','Upgrade fixture','upgrade-owner');", db)
        sql("INSERT INTO application_credentials (id,application_id,name,type,environment,public_key,secret_hash) VALUES ('upgrade-cred','upgrade-app','Upgrade fixture','service','production','oxy_dk_upgrade','synthetic');", db)
        for actor in ['requester', 'alia', 'agent']:
            actor_account = 'NULL' if actor == 'alia' else "'upgrade-owner'"
            session_id = "'historical-session'" if actor == 'requester' else 'NULL'
            digest = "'" + 'a' * 64 + "'" if actor == 'requester' else 'NULL'
            sql(f"INSERT INTO capability_execution_authorizations (id,kind,requester_account_id,owner_account_id,coordinator_application_id,coordinator_credential_id,actor_type,actor_account_id,requester_session_id,requester_session_binding_digest,resource_app,effective_account_id,resource_type,resource_key,tool,run_id,maximum_autonomy,expires_at) VALUES ('upgrade-{actor}','direct_request','upgrade-owner','upgrade-owner','upgrade-app','upgrade-cred','{actor}',{actor_account},{session_id},{digest},'oxy','upgrade-owner','account','upgrade-owner','readViewerGraph','preserved-run','read_only',CURRENT_TIMESTAMP+interval '1 hour');", db)
        before = sql("SELECT id||'|'||created_at||'|'||run_id FROM capability_execution_authorizations ORDER BY id", db)
        logged(['bun', '--no-env-file', 'run', 'db:migrate'], 'upgrade-0142.txt')
        assert sql('SELECT count(*) FROM drizzle.__drizzle_migrations', db) == '142'
        assert sql("SELECT id||'|'||created_at||'|'||run_id FROM capability_execution_authorizations ORDER BY id", db) == before
        assert sql("SELECT revoked_at IS NOT NULL FROM capability_execution_authorizations WHERE id='upgrade-requester'", db) == 't'
        assert sql("SELECT count(*) FROM capability_execution_authorizations WHERE actor_type IN ('alia','agent') AND revoked_at IS NULL", db) == '2'
        def refuses(statement):
            result = subprocess.run([str(PG / 'psql'), '-X', '-h', '127.0.0.1', '-p', str(PORT), '-U', 'oxy', '-d', db,
                                     '-v', 'ON_ERROR_STOP=1', '-c', statement], env=clean_env(), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            assert result.returncode != 0 and 'capability_execution_requester_catalog_check' in result.stdout, result.stdout
        refuses("UPDATE capability_execution_authorizations SET revoked_at=NULL WHERE id='upgrade-requester'")
        refuses("UPDATE capability_execution_authorizations SET requester_catalog_version='1.0.0' WHERE id='upgrade-requester'")
        state = sql("SELECT id||'|'||COALESCE(revoked_at::text,'active') FROM capability_execution_authorizations ORDER BY id", db)
        logged(['bun', '--no-env-file', 'run', 'db:migrate'], 'upgrade-repeat.txt')
        assert sql('SELECT count(*) FROM drizzle.__drizzle_migrations', db) == '142'
        assert sql("SELECT id||'|'||COALESCE(revoked_at::text,'active') FROM capability_execution_authorizations ORDER BY id", db) == state
        print(json.dumps({'newLocalServerPid': pid, 'dataDirectory': str(data), 'database': db,
                          'checks': ['141-prefix-normal-migrator', '142-normal-migrator', 'requester-revoked-history-preserved',
                                     'alia-agent-active', 'missing-pin-reactivation-refused', 'partial-pin-refused', 'repeat-no-op'],
                          'productionAccess': False}))
    finally:
        if server_started:
            print(run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop']))


if __name__ == '__main__':
    main()
