#!/usr/bin/env python3
"""Prepare/execute the bounded signed feed read from one exact existing Oxy image.

No credentials are read locally. Only the existing ECS-injected signing secret
is retained; no database/provider bindings. --execute requires the prepared
probe SHA to still match. This never updates a service or calls inference.
"""
import argparse
import copy
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
CLUSTER = 'oxy-cluster'
LIVE_ARN = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:691'
OXY_IMAGE = '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:29502ab56460ed8261b5dd747d93fd36e345f28e633a17c865c34d4fae7b653a'
NETWORK_SHA = '2ea917a76b1b6658a95b973c51d36d49034c5bbb1693cff8ac259c387127bfcf'
KAANA_IMAGE = '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/kaana@sha256:2ab33cfeba7c760dddc24761c7e60e1425b326153ce6c4d130465e316b0fa59b'

def aws(args, payload=None):
    command = ['aws', *args, '--profile', 'oxy', '--region', 'us-west-2', '--output', 'json']
    if payload is not None:
        command += ['--cli-input-json', json.dumps(payload)]
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('AWS operation failed: ' + args[0] + '/' + args[1])
    return json.loads(result.stdout)


def steady(service):
    assert service['status'] == 'ACTIVE' and service['desiredCount'] > 0
    assert service['runningCount'] == service['desiredCount'] and service['pendingCount'] == 0
    assert len(service['deployments']) == 1
    assert service['deployments'][0]['rolloutState'] == 'COMPLETED'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--expected-probe-sha256')
    args = parser.parse_args()
    probe = (ROOT / 'scripts/rehearsal/read-kaana-attempt-null-1519.mjs').read_text()
    digest = hashlib.sha256(probe.encode()).hexdigest()
    if args.execute:
        assert digest == args.expected_probe_sha256
    services = aws(['ecs', 'describe-services', '--cluster', CLUSTER,
                    '--services', 'oxy-api', 'kaana', 'kaana-publisher'])['services']
    by_name = {s['serviceName']: s for s in services}
    assert len(by_name) == 3
    for service in services:
        steady(service)
    service = by_name['oxy-api']
    assert service['taskDefinition'] == LIVE_ARN
    network_sha = hashlib.sha256(json.dumps(service['networkConfiguration'], sort_keys=True).encode()).hexdigest()
    assert network_sha == NETWORK_SHA
    live = aws(['ecs', 'describe-task-definition', '--task-definition', LIVE_ARN])['taskDefinition']
    container = next(c for c in live['containerDefinitions'] if c['name'] == 'oxy-api')
    assert container['image'] == OXY_IMAGE
    assert not live.get('volumes') and not container.get('mountPoints')
    for name, revision in [('kaana', 84), ('kaana-publisher', 88)]:
        arn = f'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-{name}:{revision}'
        assert by_name[name]['taskDefinition'] == arn
        td = aws(['ecs', 'describe-task-definition', '--task-definition', arn])['taskDefinition']
        assert next(c for c in td['containerDefinitions'] if c['name'] == name)['image'] == KAANA_IMAGE
    env = {e['name']: e['value'] for e in container.get('environment', [])}
    assert env['KAANA_BASE_URL'] == 'https://kaana.ai'
    secret = [s for s in container.get('secrets', []) if s['name'] == 'KAANA_EDGE_SIGNING_PRIVATE_KEY']
    assert len(secret) == 1
    minimized = copy.deepcopy(live)
    selected = copy.deepcopy(container)
    selected['environment'] = [{'name': name, 'value': env[name]}
                               for name in ('KAANA_BASE_URL', 'KAANA_EDGE_SIGNING_KEY_ID')]
    selected['secrets'] = secret
    for key in ('healthCheck', 'dependsOn'):
        selected.pop(key, None)
    minimized['containerDefinitions'] = [selected]
    minimized['family'] = 'oxy-oxy-api-kaana-null-readback'
    for key in ('taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities',
                'registeredAt', 'registeredBy', 'deregisteredAt'):
        minimized.pop(key, None)
    proof = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'liveTaskDefinition': LIVE_ARN, 'liveImage': OXY_IMAGE,
             'kaanaImage': KAANA_IMAGE, 'probeSha256': digest,
             'taskRoleArn': minimized.get('taskRoleArn'),
             'executionRoleArn': minimized.get('executionRoleArn'),
             'secretNames': [s['name'] for s in selected['secrets']],
             'environmentNames': [e['name'] for e in selected['environment']],
             'command': ['node', '--input-type=module', '-e', '<exact probe bytes>'],
             'entryPoint': selected.get('entryPoint'),
             'networkSha256': network_sha,
             'serviceUpdates': 0, 'providerRequests': 0, 'oxyLedgerWrites': 0}
    output = Path(tempfile.mkdtemp(prefix='oxy1519-null-readback-'))
    (output / 'prepare.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps({'prepare': str(output / 'prepare.json'), **proof}), flush=True)
    if not args.execute:
        return
    task_arn = None
    registered = None
    try:
        registered_definition = aws(['ecs', 'register-task-definition'], minimized)['taskDefinition']
        registered = registered_definition['taskDefinitionArn']
        registered_readback = aws(['ecs', 'describe-task-definition', '--task-definition', registered])['taskDefinition']
        for key, value in minimized.items():
            assert registered_readback[key] == value
        proof['registeredTaskDefinitionVerified'] = True
        result = aws(['ecs', 'run-task'], {'cluster': CLUSTER, 'taskDefinition': registered,
                     'launchType': 'FARGATE', 'networkConfiguration': service['networkConfiguration'],
                     'startedBy': 'i09-read-only-null-feed',
                     'overrides': {'containerOverrides': [{'name': 'oxy-api',
                        'command': ['node', '--input-type=module', '-e', probe],
                        'environment': [{'name': 'CANARY_CONTRACT_VERSION', 'value': '3.5.0'}]}]}})
        assert not result.get('failures') and len(result['tasks']) == 1
        task_arn = result['tasks'][0]['taskArn']
        print(json.dumps({'taskArn': task_arn, 'taskDefinition': registered}), flush=True)
        for _ in range(48):
            task = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', task_arn])['tasks'][0]
            if task['lastStatus'] == 'STOPPED':
                break
            time.sleep(15)
        else:
            raise RuntimeError('bounded task did not stop')
        assert len(task['containers']) == 1
        assert task['taskDefinitionArn'] == registered
        assert task['containers'][0]['image'] == OXY_IMAGE
        override = task['overrides']['containerOverrides']
        assert len(override) == 1 and override[0]['name'] == 'oxy-api'
        assert override[0]['command'] == ['node', '--input-type=module', '-e', probe]
        assert override[0]['environment'] == [{'name': 'CANARY_CONTRACT_VERSION', 'value': '3.5.0'}]
        proof['executedOverrideProbeSha256'] = hashlib.sha256(override[0]['command'][3].encode()).hexdigest()
        assert proof['executedOverrideProbeSha256'] == digest
        options = selected['logConfiguration']['options']
        stream = options['awslogs-stream-prefix'] + '/oxy-api/' + task_arn.rsplit('/', 1)[1]
        messages = aws(['logs', 'get-log-events', '--log-group-name', options['awslogs-group'],
                        '--log-stream-name', stream, '--start-from-head'])['events']
        # Retain only this fixed script's safe result, never arbitrary task logs.
        projected = [json.loads(e['message']) for e in messages
                     if e['message'].startswith('{"probe":"kaana-attempt-null-readback-v1"')]
        assert len(projected) == 1
        (output / 'result.json').write_text(json.dumps(projected[0], indent=2) + '\n')
        assert task['containers'][0].get('exitCode') == 0 and projected[0].get('nullServed') is True
        proof.update({'taskArn': task_arn, 'taskDefinition': registered,
                      'lastStatus': task['lastStatus'], 'exitCode': task['containers'][0]['exitCode'],
                      'result': str(output / 'result.json')})
    finally:
        cleanup_errors = []
        try:
            if task_arn:
                try:
                    task = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', task_arn])['tasks'][0]
                    if task['lastStatus'] != 'STOPPED':
                        aws(['ecs', 'stop-task', '--cluster', CLUSTER, '--task', task_arn,
                             '--reason', 'bounded read-only probe cleanup'])
                        for _ in range(15):
                            task = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', task_arn])['tasks'][0]
                            if task['lastStatus'] == 'STOPPED':
                                break
                            time.sleep(2)
                    proof['cleanupTaskStoppedConfirmed'] = task['lastStatus'] == 'STOPPED'
                    if not proof['cleanupTaskStoppedConfirmed']:
                        cleanup_errors.append('task stop not confirmed')
                except Exception:
                    proof['cleanupTaskStoppedConfirmed'] = False
                    cleanup_errors.append('task describe/stop failed; cleanup not confirmed')
        finally:
            try:
                if registered:
                    state = aws(['ecs', 'deregister-task-definition', '--task-definition', registered])['taskDefinition']['status']
                    proof['deregisteredStatus'] = state
                    if state != 'INACTIVE':
                        cleanup_errors.append('task definition deregistration not confirmed')
            except Exception:
                cleanup_errors.append('task definition deregistration failed')
            finally:
                proof['cleanupErrors'] = cleanup_errors
                (output / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
                print(json.dumps({'proof': str(output / 'proof.json'), 'cleanupErrors': cleanup_errors}), flush=True)
        if cleanup_errors:
            raise RuntimeError('ephemeral task cleanup not confirmed')


if __name__ == '__main__':
    main()
