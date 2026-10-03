#!/usr/bin/env python3
"""Prepare by default; two issuer mints 245s apart using selected existing Noted refs.

No DB/task role/new credentials. Writes only the existing mint's lastUsedAt and
rate-limit state. Inherits reviewed inventory readback/cleanup implementation;
script, image, role, network, credential refs and issuer steady pins are exact.
Root executes only after technical review and new issuer stable.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time

ACCOUNT = '237343248947'
REGION = 'us-west-2'
CLUSTER = 'oxy-cluster'
READER = Path(__file__).with_name('probe-service-token-issuer-1519.mjs')
PROFILES = {
    'noted': {'service': 'noted', 'definition': 'oxy-noted:37', 'container': 'noted', 'cwd': '/app'},
}
DEFINITION_QUERY = 'taskDefinition.{arn:taskDefinitionArn,family:family,status:status,executionRoleArn:executionRoleArn,cpu:cpu,memory:memory,networkMode:networkMode,requiresCompatibilities:requiresCompatibilities,runtimePlatform:runtimePlatform,containers:containerDefinitions[].{name:name,image:image,secrets:secrets,environmentNames:environment[].name,logConfiguration:logConfiguration}}'

def aws(*args):
    result = subprocess.run(['aws', *args, '--region', REGION, '--output', 'json'], capture_output=True, text=True, timeout=40, check=False)
    if result.returncode:
        raise RuntimeError('AWS metadata/action failed; raw errors withheld')
    return json.loads(result.stdout)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def describe(profile):
    selected = PROFILES[profile]
    require(aws('sts', 'get-caller-identity')['Account'] == ACCOUNT, 'Wrong AWS account')
    result = aws('ecs', 'describe-services', '--cluster', CLUSTER, '--services', selected['service'])
    require(not result.get('failures') and len(result['services']) == 1, 'Service missing/ambiguous')
    service = result['services'][0]
    arn = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{selected['definition']}"
    require(service['taskDefinition'] == arn and service['pendingCount'] == 0 and service['runningCount'] == service['desiredCount'] > 0, 'Live service is not the pinned stable definition')
    require(len(service['deployments']) == 1 and service['deployments'][0]['status'] == 'PRIMARY' and service['deployments'][0].get('rolloutState') == 'COMPLETED', 'Deployment not stable')
    td = aws('ecs', 'describe-task-definition', '--task-definition', arn, '--query', DEFINITION_QUERY)
    require(td['arn'] == arn and td['status'] == 'ACTIVE' and td['networkMode'] == 'awsvpc' and 'FARGATE' in td['requiresCompatibilities'], 'Unexpected task definition shape')
    require(td['runtimePlatform'] == {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'}, 'Unexpected runtime platform')
    containers = [row for row in td['containers'] if row['name'] == selected['container']]
    require(len(containers) == 1, 'Container missing/ambiguous')
    container = containers[0]
    require(re.fullmatch(r'237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com/oxy/[a-z-]+@sha256:[a-f0-9]{64}', container['image']) is not None, 'Image must be pinned by digest')
    selected_secrets = [
        {'name': name, 'valueFrom': f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/oxy/noted/{name}"}
        for name in ('OXY_APPLICATION_KEY', 'OXY_APPLICATION_SECRET')]
    for secret in selected_secrets:
        require([row for row in container.get('secrets') or [] if row['name'] == secret['name']] == [secret]
                and secret['name'] not in container['environmentNames'], 'Selected credential reference changed')
    canary_secrets = [{'name': 'OXY_CANARY_API_KEY' if row['name'] == 'OXY_APPLICATION_KEY' else 'OXY_CANARY_API_SECRET',
                      'valueFrom': row['valueFrom']} for row in selected_secrets]
    task_arns = aws('ecs', 'list-tasks', '--cluster', CLUSTER, '--service-name', selected['service'], '--desired-status', 'RUNNING')['taskArns']
    tasks = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', *task_arns)
    require(not tasks.get('failures') and len(tasks['tasks']) == service['desiredCount'], 'Live task count differs')
    image_digest = container['image'].split('@')[1]
    for task in tasks['tasks']:
        require(task['taskDefinitionArn'] == arn and task['lastStatus'] == 'RUNNING', 'Unexpected live task revision/status')
        current = [c for c in task['containers'] if c['name'] == selected['container']]
        require(len(current) == 1 and current[0].get('imageDigest') == image_digest, 'Runtime image differs from definition digest')
    network = service['networkConfiguration']
    require(network['awsvpcConfiguration']['assignPublicIp'] == 'DISABLED', 'Public network prohibited')
    log = container['logConfiguration']
    require(log['logDriver'] == 'awslogs' and log['options']['awslogs-region'] == REGION and log['options']['awslogs-group'] == '/oxy/ecs', 'Unexpected logging destination')
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,100}', log['options'].get('awslogs-stream-prefix', '')) is not None, 'Invalid live log stream prefix')
    require(re.fullmatch(f'arn:aws:iam::{ACCOUNT}:role/[A-Za-z0-9_/+=,.@-]+', td['executionRoleArn']) is not None, 'Unexpected execution role')
    # Only metadata names/references are returned. Environment values are never queried.
    return {'taskDefinition': td['arn'], 'image': container['image'], 'executionRoleArn': td['executionRoleArn'], 'cpu': td['cpu'], 'memory': td['memory'], 'runtimePlatform': td['runtimePlatform'], 'network': network, 'logGroup': '/oxy/ecs', 'logStreamPrefix': log['options']['awslogs-stream-prefix'], 'canarySecrets': canary_secrets}


def private_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(value, output, indent=2); output.write('\n')


def build_definition(plan):
    profile = plan['profile']; selected = PROFILES[profile]; source = READER.read_text()
    require(hashlib.sha256(source.encode()).hexdigest() == plan['readerSha256'], 'Reader source differs')
    invocation = "\ntry { const result = await probeIssuer({ apiKey: process.env.OXY_CANARY_API_KEY, apiSecret: process.env.OXY_CANARY_API_SECRET }); const data = Buffer.from(JSON.stringify({kind: 'issuer-mint-canary', profile: 'noted', ...result})); if (data.length > 65536) throw Error('bounded-result'); const {createHash} = await import('node:crypto'); const packet = {nonce: " + json.dumps(plan['nonce']) + ", seq: 0, total: 1, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64')}; console.log('OXY_BILLING_INVENTORY ' + JSON.stringify(packet)); if (!result.ok) process.exitCode=1; } catch { console.error('OXY_ISSUER_CANARY_FAILED'); process.exitCode=1; }\n"
    live = plan['live']
    return {'family': 'oxy-issuer-mint-canary-noted', 'executionRoleArn': live['executionRoleArn'], 'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], 'cpu': live['cpu'], 'memory': live['memory'], 'runtimePlatform': live['runtimePlatform'], 'volumes': [], 'containerDefinitions': [{'name': 'inventory', 'image': live['image'], 'essential': True, 'entryPoint': ['/usr/local/bin/node'], 'command': ['--input-type=module', '-e', source + invocation], 'workingDirectory': selected['cwd'], 'environment': [], 'secrets': live['canarySecrets'], 'portMappings': [], 'mountPoints': [], 'volumesFrom': [], 'logConfiguration': {'logDriver': 'awslogs', 'options': {'awslogs-group': live['logGroup'], 'awslogs-region': REGION, 'awslogs-stream-prefix': live['logStreamPrefix']}}}]}


def verify_registered(actual, expected):
    """Normalize AWS empty defaults only; executable/authority bytes stay exact."""
    require(not actual.get('taskRoleArn') and not actual.get('proxyConfiguration') and not actual.get('ipcMode') and not actual.get('pidMode') and not actual.get('inferenceAccelerators') and not actual.get('enableFaultInjection'), 'Registered task gained authority or execution machinery')
    require(not actual.get('placementConstraints'), 'Registered placement differs')
    for key in ['family', 'executionRoleArn', 'networkMode', 'cpu', 'memory', 'runtimePlatform']:
        require(actual.get(key) == expected[key], 'Registered task field differs: ' + key)
    require(sorted(actual.get('requiresCompatibilities', [])) == sorted(expected['requiresCompatibilities']) and actual.get('volumes', []) == [], 'Registered compatibility/volumes differ')
    containers = actual.get('containerDefinitions', [])
    require(len(containers) == 1, 'Registered sidecar/container count differs')
    container = containers[0]; intended = expected['containerDefinitions'][0]
    for key in ['name', 'image', 'essential', 'entryPoint', 'command', 'workingDirectory']:
        require(container.get(key) == intended[key], 'Registered executable differs: ' + key)
    for key in ['environment', 'secrets', 'portMappings', 'mountPoints', 'volumesFrom']:
        require(container.get(key, []) == intended[key], 'Registered container inputs differ: ' + key)
    require(not container.get('environmentFiles') and not container.get('links') and not container.get('extraHosts') and not container.get('dnsServers') and not container.get('dnsSearchDomains') and not container.get('systemControls') and not container.get('ulimits') and not container.get('privileged') and not container.get('linuxParameters') and not container.get('dependsOn') and not container.get('healthCheck') and not container.get('repositoryCredentials') and not container.get('resourceRequirements') and not container.get('user'), 'Registered container gained execution behavior')
    log = container.get('logConfiguration', {})
    require(log.get('logDriver') == intended['logConfiguration']['logDriver'] and log.get('options') == intended['logConfiguration']['options'] and not log.get('secretOptions'), 'Registered logs differ')
    require(re.fullmatch(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{expected['family']}:[1-9][0-9]*", actual.get('taskDefinitionArn', '')) is not None and actual.get('status') == 'ACTIVE', 'Registered task ARN/status differs')


def decode(events, nonce):
    packets = []
    for event in events:
        message = event['message']
        if message.startswith('OXY_BILLING_INVENTORY '):
            packet = json.loads(message.split(' ', 1)[1])
            require(set(packet) == {'nonce', 'seq', 'total', 'sha256', 'data'}, 'Unexpected packet fields')
            require(type(packet['seq']) is int and type(packet['total']) is int and 0 <= packet['seq'] < packet['total'] and isinstance(packet['data'], str) and len(packet['data']) <= 12000, 'Invalid packet shape')
            require(packet['nonce'] == nonce, 'Foreign result nonce'); packets.append(packet)
        elif message.strip():
            raise RuntimeError('Unexpected canary log message')
    require(packets, 'No result packets')
    first = packets[0]; require(1 <= first['total'] <= 128, 'Invalid output packet count')
    require(len(packets) <= first['total'] and len({p['seq'] for p in packets}) == len(packets), 'Ambiguous/duplicate output packets')
    require(len(packets) == first['total'] and {p['seq'] for p in packets} == set(range(first['total'])), 'Incomplete output packets')
    require(all(p['sha256'] == first['sha256'] and p['total'] == first['total'] for p in packets), 'Packet commitments differ')
    encoded = ''.join(p['data'] for p in sorted(packets, key=lambda p: p['seq']))
    require(len(encoded) <= 1400000, 'Encoded output oversized')
    raw = base64.b64decode(encoded, validate=True)
    require(len(raw) <= 1048576 and hashlib.sha256(raw).hexdigest() == first['sha256'], 'Result bytes/digest differ')
    return json.loads(raw)


def collect_result(log_group, stream, nonce):
    # CloudWatch delivery may lag STOPPED. Only incomplete delivery is retried;
    # conflicting nonce/digest/packets fail immediately.
    for attempt in range(12):
        events = []; token = None
        try:
            for page_number in range(128):
                args = ['logs', 'get-log-events', '--log-group-name', log_group, '--log-stream-name', stream, '--start-from-head']
                if token: args += ['--next-token', token]
                page = aws(*args); events.extend(page['events']); next_token = page['nextForwardToken']
                require(sum(len(event['message'].encode()) for event in events) <= 1500000, 'Log output exceeds fixed bound')
                if next_token == token: break
                token = next_token
            else: raise RuntimeError('Log pagination exceeded bound')
            return decode(events, nonce)
        except RuntimeError as error:
            if str(error) not in ['AWS metadata/action failed; raw errors withheld', 'No result packets', 'Incomplete output packets'] or attempt == 11:
                raise
            time.sleep(5)
    raise RuntimeError('Canary log delivery timeout')


def describe_issuer(definition, image):
    require(re.fullmatch(f'arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/oxy-oxy-api:[1-9][0-9]*', definition) is not None, 'Exact issuer definition required')
    require(re.fullmatch(rf'{ACCOUNT}\.dkr\.ecr\.{REGION}\.amazonaws\.com/oxy/oxy-api@sha256:[a-f0-9]{{64}}', image) is not None, 'Exact issuer image required')
    response = aws('ecs', 'describe-services', '--cluster', CLUSTER, '--services', 'oxy-api')
    require(not response.get('failures') and len(response.get('services', [])) == 1, 'Issuer service ambiguous')
    service = response['services'][0]
    require(service['status'] == 'ACTIVE' and service['taskDefinition'] == definition and service['pendingCount'] == 0 and service['runningCount'] == service['desiredCount'] > 0
            and len(service['deployments']) == 1 and service['deployments'][0]['status'] == 'PRIMARY' and service['deployments'][0].get('rolloutState') == 'COMPLETED', 'Issuer not pinned and steady')
    tasks = aws('ecs', 'list-tasks', '--cluster', CLUSTER, '--service-name', 'oxy-api', '--desired-status', 'RUNNING')['taskArns']
    current = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', *tasks)
    require(not current.get('failures') and len(current['tasks']) == service['desiredCount'], 'Issuer task set differs')
    for task in current['tasks']:
        containers = [row for row in task['containers'] if row['name'] == 'oxy-api']
        require(task['taskDefinitionArn'] == definition and task['lastStatus'] == 'RUNNING' and len(containers) == 1
                and containers[0].get('imageDigest') == image.split('@')[1], 'Issuer runtime digest/revision differs')
    return {'taskDefinition': definition, 'image': image, 'tasks': sorted(tasks)}


def execute(plan, directory):
    require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == plan['launcherSha256'], 'Launcher source differs from reviewed plan')
    require(plan['schemaVersion'] == 1 and plan['profile'] in PROFILES and re.fullmatch('[a-f0-9]{32}', plan['nonce']), 'Invalid plan')
    require(0 <= time.time() - plan['preparedAt'] <= 3600, 'Prepared plan expired')
    require(describe(plan['profile']) == plan['live'], 'Live pins/shape changed since review')
    require(describe_issuer(plan['issuer']['taskDefinition'], plan['issuer']['image']) == plan['issuer'], 'Issuer changed since review')
    require(digest(build_definition(plan)) == plan['taskDefinitionSha256'], 'Definition differs from reviewed plan')
    directory = Path(directory); directory.mkdir(parents=True, exist_ok=False); os.chmod(directory, 0o700)
    definition = build_definition(plan); private_json(directory/'definition.json', definition)
    registered = None; task_arn = None; launched_arns = []; cleanup = {'taskStopped': False, 'definitionInactive': False}
    try:
        registration = aws('ecs', 'register-task-definition', '--cli-input-json', 'file://' + str((directory/'definition.json').resolve()))['taskDefinition']
        registered = registration['taskDefinitionArn']
        verify_registered(registration, definition)
        readback = aws('ecs', 'describe-task-definition', '--task-definition', registered)['taskDefinition']
        verify_registered(readback, definition)
        private_json(directory/'registered-readback.json', {'taskDefinitionArn': registered, 'executableDefinitionSha256': digest(definition), 'returnedAndReadbackVerified': True})
        launched = aws('ecs', 'run-task', '--cluster', CLUSTER, '--launch-type', 'FARGATE', '--task-definition', registered, '--network-configuration', json.dumps(plan['live']['network']), '--count', '1', '--started-by', 'issuer-canary-'+plan['nonce'][:12])
        launched_arns = [task['taskArn'] for task in launched.get('tasks', [])]
        if len(launched_arns) == 1: task_arn = launched_arns[0]
        require(not launched.get('failures') and len(launched_arns) == 1, 'Canary task failed to launch')
        private_json(directory/'launch.json', {'taskArn': task_arn, 'taskDefinitionArn': registered, 'planSha256': digest(plan)})
        deadline = time.monotonic() + 600
        while True:
            task = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', task_arn)['tasks'][0]
            if task['lastStatus'] == 'STOPPED': break
            require(time.monotonic() < deadline, 'Canary task exceeded timeout'); time.sleep(5)
        cleanup['taskStopped'] = True
        require(task['taskDefinitionArn'] == registered and len(task['containers']) == 1 and task['containers'][0].get('exitCode') in (0, 1) and task['containers'][0].get('imageDigest') == plan['live']['image'].split('@')[1], 'Stopped task failed or image changed')
        stream = plan['live']['logStreamPrefix'] + '/inventory/' + task_arn.rsplit('/', 1)[1]
        result = collect_result(plan['live']['logGroup'], stream, plan['nonce'])
        require(result['kind'] == 'issuer-mint-canary' and result['profile'] == 'noted' and type(result['ok']) is bool and 1 <= len(result['observations']) <= 2, 'Invalid canary result')
        private_json(directory/'result.private.json', result)
        private_json(directory/'receipt.json', {'planSha256': digest(plan), 'resultSha256': digest(result), 'taskArn': task_arn, 'taskDefinitionArn': registered, 'runtimeImage': plan['live']['image'], 'profile': 'noted', 'authenticationWrites': ['credential/app lastUsedAt', 'rate-limit counters'], 'observations': result['observations']})
        require(result['ok'] is True and len(result['observations']) == 2 and task['containers'][0].get('exitCode') == 0, 'Canary failed; status/429 evidence retained')
        require(all(row['httpStatus'] == 200 and row['signatureVerified'] is True and row['lifetimeSeconds'] == 300 for row in result['observations']) and result['observations'][1]['elapsedSinceFirstMs'] > 240000, 'Canary observations invalid')
        require(describe_issuer(plan['issuer']['taskDefinition'], plan['issuer']['image']) == plan['issuer'], 'Issuer changed during canary')
    finally:
        failures = []
        for launched_arn in launched_arns:
            try:
                status = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', launched_arn)['tasks'][0]['lastStatus']
                if status != 'STOPPED':
                    aws('ecs', 'stop-task', '--cluster', CLUSTER, '--task', launched_arn, '--reason', 'Issuer mint canary cleanup')
                    deadline = time.monotonic() + 120
                    while time.monotonic() < deadline:
                        status = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', launched_arn)['tasks'][0]['lastStatus']
                        if status == 'STOPPED': break
                        time.sleep(5)
                require(status == 'STOPPED', 'Task STOPPED readback missing')
            except Exception:
                failures.append('task_cleanup_failed')
        cleanup['taskStopped'] = bool(launched_arns) and not failures
        if registered:
            try:
                aws('ecs', 'deregister-task-definition', '--task-definition', registered)
                cleanup['definitionInactive'] = aws('ecs', 'describe-task-definition', '--task-definition', registered, '--query', 'taskDefinition.status') == 'INACTIVE'
            except Exception:
                failures.append('definition_cleanup_failed')
        cleanup['failures'] = failures
        private_json(directory/'cleanup.json', cleanup)
        require(not failures and (not registered or cleanup['definitionInactive']), 'Cleanup readback incomplete')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('profile', choices=PROFILES)
    parser.add_argument('--issuer-definition', required=True); parser.add_argument('--issuer-image', required=True); parser.add_argument('--plan', required=True); parser.add_argument('--execute', action='store_true'); parser.add_argument('--output')
    args = parser.parse_args()
    if args.execute:
        require(args.output is not None, 'Execute requires a new private output directory')
        plan = json.loads(Path(args.plan).read_text()); require(plan['profile'] == args.profile and plan['issuer']['taskDefinition'] == args.issuer_definition and plan['issuer']['image'] == args.issuer_image, 'Plan inputs differ'); execute(plan, args.output)
    else:
        plan = {'schemaVersion': 1, 'profile': args.profile, 'preparedAt': int(time.time()), 'nonce': secrets.token_hex(16), 'readerSha256': hashlib.sha256(READER.read_bytes()).hexdigest(), 'launcherSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'live': describe(args.profile), 'issuer': describe_issuer(args.issuer_definition, args.issuer_image)}
        plan['taskDefinitionSha256'] = digest(build_definition(plan)); private_json(args.plan, plan)
        print(json.dumps({'prepared': True, 'profile': args.profile, 'plan': args.plan, 'image': plan['live']['image'], 'definitionSha256': plan['taskDefinitionSha256']}))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Issuer mint canary failed: ' + (str(error) if isinstance(error, RuntimeError) else 'internal error; details withheld'), file=os.sys.stderr); raise SystemExit(1)
