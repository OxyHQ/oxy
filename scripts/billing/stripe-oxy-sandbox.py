#!/usr/bin/env python3
"""Prepare/review first; execute only this frozen Stripe test rehearsal on fresh owned PG.

No database URL, provider URL, key, account, port or spending override is accepted.
The key is selected in memory by the child from the one reviewed local file.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5594
ACCOUNT = 'acct_1TnXkUQWiCE02OnU'
OUTPUT = Path('/home/nate/Oxy/.agent-evidence/integration-stripe-1519-20261003')
CHILD = 'packages/api/scripts/stripe-billing-sandbox-rehearsal.ts'
INPUTS = [
    'scripts/billing/stripe-oxy-sandbox.py', CHILD, 'bun.lock', 'package.json',
    'packages/core/scripts/build-workspace-deps.mjs',
    'packages/api/package.json', 'packages/api/src/routes/billing.ts',
    'packages/api/src/config/billingNamespace.ts', 'packages/api/src/config/postgres.ts',
    'packages/api/src/utils/billingStripe.ts', 'packages/api/src/utils/stripeClient.ts',
    'packages/api/src/services/subscriptionCreditLedger.service.ts',
    'packages/api/src/services/stripeSubscriptionEvidence.service.ts',
    'packages/api/src/services/subscriptionPeriodPolicy.ts',
    'packages/api/src/services/subscriptionPromotionPolicy.ts',
    'packages/api/src/services/productBillingCatalogue.service.ts',
    'packages/api/src/services/productProviderEvidence.service.ts',
    'packages/api/src/services/productAccessPersistence.service.ts',
    'packages/api/drizzle/meta/_journal.json',
]


def scrub():
    # Do not pass operator credentials or configuration to the rehearsal process.
    return {key: value for key, value in os.environ.items()
            if key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')} | {'BUN_OPTIONS': '--no-env-file'}


def run(args, **kwargs):
    return subprocess.check_output([str(arg) for arg in args], env=scrub(),
                                   text=True, stderr=subprocess.STDOUT, **kwargs)


class SignalCoordinator:
    """Keep the child alive for cleanup before stopping the owned database.

    Every managed process owns a separate process group. Repeated parent signals
    never skip cleanup. The fixed runtime deadline bounds an unresponsive child;
    a forced stop is recorded as unresolved and requires manifest review.
    """
    def __init__(self, cleanup_timeout_seconds=900):
        self.active = None
        self.requested_signal = None
        self.deadline = None
        self.forced = False
        self.last_child_pid = None
        self.last_child_stopped = None
        self.cleanup_timeout_seconds = cleanup_timeout_seconds
        self.previous = {}
        self.forwarded_pids = set()

    def handle(self, signum, _frame):
        if self.requested_signal is not None:
            return
        self.requested_signal = signum
        self.deadline = time.monotonic() + self.cleanup_timeout_seconds
        self.forward_requested()

    def forward_requested(self):
        if (self.requested_signal is not None and self.active is not None
                and self.active.poll() is None and self.active.pid not in self.forwarded_pids):
            self.forwarded_pids.add(self.active.pid)
            try:
                os.killpg(self.active.pid, self.requested_signal)
            except ProcessLookupError:
                pass

    def __enter__(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            self.previous[signum] = signal.signal(signum, self.handle)
        return self

    def __exit__(self, *_args):
        for signum, previous in self.previous.items():
            signal.signal(signum, previous)

    def check_interrupted(self):
        if self.requested_signal is not None:
            raise InterruptedError('Rehearsal interrupted before provider launch')

    def run(self, args, **kwargs):
        self.check_interrupted()
        child = subprocess.Popen([str(arg) for arg in args], start_new_session=True, **kwargs)
        self.active = child
        self.last_child_pid = child.pid
        # A signal can arrive between the pre-spawn check and assignment.
        self.forward_requested()
        output = None
        try:
            while True:
                try:
                    output, _ = child.communicate(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    if self.deadline is not None and time.monotonic() >= self.deadline:
                        self.forced = True
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        output, _ = child.communicate(timeout=10)
                        break
            return subprocess.CompletedProcess(args, child.returncode, output)
        finally:
            self.active = None
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
                self.forced = True
            self.last_child_stopped = not Path(f'/proc/{child.pid}').exists()


def write_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(json.dumps(value, indent=2) + '\n')


def input_hashes():
    result = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in INPUTS}
    for path in sorted((ROOT / 'packages').glob('*/package.json')):
        result[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    # Bind the complete source/schema and migration trees, beyond the named entrypoints.
    for name in ('packages/api/src', 'packages/api/drizzle', 'packages/contracts/src',
                 'packages/core/src', 'packages/db/src'):
        for path in sorted((ROOT / name).rglob('*')):
            if path.is_file():
                result[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def scope():
    return {'provider': 'stripe', 'providerAccountId': ACCOUNT, 'mode': 'test',
            'environment': 'test', 'databaseDeclaration': 'test:test',
            'nodeEnvironment': 'test', 'port': PORT, 'currency': 'usd',
            'maximumSyntheticPaidMinorUnits': 50000, 'maximumSubscriptions': 4,
            'providerSignedDelivery': False, 'productionDatabase': False,
            'positivePromotionConfigured': False}


def prepare():
    OUTPUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    nonce = secrets.token_hex(12)
    path = OUTPUT / f'plan-{nonce}.json'
    write_private(path, {'schemaVersion': 1, 'nonce': nonce, 'preparedAt': int(time.time()),
                         'expiresAt': int(time.time()) + 86400, 'scope': scope(),
                         'sourceHead': run(['git', 'rev-parse', 'HEAD'], cwd=ROOT).strip(),
                         'sourceSha256': input_hashes()})
    print(json.dumps({'plan': str(path), 'mutations': False, 'scope': scope()}))


def validate_plan(path):
    plan = json.loads(path.read_text())
    if set(plan) != {'schemaVersion', 'nonce', 'preparedAt', 'expiresAt', 'scope', 'sourceHead', 'sourceSha256'}:
        raise ValueError('Unexpected plan fields')
    if plan['schemaVersion'] != 1 or plan['scope'] != scope():
        raise ValueError('Reviewed scope differs')
    nonce = plan['nonce']
    if not isinstance(nonce, str) or len(nonce) != 24 or any(c not in '0123456789abcdef' for c in nonce):
        raise ValueError('Invalid owned nonce')
    if not plan['preparedAt'] <= int(time.time()) < plan['expiresAt'] or plan['expiresAt'] - plan['preparedAt'] > 86400:
        raise ValueError('Plan expired or invalid')
    if plan['sourceSha256'] != input_hashes():
        raise ValueError('Source bytes differ from reviewed plan')
    if plan['sourceHead'] != run(['git', 'rev-parse', 'HEAD'], cwd=ROOT).strip():
        raise ValueError('Source head differs from reviewed plan')
    return plan


def bootstrap_router():
    # Exercise the same exported source loader before the child reads a key or
    # creates remote objects. No database URL or provider credential is passed.
    script = ("const {loadBillingRouter}=await import('./" + CHILD + "');"
              "const router=await loadBillingRouter(process.cwd());"
              "console.log(JSON.stringify({actualLoader:typeof router,providerCredentialEnvPresent:Boolean(process.env.STRIPE_SECRET_KEY),databaseEnvPresent:Boolean(process.env.DATABASE_URL)}));")
    checked = subprocess.run(['bun', '--no-env-file', '-e', script], cwd=ROOT,
                             env=scrub() | {'NODE_ENV': 'test', 'LOG_LEVEL': 'silent'},
                             text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    checked.check_returncode()
    if json.loads(checked.stdout) != {'actualLoader': 'function', 'providerCredentialEnvPresent': False, 'databaseEnvPresent': False}:
        raise ValueError('Router bootstrap did not return the expected offline result')
    return checked.stdout


def execute(path):
    with SignalCoordinator() as coordinator:
        return execute_owned(path, coordinator)


def execute_owned(path, coordinator):
    plan = validate_plan(path)
    if run(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT).strip():
        raise ValueError('Execution requires a clean committed checkout')
    owned = OUTPUT / plan['nonce']
    owned.mkdir(mode=0o700)  # An existing run cannot be retried against reused state.
    write_private(owned / 'plan.json', plan)
    data = owned / 'data'
    socket_dir = Path(tempfile.mkdtemp(prefix='oxy-stripe-pg-'))
    started = int(time.time())
    server_started = False
    result = {'schemaVersion': 1, 'nonce': plan['nonce'], 'providerEffectsAttempted': False,
              'newLocalServerPid': None, 'stopped': False, 'exitCode': None}
    try:
        (owned / 'initdb.log').write_text(run([PG / 'initdb', '-D', data, '-U', 'oxy', '-A', 'trust', '--no-locale']))
        run([PG / 'pg_ctl', '-D', data, '-l', owned / 'server.log', '-w',
             '-o', f'-h 127.0.0.1 -p {PORT} -k {socket_dir}', 'start'])
        server_started = True
        rows = (data / 'postmaster.pid').read_text().splitlines()
        pid = int(rows[0])
        assert Path(rows[1]).resolve() == data.resolve() and int(rows[2]) >= started
        assert int(rows[3]) == PORT and Path(rows[4]).resolve() == socket_dir.resolve()
        assert Path(f'/proc/{pid}').stat().st_uid == os.getuid()
        assert Path(f'/proc/{pid}/exe').resolve() == (PG / 'postgres').resolve()
        assert os.getpgid(pid) != os.getpgrp(), 'PostgreSQL must not receive launcher-group signals'
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        assert b'-D' in args and str(data).encode() in args
        sockets = {os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}
        listeners = [row.split() for row in Path('/proc/net/tcp').read_text().splitlines()[1:]]
        matches = [row for row in listeners if row[1] == f'0100007F:{PORT:04X}' and row[3] == '0A']
        assert len(matches) == 1 and f'socket:[{matches[0][9]}]' in sockets
        result['newLocalServerPid'] = pid

        def sql(query, database='postgres'):
            return run([PG / 'psql', '-X', '-h', '127.0.0.1', '-p', PORT, '-U', 'oxy',
                        '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atc', query]).strip()

        assert Path(sql("SELECT current_setting('data_directory')")).resolve() == data.resolve()
        assert sql('SELECT system_identifier FROM pg_control_system()')
        database = 'oxy_stripe_' + plan['nonce']
        sql(f'CREATE DATABASE "{database}"')
        assert sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'", database) == '0'
        sql(f'ALTER DATABASE "{database}" SET oxy.billing_namespace TO \'test:test\'')
        assert sql("SELECT unnest(setconfig) FROM pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND setrole=0", database) == 'oxy.billing_namespace=test:test'
        write_private(owned / 'owner.json', {'pid': pid, 'data': str(data.resolve()),
                      'socket': str(socket_dir.resolve()), 'port': PORT, 'database': database,
                      'systemIdentifier': sql('SELECT system_identifier FROM pg_control_system()'),
                      'uid': os.getuid()})
        env = scrub() | {'DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/{database}',
                         'NODE_ENV': 'test', 'BILLING_PROCESSOR_ENVIRONMENT': 'test', 'LOG_LEVEL': 'silent'}
        build = coordinator.run(['node', 'packages/core/scripts/build-workspace-deps.mjs',
                                '@oxy.so/contracts', '@oxy.so/protocol', '@oxy.so/core',
                                '@oxy.so/db', '@oxy.so/utils', '@oxy.so/telemetry', '@oxy.so/federation', '@oxy.so/mcp'],
                               cwd=ROOT, env=scrub(), text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT)
        (owned / 'build.log').write_text(build.stdout)
        build.check_returncode()
        (owned / 'bootstrap.log').write_text(bootstrap_router())
        migration = coordinator.run(['bun', '--no-env-file', 'run', 'db:migrate'], cwd=ROOT / 'packages/api', env=env,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (owned / 'migrate.log').write_text(migration.stdout)
        migration.check_returncode()
        # Recheck frozen inputs immediately before the network-capable child.
        validate_plan(path)
        coordinator.check_interrupted()
        result['providerEffectsAttempted'] = True
        with (owned / 'child.private.log').open('x') as log:
            os.chmod(log.name, 0o600)
            child = coordinator.run(['bun', '--no-env-file', 'run', CHILD, str(owned / 'plan.json'), str(owned)],
                                   cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        result['exitCode'] = child.returncode
        child.check_returncode()
    finally:
        try:
            if server_started:
                run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
                result['stopped'] = not Path(f'/proc/{result["newLocalServerPid"]}').exists()
        finally:
            shutil.rmtree(socket_dir)
            result['requestedSignal'] = coordinator.requested_signal
            result['childForcedStop'] = coordinator.forced
            result['lastManagedProcessPid'] = coordinator.last_child_pid
            result['lastManagedProcessStopped'] = coordinator.last_child_stopped
            result['cleanupRequiresManifestReview'] = coordinator.forced or result['exitCode'] is None
            write_private(owned / 'runner.json', result)
            print(json.dumps({'runDirectory': str(owned), **result}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--execute', type=Path)
    options = parser.parse_args()
    if options.prepare and options.execute:
        parser.error('Choose preparation or execution')
    if options.execute:
        execute(options.execute.resolve())
    else:
        prepare()
