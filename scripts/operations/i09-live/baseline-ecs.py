#!/usr/bin/env python3
"""I09 prepare-only by default: fixed read-only pilot catalogue/price snapshot.

Transport is the reviewed I03 launcher with only reader/family/result kind and
exact already-live TD693 changed; no task IAM role, extra secrets or effects.
Root reviews the immutable prepare plan and operates --execute.
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
import signal
import importlib.util

ACCOUNT = '237343248947'
REGION = 'us-west-2'
CLUSTER = 'oxy-cluster'
DEFINITION = Path('/home/nate/Oxy/.agent-evidence/i04-i09-runtime-693-alia449-20261004/operation-v3/baseline-definition.json')
DECODER = Path(__file__).with_name('decode-i09-result.py')
INTENT = 'oxy1519-i09-1791093169991-608bdb4f0ed0e8b0'
DEFINITION_SHA = '9a572318bfa7a18706c3e7ff3b7fc8905bd9e797bd077fb56e58dae1ded4a818'
PROFILES = {
    'oxy': {'service': 'oxy-api', 'definition': 'oxy-oxy-api:693', 'container': 'oxy-api', 'cwd': '/app/packages/api', 'parameter': '/oxy/oxy-api/DATABASE_URL'},
}

DEFINITION_QUERY = 'taskDefinition.{arn:taskDefinitionArn,family:family,status:status,executionRoleArn:executionRoleArn,cpu:cpu,memory:memory,networkMode:networkMode,requiresCompatibilities:requiresCompatibilities,runtimePlatform:runtimePlatform,containers:containerDefinitions[].{name:name,image:image,secrets:secrets,environmentNames:environment[].name,logConfiguration:logConfiguration}}'

def aws(*args):
    readonly = (args[0], args[1]) in {('sts','get-caller-identity'),('ecs','describe-services'),('ecs','describe-task-definition'),('ecs','list-tasks'),('ecs','describe-tasks'),('logs','get-log-events')}
    for attempt in range(2 if readonly else 1):
        try:
            result = subprocess.run(['aws', *args, '--region', REGION, '--output', 'json','--cli-connect-timeout','20','--cli-read-timeout','80'], capture_output=True, text=True, timeout=90, check=False)
        except subprocess.TimeoutExpired:
            if readonly and attempt == 0: continue
            raise RuntimeError('AWS timeout; outcome unknown for mutations') from None
        if result.returncode:
            if readonly and attempt == 0: continue
            match = re.search(r'An error occurred \(([A-Za-z][A-Za-z0-9]{1,64})\)',result.stderr)
            code = match.group(1) if match else 'unknown'
            raise RuntimeError('AWS command failed code=' + code + '; raw errors withheld')
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
    secret = {'name': 'DATABASE_URL', 'valueFrom': f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter{selected['parameter']}"}
    require([row for row in container.get('secrets') or [] if row['name'] == 'DATABASE_URL'] == [secret] and 'DATABASE_URL' not in container['environmentNames'], 'Database binding differs from reviewed exact SSM reference')
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
    binding = aws('ecs','describe-task-definition','--task-definition',arn,'--query',"taskDefinition.containerDefinitions[?name==`oxy-api`].{public:environment[?name==`KAANA_BASE_URL` || name==`KAANA_EDGE_SIGNING_KEY_ID`],secret:secrets[?name==`KAANA_EDGE_SIGNING_PRIVATE_KEY`]}")
    require(len(binding)==1 and {r['name']:r['value'] for r in binding[0]['public']} == {'KAANA_BASE_URL':'https://kaana.ai','KAANA_EDGE_SIGNING_KEY_ID':'oxy-edge-2026-08-17'},'Live public Kaana binding changed')
    require(binding[0]['secret']==[{'name':'KAANA_EDGE_SIGNING_PRIVATE_KEY','valueFrom':'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/KAANA_EDGE_SIGNING_PRIVATE_KEY'}],'Live signing reference changed')

    return {'taskDefinition': td['arn'], 'image': container['image'], 'executionRoleArn': td['executionRoleArn'], 'cpu': td['cpu'], 'memory': td['memory'], 'runtimePlatform': td['runtimePlatform'], 'network': network, 'logGroup': '/oxy/ecs', 'logStreamPrefix': log['options']['awslogs-stream-prefix'], 'databaseSecret': secret, 'stripeBindingPresent': any(row['name'] == 'STRIPE_SECRET_KEY' for row in container.get('secrets') or []) or 'STRIPE_SECRET_KEY' in container['environmentNames']}


def private_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(value, output, indent=2); output.write('\n'); output.flush(); os.fsync(output.fileno())


def build_definition(plan):
    require(hashlib.sha256(DEFINITION.read_bytes()).hexdigest()==DEFINITION_SHA==plan['definitionFileSha256'],'Prepared definition changed')
    require(hashlib.sha256(DECODER.read_bytes()).hexdigest()==plan['decoderSha256'],'Decoder changed')
    definition=json.loads(DEFINITION.read_text());live=plan['live']
    require(len(json.dumps(definition,separators=(',',':')).encode())<=60000,'Definition payload too large')
    require(definition['family']=='oxy-i09-exact-baseline' and not definition.get('taskRoleArn'),'Unexpected baseline family/authority')
    c=definition['containerDefinitions'];require(len(c)==1,'Unexpected containers');c=c[0]
    require(c['name']=='i09' and c['image']==live['image'] and definition['executionRoleArn']==live['executionRoleArn'],'Image/role differs')
    require(c['secrets']==[live['databaseSecret'],{'name':'KAANA_EDGE_SIGNING_PRIVATE_KEY','valueFrom':'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/KAANA_EDGE_SIGNING_PRIVATE_KEY'}],'Baseline secret boundary differs')
    require(c['environment']==[{'name':'NODE_ENV','value':'production'},{'name':'KAANA_BASE_URL','value':'https://kaana.ai'},{'name':'KAANA_EDGE_SIGNING_KEY_ID','value':'oxy-edge-2026-08-17'}],'Baseline environment differs')
    require(c['workingDirectory']=='/app/packages/api' and c['entryPoint']==['/usr/local/bin/node'] and c['command'][:2]==['--input-type=module','-e'],'Baseline command shape differs')
    return definition


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
    spec=importlib.util.spec_from_file_location('i09_decoder',DECODER);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    if not any(e['message'].startswith('OXY_I09_RESULT ')for e in events):raise RuntimeError('No result packets')
    return module.decode(events,INTENT,'i09-baseline-attestation-v1')


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
            if str(error) not in ['No result packets', 'Incomplete output packets'] or attempt == 11:
                raise
            time.sleep(5)
    raise RuntimeError('Inventory log delivery timeout')


def execute(plan, directory):
    require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == plan['launcherSha256'], 'Launcher source differs from reviewed plan')
    require(plan['schemaVersion'] == 1 and plan['profile'] in PROFILES and re.fullmatch('[a-f0-9]{32}', plan['nonce']), 'Invalid plan')
    require(0 <= time.time() - plan['preparedAt'] <= 3600, 'Prepared plan expired')
    require(describe(plan['profile']) == plan['live'], 'Live pins/shape changed since review')
    require(digest(build_definition(plan)) == plan['taskDefinitionSha256'], 'Definition differs from reviewed plan')
    directory = Path(directory); directory.mkdir(parents=True, exist_ok=False); os.chmod(directory, 0o700)
    definition = build_definition(plan); private_json(directory/'definition.json', definition)
    registered = None; task_arn = None; launched_arns = []; dispatch_pending=False; registration_pending=False; cleanup = {'taskStopped': False, 'definitionInactive': False}
    try:
        private_json(directory/'registration-intent.json',{'definitionSha256':digest(definition),'family':definition['family'],'planSha256':digest(plan)})
        registration_pending=True
        registration = aws('ecs', 'register-task-definition', '--cli-input-json', 'file://' + str((directory/'definition.json').resolve()))['taskDefinition']
        registered = registration['taskDefinitionArn']; registration_pending=False
        verify_registered(registration, definition)
        readback = aws('ecs', 'describe-task-definition', '--task-definition', registered)['taskDefinition']
        verify_registered(readback, definition)
        private_json(directory/'registered-readback.json', {'taskDefinitionArn': registered, 'executableDefinitionSha256': digest(definition), 'returnedAndReadbackVerified': True})
        request={'cluster':CLUSTER,'launchType':'FARGATE','taskDefinition':registered,'networkConfiguration':plan['live']['network'],'count':1,'startedBy':'i09-baseline-'+plan['nonce'][:12]}
        private_json(directory/'run-task.json',request)
        private_json(directory/'dispatch-intent.json',{'planSha256':digest(plan),'requestSha256':digest(request),'taskDefinitionArn':registered,'startedBy':request['startedBy'],'intent':INTENT})
        dispatch_pending=True
        launched=aws('ecs','run-task','--cli-input-json','file://'+str((directory/'run-task.json').resolve()))
        dispatch_pending=False
        launched_arns = [task['taskArn'] for task in launched.get('tasks', [])]
        if len(launched_arns) == 1: task_arn = launched_arns[0]
        require(not launched.get('failures') and len(launched_arns) == 1, 'Read-only task failed to launch')
        private_json(directory/'launch.json', {'taskArn': task_arn, 'taskDefinitionArn': registered, 'planSha256': digest(plan)})
        deadline = time.monotonic() + 600
        while True:
            task = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', task_arn)['tasks'][0]
            require(task['taskDefinitionArn']==registered and task.get('startedBy')==request['startedBy'],'Owned task binding changed')
            if task['lastStatus'] == 'STOPPED': break
            require(time.monotonic() < deadline, 'Inventory task exceeded timeout'); time.sleep(5)
        cleanup['taskStopped'] = True
        require(task['taskDefinitionArn'] == registered and len(task['containers']) == 1 and task['containers'][0].get('exitCode') == 0 and task['containers'][0].get('imageDigest') == plan['live']['image'].split('@')[1], 'Stopped task failed or image changed')
        stream = plan['live']['logStreamPrefix'] + '/i09/' + task_arn.rsplit('/', 1)[1]
        result = collect_result(plan['live']['logGroup'], stream, plan['nonce'])
        require(result['kind']=='i09-baseline-attestation-v1' and result['intent']==INTENT,'Invalid baseline projection')
        private_json(directory/'result.private.json',result)
        private_json(directory/'receipt.json',{'kind':'i09-baseline-task-receipt','planSha256':digest(plan),'resultSha256':digest(result),'taskArn':task_arn,'taskDefinitionArn':registered,'runtimeImage':plan['live']['image'],'intent':INTENT,'readOnlySql':True,'signedExactRegistryRead':True})

    finally:
        failures = ['dispatch_outcome_unknown_requires_reconciliation'] if dispatch_pending else []
        if registration_pending: failures.append('registration_outcome_unknown_requires_reconciliation')
        cleanup['registrationOutcomeUnknown']=registration_pending
        for launched_arn in launched_arns:
            try:
                own = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', launched_arn)['tasks'][0]
                require(own['taskDefinitionArn']==registered and own.get('startedBy')==request['startedBy'],'Cleanup owned task binding changed')
                status = own['lastStatus']
                if status != 'STOPPED':
                    aws('ecs', 'stop-task', '--cluster', CLUSTER, '--task', launched_arn, '--reason', 'Read-only inventory cleanup')
                    deadline = time.monotonic() + 120
                    while time.monotonic() < deadline:
                        own = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', launched_arn)['tasks'][0]
                        require(own['taskDefinitionArn']==registered and own.get('startedBy')==request['startedBy'],'Cleanup owned task binding changed')
                        status = own['lastStatus']
                        if status == 'STOPPED': break
                        time.sleep(5)
                require(status == 'STOPPED', 'Task STOPPED readback missing')
            except Exception:
                failures.append('task_cleanup_failed')
        cleanup['taskStopped'] = bool(launched_arns) and not any(f=='task_cleanup_failed' for f in failures)
        cleanup['dispatchOutcomeUnknown']=dispatch_pending
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
    parser.add_argument('--plan', required=True); parser.add_argument('--execute', action='store_true'); parser.add_argument('--output')
    args = parser.parse_args()
    if args.execute:
        require(args.output is not None, 'Execute requires a new private output directory')
        plan = json.loads(Path(args.plan).read_text()); require(plan['profile'] == args.profile, 'Plan profile differs'); execute(plan, args.output)
    else:
        plan = {'schemaVersion': 1, 'profile': args.profile, 'preparedAt': int(time.time()), 'nonce': secrets.token_hex(16), 'definitionFileSha256':DEFINITION_SHA,'decoderSha256':hashlib.sha256(DECODER.read_bytes()).hexdigest(), 'launcherSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'live': describe(args.profile)}
        plan['taskDefinitionSha256'] = digest(build_definition(plan)); private_json(args.plan, plan)
        print(json.dumps({'prepared': True, 'profile': args.profile, 'plan': args.plan, 'image': plan['live']['image'], 'definitionSha256': plan['taskDefinitionSha256']}))

if __name__ == '__main__':
    def interrupted(signum,frame):
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        raise KeyboardInterrupt('operator interrupted')
    signal.signal(signal.SIGTERM,interrupted)
    try: main()
    except BaseException as error:
        print('Inference pilot readiness failed: ' + (str(error) if isinstance(error, RuntimeError) else 'internal error; details withheld'), file=os.sys.stderr); raise SystemExit(1)
