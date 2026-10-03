#!/usr/bin/env python3
"""Prepare-only by default: the reviewed compiled I05 executor in the live final API image.

No IAM/task role, new secret or image override. Dispatch intent is fsynced before
RunTask; ACK uncertainty never redispatches. Task STOPPED is not credential cleanup.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

BASE_PATH = Path(__file__).with_name('oxy-profile-registrar-preflight-ecs.py')
ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('reviewed_registrar_transport', BASE_PATH)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
require = base.require
private_json = base.private_json
digest = base.digest
SOURCE_PATHS = [
    'packages/api/src/scripts/foregroundPilotConfiguration.ts',
    'packages/api/src/scripts/foregroundPilotExecutor.ts',
    'packages/api/src/scripts/foregroundPilotHttps.ts',
    'packages/api/src/scripts/seedOxyApplicationsSpecs.ts',
    'packages/api/src/scripts/seedOxyApplicationsPlan.ts',
    'packages/api/src/capabilities/oxy-profile.catalog.ts',
    'packages/api/src/services/capabilityCatalog.service.ts',
    'packages/api/src/services/applicationCredentialAudit.service.ts',
    'scripts/agency/oxy-profile-registrar-preflight-ecs.py',
    'scripts/agency/foreground-pilot-ecs.py',
]
PHASES = {'configuration-intent', 'configuration-confirmed', 'credential-intent',
          'credential-confirmed', 'mint-intent', 'mint-confirmed', 'register-intent',
          'register-confirmed', 'cleanup-confirmed'}


cleanup_running = False
interrupted = False


def handle_signal(_signum, _frame):
    global interrupted
    interrupted = True
    if not cleanup_running:
        raise InterruptedError('Operator signal; reconcile durable intent')


def aws(*args):
    # Own the CLI process group. Interrupting a write creates ACK uncertainty;
    # never leave its child running silently while the coordinator exits.
    child = subprocess.Popen(['aws', *args, '--region', base.REGION, '--output', 'json'],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
    try:
        stdout, _stderr = child.communicate(timeout=40)
        require(child.returncode == 0, 'AWS action/metadata failed; details withheld')
        return json.loads(stdout)
    except BaseException:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
        raise


base.aws = aws


def verify_definition(actual, expected):
    base.verify_registered(actual, expected)
    require(actual['containerDefinitions'][0].get('stopTimeout') == 120,
            'Registered stop grace differs from own finally budget')


def outside_source(path):
    resolved = Path(path).resolve()
    require(resolved != ROOT.resolve() and ROOT.resolve() not in resolved.parents,
            'Private plans and operation records must remain outside the source checkout')
    return resolved


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_pins():
    return {path: sha(ROOT / path) for path in SOURCE_PATHS}


def git_head():
    require(not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT),
            'Source checkout must be clean')
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def configure_profile(definition):
    require(re.fullmatch(r'oxy-oxy-api:[1-9][0-9]*', definition) is not None, 'Exact final API task revision required')
    base.PROFILES = {'oxy': {'service': 'oxy-api', 'definition': definition,
                            'container': 'oxy-api', 'cwd': '/app/packages/api',
                            'parameter': '/oxy/oxy-api/DATABASE_URL'}}


def build_definition(plan):
    payload = base64.urlsafe_b64encode(json.dumps(plan['configuration'], separators=(',', ':')).encode()).decode().rstrip('=')
    live = plan['live']
    return {'family': 'oxy-i05-foreground-configuration', 'executionRoleArn': live['executionRoleArn'],
            'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], 'cpu': live['cpu'],
            'memory': live['memory'], 'runtimePlatform': live['runtimePlatform'], 'volumes': [],
            'containerDefinitions': [{'name': 'configuration', 'image': live['image'], 'essential': True,
                'entryPoint': ['/usr/local/bin/node'],
                'command': ['dist/scripts/foregroundPilotExecutor.js', plan['operation'], payload],
                'workingDirectory': '/app/packages/api', 'environment': [
                    {'name': 'NODE_ENV', 'value': 'production'},
                    {'name': 'OXY_API_URL', 'value': 'https://api.oxy.so'}],
                'secrets': [live['databaseSecret']], 'portMappings': [], 'mountPoints': [], 'volumesFrom': [],
                'stopTimeout': 120,
                'logConfiguration': {'logDriver': 'awslogs', 'options': {'awslogs-group': live['logGroup'],
                    'awslogs-region': base.REGION, 'awslogs-stream-prefix': live['logStreamPrefix']}}}]}


def validate_plan(plan):
    require(set(plan) == {'schemaVersion', 'kind', 'preparedAt', 'nonce', 'operation', 'definition',
                         'sourceHead', 'sourceSha256', 'configuration', 'configurationSha256', 'live',
                         'taskDefinitionSha256'}, 'Unexpected/missing plan fields')
    require(plan['schemaVersion'] == 1 and plan['kind'] == 'i05-foreground-dispatch'
            and plan['operation'] in ('execute', 'rollback', 'retire'), 'Invalid plan kind/operation')
    require(re.fullmatch('[a-f0-9]{32}', plan['nonce']) is not None
            and plan['nonce'] == plan['configuration']['nonce'], 'Operation nonce mismatch')
    require(re.fullmatch('[a-f0-9]{40}', plan['sourceHead']) is not None, 'Source pin missing')
    require(0 <= time.time() - plan['preparedAt'] <= 1800, 'Dispatch plan expired')
    require(source_pins() == plan['sourceSha256'], 'Executable source differs')
    require(git_head() == plan['sourceHead'], 'Source HEAD differs')
    require(digest(plan['configuration']) == plan['configurationSha256'], 'Configuration differs')
    require(plan['configuration'].get('kind') == 'i05-foreground-configuration'
            and plan['configuration'].get('schemaVersion') == 1, 'Wrong configuration protocol')
    configure_profile(plan['definition'])
    require(base.describe('oxy') == plan['live'], 'Live task/image/network/role/secret pins changed')
    require(digest(build_definition(plan)) == plan['taskDefinitionSha256'], 'Execution definition changed')


def collect_operations(plan, task_arn):
    stream = plan['live']['logStreamPrefix'] + '/configuration/' + task_arn.rsplit('/', 1)[1]
    records = []; token = None; total_bytes = 0
    for _ in range(16):
        args = ['logs', 'get-log-events', '--log-group-name', plan['live']['logGroup'],
                '--log-stream-name', stream, '--start-from-head', '--limit', '1000']
        if token: args += ['--next-token', token]
        page = base.aws(*args)
        for event in page.get('events', []):
            message = event.get('message', '')
            require(isinstance(message, str), 'Malformed log record')
            total_bytes += len(message.encode())
            require(total_bytes <= 256 * 1024, 'Operation logs exceeded bound')
            try: row = json.loads(message)
            except (ValueError, TypeError): continue
            if not isinstance(row, dict) or row.get('kind') != 'i05-foreground-operation': continue
            require(row.get('nonce') == plan['nonce'], 'Foreign operation nonce in own log stream')
            if 'phase' in row:
                require(set(row) == {'kind', 'nonce', 'phase'} and row['phase'] in PHASES, 'Unexpected phase fields')
            else:
                require(row == {'kind': 'i05-foreground-operation', 'nonce': plan['nonce'],
                                'operation': plan['operation'], 'status': 'confirmed'}, 'Unexpected final fields')
            records.append(row)
            require(len(records) <= 32, 'Operation phase census exceeded')
        next_token = page.get('nextForwardToken')
        if not next_token or next_token == token: return records
        token = next_token
    raise RuntimeError('Operation logs pagination exceeded bound')


def collect_confirmed_operations(plan, task_arn):
    # Delivery may lag STOPPED. Retry reads only, never RunTask or authority writes.
    for attempt in range(12):
        try:
            records = collect_operations(plan, task_arn)
        except RuntimeError as error:
            if str(error) != 'AWS action/metadata failed; details withheld': raise
            records = []
        if any(row.get('status') == 'confirmed' for row in records): return records
        if attempt < 11: time.sleep(5)
    raise RuntimeError('Operation log acknowledgement incomplete; SQL reconciliation required')


def execute(plan, directory):
    global cleanup_running
    cleanup_running = False
    validate_plan(plan)  # Read-only until this completes; includes the pinned source/image.
    directory = outside_source(directory); directory.mkdir(parents=True, exist_ok=False); os.chmod(directory, 0o700)
    definition = build_definition(plan); private_json(directory / 'definition.json', definition)
    registered = None; launched = []; acknowledgement_unknown = False; authority_cleanup_confirmed = False; dispatch_attempted = False; operation_confirmed = False
    try:
        # This intent survives RegisterTaskDefinition ACK uncertainty; no blind registration retry.
        private_json(directory / 'registration-intent.json', {'planSha256': digest(plan),
            'definitionSha256': digest(definition), 'recordedAt': int(time.time())})
        try:
            registration = base.aws('ecs', 'register-task-definition', '--cli-input-json',
                                    'file://' + str((directory / 'definition.json').resolve()))['taskDefinition']
        except Exception:
            acknowledgement_unknown = True
            raise RuntimeError('Definition acknowledgement unknown; reconcile registration intent without retry')
        registered = registration['taskDefinitionArn']
        verify_definition(registration, definition)
        readback = base.aws('ecs', 'describe-task-definition', '--task-definition', registered)['taskDefinition']
        verify_definition(readback, definition)
        private_json(directory / 'registered-readback.json', {'taskDefinitionArn': registered,
            'returnedAndReadbackVerified': True, 'definitionSha256': digest(definition)})
        started_by = 'oxy-i05-' + plan['nonce']
        private_json(directory / 'dispatch-intent.json', {'planSha256': digest(plan), 'taskDefinitionArn': registered,
            'startedBy': started_by, 'clientToken': plan['nonce'], 'recordedAt': int(time.time()),
            'state': 'intent_before_dispatch'})
        try:
            dispatch_attempted = True
            result = base.aws('ecs', 'run-task', '--cluster', base.CLUSTER, '--launch-type', 'FARGATE',
                '--task-definition', registered, '--network-configuration', json.dumps(plan['live']['network']),
                '--count', '1', '--started-by', started_by, '--client-token', plan['nonce'])
        except Exception:
            acknowledgement_unknown = True
            for attempt in range(6):
                launched = base.find_dispatched_tasks(registered, started_by)
                if launched: break
                if attempt < 5: time.sleep(5)
            private_json(directory / 'dispatch-unknown.json', {'matchedTaskArns': launched, 'noRedispatch': True,
                'absenceDoesNotProveNoTask': not bool(launched)})
            raise RuntimeError('Dispatch acknowledgement unknown; reconcile intent and authority SQL before any retry')
        launched = [task['taskArn'] for task in result.get('tasks', [])]
        require(not result.get('failures') and len(launched) == 1, 'Task dispatch failed/ambiguous')
        private_json(directory / 'launch.json', {'taskArn': launched[0], 'taskDefinitionArn': registered})
        deadline = time.monotonic() + 240
        while True:
            described = base.aws('ecs', 'describe-tasks', '--cluster', base.CLUSTER, '--tasks', launched[0])
            require(not described.get('failures') and len(described.get('tasks', [])) == 1, 'Task readback incomplete')
            task = described['tasks'][0]
            require(task['taskDefinitionArn'] == registered, 'Task definition changed')
            if task['lastStatus'] == 'STOPPED': break
            require(time.monotonic() < deadline, 'Foreground task exceeded bound')
            time.sleep(5)
        require(len(task['containers']) == 1 and task['containers'][0].get('imageDigest') == plan['live']['image'].split('@')[1], 'Task image differs')
        operations = collect_confirmed_operations(plan, launched[0])
        private_json(directory / 'operations.json', operations)
        authority_cleanup_confirmed = any(row.get('phase') == 'cleanup-confirmed' for row in operations)
        if plan['operation'] in ('retire', 'rollback'):
            authority_cleanup_confirmed = any(row.get('status') == 'confirmed' for row in operations)
        require(task['containers'][0].get('exitCode') == 0, 'Foreground task failed; SQL reconciliation required')
        require(sum(row.get('status') == 'confirmed' for row in operations) == 1, 'Final operation acknowledgement absent/ambiguous')
        if plan['operation'] == 'execute':
            require([row['phase'] for row in operations if 'phase' in row] == [
                'configuration-intent', 'configuration-confirmed', 'credential-intent', 'credential-confirmed',
                'mint-intent', 'mint-confirmed', 'register-intent', 'register-confirmed', 'cleanup-confirmed'],
                'Operation acknowledgement order/census differs')
        if plan['operation'] == 'execute': require(authority_cleanup_confirmed, 'Credential retirement acknowledgement absent')
        private_json(directory / 'receipt.json', {'planSha256': digest(plan), 'taskArn': launched[0],
            'taskDefinitionArn': registered, 'image': plan['live']['image'], 'operation': plan['operation'],
            'operationsSha256': digest(operations), 'authorityCleanupConfirmed': authority_cleanup_confirmed})
        operation_confirmed = True
    finally:
        cleanup_running = True
        failures = []
        for arn in launched:
            try:
                task = base.aws('ecs', 'describe-tasks', '--cluster', base.CLUSTER, '--tasks', arn)['tasks'][0]
                if task['lastStatus'] != 'STOPPED':
                    base.aws('ecs', 'stop-task', '--cluster', base.CLUSTER, '--task', arn,
                             '--reason', 'I05 own operation cleanup; no redispatch')
                    deadline = time.monotonic() + 150
                    while time.monotonic() < deadline:
                        task = base.aws('ecs', 'describe-tasks', '--cluster', base.CLUSTER, '--tasks', arn)['tasks'][0]
                        if task['lastStatus'] == 'STOPPED': break
                        time.sleep(5)
                require(task['lastStatus'] == 'STOPPED', 'STOPPED readback missing')
            except Exception: failures.append('task_cleanup_unconfirmed')
        if registered:
            try:
                base.aws('ecs', 'deregister-task-definition', '--task-definition', registered)
                require(base.aws('ecs', 'describe-task-definition', '--task-definition', registered,
                        '--query', 'taskDefinition.status') == 'INACTIVE', 'Definition INACTIVE readback missing')
            except Exception: failures.append('definition_cleanup_unconfirmed')
        if acknowledgement_unknown: failures.append('ack_unknown_requires_intent_reconciliation')
        if dispatch_attempted and plan['operation'] in ('execute', 'retire') and not authority_cleanup_confirmed:
            failures.append('authority_retirement_unconfirmed_requires_sql_reconciliation')
        private_json(directory / 'cleanup.json', {'failures': failures, 'taskArns': launched,
            'definitionArn': registered, 'authorityCleanupConfirmed': authority_cleanup_confirmed,
            'noAutomaticRetry': True, 'operatorInterrupted': interrupted,
            'operationConfirmed': operation_confirmed, 'operationIncompleteRequiresSqlReview': dispatch_attempted and not operation_confirmed})
        require(not failures, 'Cleanup requires manifest review; no automatic retry')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True); parser.add_argument('--execute', action='store_true')
    parser.add_argument('--output'); parser.add_argument('--configuration'); parser.add_argument('--definition')
    parser.add_argument('--operation', choices=('execute', 'rollback', 'retire'), default='execute')
    args = parser.parse_args()
    outside_source(args.plan)
    if args.execute:
        require(args.output is not None and args.configuration is None and args.definition is None,
                'Execute accepts only reviewed plan and new output directory')
        execute(json.loads(Path(args.plan).read_text()), args.output)
    else:
        require(args.configuration is not None and args.definition is not None and args.output is None,
                'Prepare requires exact configuration and final live definition')
        raw = Path(args.configuration).read_bytes(); require(len(raw) <= 65_536, 'Configuration exceeded bound')
        configuration = json.loads(raw)
        configure_profile(args.definition)
        plan = {'schemaVersion': 1, 'kind': 'i05-foreground-dispatch', 'preparedAt': int(time.time()),
                'nonce': configuration['nonce'], 'operation': args.operation, 'definition': args.definition,
                'sourceHead': git_head(), 'sourceSha256': source_pins(), 'configuration': configuration,
                'configurationSha256': digest(configuration), 'live': base.describe('oxy')}
        plan['taskDefinitionSha256'] = digest(build_definition(plan))
        private_json(args.plan, plan)
        print(json.dumps({'prepared': True, 'plan': args.plan, 'operation': args.operation,
                          'image': plan['live']['image'], 'planSha256': digest(plan)}))


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, handle_signal); signal.signal(signal.SIGINT, handle_signal)
    try: main()
    except Exception:
        print('I05_FOREGROUND_TRANSPORT_FAILED_REVIEW_PRIVATE_INTENT', file=os.sys.stderr)
        raise SystemExit(1)
