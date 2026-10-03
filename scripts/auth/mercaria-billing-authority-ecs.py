#!/usr/bin/env python3
"""External transport for the existing compiled billing-authority CAS service.
STS stays local; the one-shot container receives only a strict reviewed request.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

BASE = Path(__file__).parents[1] / 'billing/commercial-inventory-ecs.py'
spec = importlib.util.spec_from_file_location('inventory_transport', BASE)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
aws, require, digest = transport.aws, transport.require, transport.digest
ACCOUNT, CLUSTER = transport.ACCOUNT, transport.CLUSTER
RUNNER = Path(__file__).with_name('mercaria-billing-authority.mjs')
TARGET = {'applicationId': '6a37d0cc5d4b5f15482a9340', 'credentialId': '01a061cd-39a9-7bd6-ba31-70ef7590c953', 'ownerAccountId': '69b2d3df5d12f58c9800d651'}


def private_read(path):
    path = Path(path)
    parent = path.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode) == 0o700 and parent.st_uid == os.getuid(), 'Private directory required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == os.getuid() and info.st_size <= 65536, 'Private file required')
        return os.read(fd, 65537)
    finally:
        os.close(fd)


def private_write(path, value):
    path = Path(path)
    parent = path.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode) == 0o700 and parent.st_uid == os.getuid(), 'Private directory required')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    finally:
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)


def operator(expected_arn):
    identity = aws('sts', 'get-caller-identity')
    require(identity['Account'] == ACCOUNT and identity['Arn'] == expected_arn, 'Operator identity differs')
    return {'Account': identity['Account'], 'Arn': identity['Arn'], 'UserId': identity['UserId']}


def validate_state(state):
    require(isinstance(state, dict) and set(state) == {'application', 'credential'}, 'Invalid state')
    for row in state.values():
        require(isinstance(row, dict) and set(row) == {'scopes', 'version', 'updatedAt'}, 'Invalid row')
        require(isinstance(row['scopes'], list) and len(row['scopes']) <= 32 and
                all(isinstance(x, str) and len(x) <= 100 for x in row['scopes']) and
                isinstance(row['version'], str) and re.fullmatch(r'[0-9]+', row['version']) and
                isinstance(row['updatedAt'], str) and 0 < len(row['updatedAt']) <= 100, 'Invalid row values')


def validate_request(request):
    require(isinstance(request, dict) and request.get('mode') in ('prepare', 'apply', 'rollback'), 'Invalid mode')
    keys = {'schemaVersion', 'nonce', 'mode', 'operator'}
    require(set(request) == keys | (set() if request['mode'] == 'prepare' else {'input'}) and
            request['schemaVersion'] == 1 and re.fullmatch(r'[a-f0-9]{32}', request['nonce']), 'Invalid request')
    actor = request['operator']
    require(set(actor) == {'account', 'arn', 'receiptSha256'} and actor['account'] == ACCOUNT and
            re.fullmatch(r'arn:aws:(?:iam|sts)::237343248947:[^\s]{1,470}', actor['arn']) and
            re.fullmatch(r'[a-f0-9]{64}', actor['receiptSha256']), 'Invalid attribution')
    if request['mode'] != 'prepare':
        value = request['input']
        keys = {'kind', 'target', 'before'} | (set() if request['mode'] == 'apply' else {'operation', 'actor', 'after'})
        require(set(value) == keys and value['kind'] == 'mercaria-billing-authority-v1' and value['target'] == TARGET, 'Invalid target/input')
        validate_state(value['before'])
        if request['mode'] == 'rollback':
            require(value['operation'] == 'apply' and isinstance(value['actor'], str) and 0 < len(value['actor']) <= 512, 'Invalid apply receipt')
            validate_state(value['after'])


def build_definition(plan):
    request = plan['request']; live = plan['live']
    validate_request(request)
    require(request['mode'] in ('prepare', 'apply', 'rollback'), 'Unexpected operation')
    require(request['operator'] == {'account': ACCOUNT, 'arn': plan['operator']['Arn'], 'receiptSha256': digest(plan['operator'])}, 'Operator receipt differs')
    if request['mode'] != 'prepare':
        require(request['input']['target'] == TARGET, 'Foreign target or plaintext material')
    encoded = json.dumps(request, sort_keys=True, separators=(',', ':'))
    # The strict application parser rejects any extra property as well.
    require(not any(key in encoded for key in ('"secret":', '"apiSecret":', '"token":')), 'Plaintext credential prohibited')
    return {'family': 'oxy-mercaria-billing-authority', 'executionRoleArn': live['executionRoleArn'],
            'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], 'cpu': live['cpu'], 'memory': live['memory'],
            'runtimePlatform': live['runtimePlatform'], 'volumes': [], 'containerDefinitions': [{
                'name': 'operation', 'image': live['image'], 'essential': True, 'entryPoint': ['/usr/local/bin/node'],
                'command': ['--input-type=module', '--eval', RUNNER.read_text(), '--', '--execute', encoded, hashlib.sha256(encoded.encode()).hexdigest()],
                'workingDirectory': '/app/packages/api', 'environment': [{'name': 'LOG_LEVEL', 'value': 'silent'}],
                'secrets': [live['databaseSecret']], 'portMappings': [], 'mountPoints': [], 'volumesFrom': [],
                'logConfiguration': {'logDriver': 'awslogs', 'options': {'awslogs-group': live['logGroup'],
                    'awslogs-region': transport.REGION, 'awslogs-stream-prefix': live['logStreamPrefix']}}}]}


def decode(events, request):
    lines = [row['message'] for row in events if row['message'].strip()]
    require(len(lines) == 1 and lines[0].startswith('OXY_BILLING_AUTHORITY_RESULT '), 'Missing or ambiguous operation receipt')
    result = json.loads(lines[0].split(' ', 1)[1])
    require(set(result) == {'schemaVersion', 'nonce', 'mode', 'operatorReceiptSha256', 'result'} and result['schemaVersion'] == 1 and
            result['nonce'] == request['nonce'] and result['mode'] == request['mode'] and
            result['operatorReceiptSha256'] == request['operator']['receiptSha256'], 'Receipt does not match operation')
    receipt = result['result']
    expected_keys = {'kind', 'target', 'before'} if request['mode'] == 'prepare' else {'kind', 'target', 'before', 'operation', 'actor', 'after'}
    require(set(receipt) == expected_keys and receipt['kind'] == 'mercaria-billing-authority-v1' and receipt['target'] == TARGET, 'Receipt projection differs')
    for state in [receipt['before']] + ([] if request['mode'] == 'prepare' else [receipt['after']]):
        require(set(state) == {'application', 'credential'}, 'State projection differs')
        for row in state.values():
            require(set(row) == {'scopes', 'version', 'updatedAt'} and isinstance(row['scopes'], list) and
                    all(isinstance(x, str) for x in row['scopes']) and re.fullmatch(r'[0-9]+', row['version']) and
                    isinstance(row['updatedAt'], str) and row['updatedAt'], 'Row projection differs')
    if request['mode'] != 'prepare':
        require(receipt['before'] == request['input']['before'] and receipt['actor'] == request['operator']['arn'] and
                receipt['operation'] == request['mode'], 'Receipt ownership differs')
    return result


def collect(plan, task_arn):
    live = plan['live']; stream = live['logStreamPrefix'] + '/operation/' + task_arn.rsplit('/', 1)[1]
    for attempt in range(12):
        result = aws('logs', 'get-log-events', '--log-group-name', live['logGroup'], '--log-stream-name', stream, '--start-from-head', '--limit', '20')
        events = result['events']
        if events: return decode(events, plan['request'])
        if attempt < 11: time.sleep(5)
    raise RuntimeError('Receipt missing; reconcile exact ID/nonce, never reissue')


def execute(plan, directory):
    require(plan['launcherSha256'] == hashlib.sha256(Path(__file__).read_bytes()).hexdigest() and
            plan['transportSha256'] == hashlib.sha256(BASE.read_bytes()).hexdigest() and
            plan['runnerSha256'] == hashlib.sha256(RUNNER.read_bytes()).hexdigest(), 'Transport source changed')
    require(0 <= time.time() - plan['preparedAt'] <= 1800, 'Operation plan expired')
    require(operator(plan['operator']['Arn']) == plan['operator'], 'Operator changed')
    transport.PROFILES['oxy']['definition'] = plan['definition']
    require(transport.describe('oxy') == plan['live'], 'Live definition or configuration changed')
    require(digest(build_definition(plan)) == plan['taskDefinitionSha256'], 'Executable differs from reviewed plan')
    directory = Path(directory); directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    private_write(directory/'attempt.json', {'pending': True, 'planSha256': digest(plan), 'request': plan['request']})
    # Reserve immutable output before register/run; an uncertain ACK cannot create a second task automatically.
    result_fd = os.open(directory/'result.private.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    registered = None; task_arns = []; cleanup = {'taskStopped': False, 'definitionInactive': False, 'failures': []}
    try:
        definition = build_definition(plan); private_write(directory/'definition.private.json', definition)
        actual = aws('ecs', 'register-task-definition', '--cli-input-json', 'file://' + str((directory/'definition.private.json').resolve()))['taskDefinition']
        registered = actual['taskDefinitionArn']; transport.verify_registered(actual, definition)
        transport.verify_registered(aws('ecs', 'describe-task-definition', '--task-definition', registered)['taskDefinition'], definition)
        private_write(directory/'registered.json', {'taskDefinitionArn': registered, 'startedBy': 'billing-cas-' + plan['request']['nonce'][:20], 'clientToken': digest(plan)})
        launched = aws('ecs', 'run-task', '--cluster', CLUSTER, '--launch-type', 'FARGATE', '--task-definition', registered,
                       '--network-configuration', json.dumps(plan['live']['network']), '--count', '1',
                       '--started-by', 'billing-cas-' + plan['request']['nonce'][:20], '--client-token', digest(plan))
        task_arns = [task['taskArn'] for task in launched.get('tasks', [])]
        private_write(directory/'launch.json', {'taskArns': task_arns, 'taskDefinitionArn': registered})
        require(not launched.get('failures') and len(task_arns) == 1, 'Launch uncertain; reconcile before any retry')
        deadline = time.monotonic() + 180
        while True:
            task = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', task_arns[0])['tasks'][0]
            if task['lastStatus'] == 'STOPPED': break
            require(time.monotonic() < deadline, 'Task timeout; reconcile exact ID'); time.sleep(3)
        require(task['taskDefinitionArn'] == registered and len(task['containers']) == 1 and task['containers'][0].get('exitCode') == 0 and
                task['containers'][0].get('imageDigest') == plan['live']['image'].split('@')[1], 'Task failed or image differs; reconcile exact ID')
        result = collect(plan, task_arns[0])
        with os.fdopen(result_fd, 'w') as stream:
            result_fd = None; json.dump(result, stream); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        private_write(directory/'receipt.json', {'planSha256': digest(plan), 'resultSha256': digest(result), 'taskArn': task_arns[0], 'image': plan['live']['image']})
    finally:
        if result_fd is not None: os.close(result_fd)
        for arn in task_arns:
            try:
                task = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', arn)['tasks'][0]
                require(task['taskDefinitionArn'] == registered, 'Foreign cleanup task')
                if task['lastStatus'] != 'STOPPED':
                    aws('ecs', 'stop-task', '--cluster', CLUSTER, '--task', arn, '--reason', 'Owned billing authority task cleanup')
                    deadline = time.monotonic() + 120
                    while time.monotonic() < deadline:
                        task = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', arn)['tasks'][0]
                        if task['lastStatus'] == 'STOPPED': break
                        time.sleep(3)
                require(task['lastStatus'] == 'STOPPED', 'STOPPED readback missing'); cleanup['taskStopped'] = True
            except Exception: cleanup['failures'].append('task_cleanup_failed')
        if registered:
            try:
                aws('ecs', 'deregister-task-definition', '--task-definition', registered)
                cleanup['definitionInactive'] = aws('ecs', 'describe-task-definition', '--task-definition', registered, '--query', 'taskDefinition.status') == 'INACTIVE'
                require(cleanup['definitionInactive'], 'INACTIVE readback missing')
            except Exception: cleanup['failures'].append('definition_cleanup_failed')
        private_write(directory/'cleanup.json', cleanup)
        require(not cleanup['failures'], 'Cleanup incomplete; operator reconciliation required')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['prepare', 'apply', 'rollback'])
    parser.add_argument('--definition'); parser.add_argument('--expected-operator-arn')
    parser.add_argument('--input'); parser.add_argument('--input-sha256')
    parser.add_argument('--plan', required=True); parser.add_argument('--plan-sha256'); parser.add_argument('--execute', action='store_true'); parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.execute:
        raw = private_read(args.plan); require(hashlib.sha256(raw).hexdigest() == args.plan_sha256, 'Reviewed plan hash differs')
        execute(json.loads(raw), args.output); print('BILLING_AUTHORITY_OPERATION_COMPLETE'); return
    require(args.mode and args.expected_operator_arn and re.fullmatch(r'oxy-oxy-api:[1-9][0-9]*', args.definition or ''), 'Exact operation/operator/definition required')
    identity = operator(args.expected_operator_arn)
    directory = Path(args.output); directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    private_write(directory/'operator.json', identity)
    request = {'schemaVersion': 1, 'mode': args.mode, 'nonce': secrets.token_hex(16),
               'operator': {'account': ACCOUNT, 'arn': identity['Arn'], 'receiptSha256': digest(identity)}}
    if args.mode != 'prepare':
        raw = private_read(args.input); require(hashlib.sha256(raw).hexdigest() == args.input_sha256, 'Reviewed input hash differs')
        previous = json.loads(raw)
        require(previous['mode'] == ('apply' if args.mode == 'rollback' else 'prepare'), 'Input must be exact prepare or apply receipt')
        request['input'] = previous['result']
    transport.PROFILES['oxy']['definition'] = args.definition
    plan = {'schemaVersion': 1, 'definition': args.definition, 'preparedAt': int(time.time()), 'operator': identity,
            'launcherSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'transportSha256': hashlib.sha256(BASE.read_bytes()).hexdigest(), 'runnerSha256': hashlib.sha256(RUNNER.read_bytes()).hexdigest(),
            'live': transport.describe('oxy'), 'request': request}
    plan['taskDefinitionSha256'] = digest(build_definition(plan)); private_write(args.plan, plan)
    print('BILLING_AUTHORITY_PLAN_PREPARED')

if __name__ == '__main__':
    try: main()
    except Exception:
        print('BILLING_AUTHORITY_OPERATION_FAILED: inspect private receipts; no automatic retry', file=os.sys.stderr)
        raise SystemExit(1)
