#!/usr/bin/env python3
"""Rehearse this checkout only on a new, locally owned PostgreSQL process.

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
PORT = 5563


def clean_env():
    return {k: v for k, v in os.environ.items()
            if not k.startswith('PG') and k not in ('DATABASE_URL', 'TEST_DATABASE_URL')}


def run(args, **kwargs):
    return subprocess.check_output([str(x) for x in args], env=clean_env(),
                                   text=True, stderr=subprocess.STDOUT, **kwargs)


def main():
    if len(os.sys.argv) != 1:
        raise SystemExit('No connection or runtime overrides are accepted')
    scratch = ROOT / '.integration-evidence'
    scratch.mkdir(exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix='pg1519-', dir=scratch))
    data = owned / 'data'
    started = int(time.time())
    print(run([PG / 'initdb', '-D', data, '-U', 'oxy', '-A', 'trust', '--no-locale']))
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
                            'NODE_ENV': 'test'}
        # Apply the exact journal prefix through 0133 using the SAME shared
        # migration engine as db:migrate, then prove the readback refuses it.
        # The complete db:migrate invocations below apply this checkout through 0135.
        source = ROOT / 'packages/api/drizzle'
        prefix = owned / 'drizzle-0133'
        (prefix / 'meta').mkdir(parents=True)
        prefix_journal = json.loads((source / 'meta/_journal.json').read_text())
        prefix_journal['entries'] = [e for e in prefix_journal['entries'] if e['idx'] <= 133]
        assert len(prefix_journal['entries']) == 133
        (prefix / 'meta/_journal.json').write_text(json.dumps(prefix_journal))
        for entry in prefix_journal['entries']:
            shutil.copyfile(source / (entry['tag'] + '.sql'), prefix / (entry['tag'] + '.sql'))
        runner = owned / 'readback-schema.ts'
        runner.write_text(
            'import { runMigrations } from ' + json.dumps(str(ROOT / 'packages/db/src/migrate/index.ts')) + ';\n'
            'import { REQUIRED_EXTENSIONS } from ' + json.dumps(str(ROOT / 'packages/api/src/db/extensions.ts')) + ';\n'
            'import { connectPostgres, closePostgres, getDb } from ' + json.dumps(str(ROOT / 'packages/api/src/config/postgres.ts')) + ';\n'
            'import { readJevTechnicalMetering } from ' + json.dumps(str(ROOT / 'packages/api/src/scripts/jevMeteringReadback.ts')) + ';\n'
            'if (process.argv[2] === "prefix") await runMigrations({ databaseUrl: process.env.DATABASE_URL!, migrationsFolder: '
            + json.dumps(str(prefix)) + ', extensions: REQUIRED_EXTENSIONS, run: "all", logger: { info: console.log, debug: console.log } });\n'
            'await connectPostgres();\ntry { const result = await getDb().transaction(async tx => {\n'
            'await tx.execute((await import(' + json.dumps(str(ROOT / 'node_modules/drizzle-orm/index.js')) + ')).sql`set transaction read only, isolation level repeatable read`);\n'
            'return readJevTechnicalMetering(tx, "schema-only-probe", "production"); });\n'
            'if (result.schemaAvailable !== (process.argv[2] !== "prefix")) throw new Error("Unexpected schema readiness");\n'
            'console.log("OWNED_SCHEMA_READBACK " + JSON.stringify(result));\n} finally { await closePostgres(); }\n')
        result = subprocess.run(['bun', 'run', str(runner), 'prefix'], cwd=ROOT / 'packages/api',
                                env=env, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, check=False)
        (owned / 'readback-0133.log').write_text(result.stdout)
        result.check_returncode()
        assert int(sql('SELECT count(*) FROM drizzle.__drizzle_migrations', db)) == 133
        assert sql("SELECT count(*) FROM information_schema.columns WHERE table_name = "
                   "'inference_metered_usage' AND column_name = 'parent_request_id'", db) == '0'
        print('Readback blocks an actual 0133-only database')
        for iteration in (1, 2):
            result = subprocess.run(['bun', 'run', 'db:migrate'], cwd=ROOT / 'packages/api',
                                    env=env, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, check=True)
            (owned / f'migration-{iteration}.log').write_text(result.stdout)
        result = subprocess.run(['bun', 'run', str(runner), 'full'], cwd=ROOT / 'packages/api',
                                env=env, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, check=False)
        (owned / 'readback-current.log').write_text(result.stdout)
        result.check_returncode()
        print('Readback schema ready on the current journal; provider activation remains unauthorized')
        journal = json.loads((ROOT / 'packages/api/drizzle/meta/_journal.json').read_text())
        count = int(sql('SELECT count(*) FROM drizzle.__drizzle_migrations', db))
        assert count == len(journal['entries']), (count, len(journal['entries']))
        for table in ('inference_deployments', 'billing_stripe_events',
                      'inference_metered_usage', 'inference_provider_cost_attempts'):
            assert sql(f"SELECT to_regclass('public.{table}') IS NOT NULL", db) == 't', table
        assert sql("SELECT count(*) FROM information_schema.columns WHERE "
                   "table_name = 'inference_deployments' AND column_name = 'scoped_execution'", db) == '1'
        lineage_columns = ('parent_request_id', 'final_authorized_model_reference',
                           'final_authorized_provider', 'final_authorized_deployment_id',
                           'final_authorized_ceiling_amount', 'final_authorized_ceiling_currency')
        for column in lineage_columns:
            assert sql("SELECT count(*) FROM information_schema.columns WHERE "
                       f"table_name = 'inference_metered_usage' AND column_name = '{column}' "
                       "AND is_nullable = 'YES'", db) == '1', column
        assert sql("SELECT count(*) FROM pg_constraint WHERE conrelid = "
                   "'inference_metered_usage'::regclass AND conname IN "
                   "('inference_metered_usage_parent_check', "
                   "'inference_metered_usage_final_authorization_check')", db) == '2'
        assert sql("SELECT to_regclass('public.inference_metered_usage_parent_idx') IS NOT NULL", db) == 't'
        checks = int(sql("SELECT count(*) FROM pg_constraint WHERE conrelid = "
                         "'billing_stripe_events'::regclass AND contype = 'c'", db))
        assert checks == 3, checks
        access_tables = ('access_products', 'access_offers', 'access_offer_benefits',
                         'access_subscription_sources', 'access_offer_segments', 'access_grants')
        for table in access_tables:
            assert sql(f"SELECT to_regclass('public.{table}') IS NOT NULL", db) == 't', table
            assert sql(f'SELECT count(*) FROM {table}', db) == '0', table
        access_triggers = int(sql("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal "
                                  "AND tgenabled = 'O' AND tgrelid IN "
                                  "('access_products'::regclass, 'access_offers'::regclass, "
                                  "'access_offer_benefits'::regclass, 'access_subscription_sources'::regclass, "
                                  "'access_offer_segments'::regclass, 'access_grants'::regclass)", db))
        assert access_triggers == 7, access_triggers
        assert sql("SELECT count(*) FROM information_schema.columns WHERE "
                   "table_name = 'access_offers' AND column_name = 'expected_benefit_count' "
                   "AND is_nullable = 'NO' AND data_type = 'integer'", db) == '1'
        print(json.dumps({'newLocalServerPid': pid, 'dataDirectory': str(data),
                          'database': db, 'migrationRows': count,
                          'repeatMigrationPassed': True, 'billingEventChecks': checks,
                          'nullableLineageColumns': len(lineage_columns), 'lineageConstraints': 2,
                          'lineageParentIndex': True, 'emptyProductAccessTables': len(access_tables),
                          'productAccessGuardTriggers': access_triggers}))
    finally:
        if server_started:
            print(run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop']))


if __name__ == '__main__':
    main()
