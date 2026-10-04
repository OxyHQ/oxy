#!/usr/bin/env python3
"""Plan-only by default. Three bounded phases, pinned image and no secret transport.

Prepare/recover use only the existing DATABASE_URL reference and no task role.
Execute uses the existing Alia workload role, never creates IAM or user consent.
A fsynced plan/dispatch intent precedes writes; unknown ACK never redispatches.
"""
import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reviewed_transport', Path(__file__).with_name('foreground-pilot-ecs.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
base = transport.base
require, private_json, digest = base.require, base.private_json, base.digest
ROLE = 'arn:aws:iam::237343248947:role/oxy-alia-task'
APP = '6a2f851751b784a86fd0e934'
OWNER = '01a0369b-1222-712f-8df6-f8ffeb78ccc2'
HELPERS = ['scripts/agency/alia-revocation-canary.mjs', 'scripts/agency/alia-revocation-canary-receiver.mjs',
    'scripts/agency/stage-alia-canary-module.mjs', 'scripts/agency/artifacts/alia-revocation-canary.cjs']
SOURCE_PATHS = HELPERS + ['scripts/agency/artifacts/alia-revocation-canary.json', 'scripts/agency/alia-revocation-canary-ecs.py',
    'scripts/agency/foreground-pilot-ecs.py', 'scripts/agency/oxy-profile-registrar-preflight-ecs.py',
    'packages/api/src/services/aliaRevocationCanary.service.ts',
    'packages/api/src/services/applicationCredentialRevocation.service.ts',
    'packages/api/src/services/applicationCredentialAudit.service.ts']
COMPILED_PATHS = ['dist/services/aliaRevocationCanary.service.js',
    'dist/services/applicationCredentialRevocation.service.js',
    'dist/services/applicationCredentialAudit.service.js',
    'dist/config/postgres.js', 'dist/utils/credentialMaterial.js']
PREFIX = 'ALIA_CANARY_RESULT '
interrupted = False
cleanup_running = False


def handle_signal(_signum, _frame):
    global interrupted
    interrupted = True
    if not cleanup_running:
        raise InterruptedError('Operator interrupted; reconcile durable intent')


def aws(*args):
    return transport.aws(*args)


base.aws = aws


def outside(path):
    result = Path(path).resolve()
    require(result != ROOT and ROOT not in result.parents, 'Private records must be outside source')
    return result


def pins():
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCE_PATHS}


def live(definition):
    transport.configure_profile(definition)
    return base.describe('oxy')



def recovery_live(definition):
    """Same immutable TD and service network, even when its desired count is zero.

    No historical/current image substitution: a changed TD/network still needs a
    newly reviewed plan. Recovery does not call the public API or acquire a role.
    """
    transport.configure_profile(definition)
    arn = f'arn:aws:ecs:{base.REGION}:{base.ACCOUNT}:task-definition/{definition}'
    result = aws('ecs', 'describe-services', '--cluster', base.CLUSTER, '--services', 'oxy-api')
    require(not result.get('failures') and len(result.get('services', [])) == 1, 'Recovery service ambiguous')
    service = result['services'][0]
    require(service['taskDefinition'] == arn and service['pendingCount'] == 0
            and service['runningCount'] == service['desiredCount'] >= 0, 'Recovery definition/service drifted')
    deployments = service.get('deployments', [])
    if service['desiredCount'] == 0:
        require(deployments and all(all(row.get(key) == 0 for key in ('desiredCount', 'runningCount', 'pendingCount'))
                for row in deployments), 'Quiesced recovery deployment still has work')
    else:
        require(len(deployments) == 1 and deployments[0]['status'] == 'PRIMARY'
                and deployments[0].get('rolloutState') == 'COMPLETED', 'Active recovery deployment ambiguous')
    td = aws('ecs', 'describe-task-definition', '--task-definition', arn, '--query', base.DEFINITION_QUERY)
    require(td.get('arn') == arn and td.get('status') == 'ACTIVE' and td.get('networkMode') == 'awsvpc'
            and 'FARGATE' in td.get('requiresCompatibilities', [])
            and td.get('runtimePlatform') == {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'},
            'Recovery definition platform differs')
    containers = [row for row in td['containers'] if row['name'] == 'oxy-api']
    require(len(containers) == 1, 'Recovery API container ambiguous')
    container = containers[0]
    require(re.fullmatch(r'237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com/oxy/[a-z-]+@sha256:[a-f0-9]{64}',
                         container['image']), 'Recovery image not immutable')
    secret = {'name': 'DATABASE_URL', 'valueFrom': f'arn:aws:ssm:{base.REGION}:{base.ACCOUNT}:parameter/oxy/oxy-api/DATABASE_URL'}
    require([row for row in container.get('secrets') or [] if row['name'] == 'DATABASE_URL'] == [secret]
            and 'DATABASE_URL' not in container['environmentNames'], 'Recovery database binding differs')
    network = service['networkConfiguration']; require(network['awsvpcConfiguration']['assignPublicIp'] == 'DISABLED', 'Public network prohibited')
    log = container['logConfiguration']
    require(log['logDriver'] == 'awslogs' and log['options']['awslogs-group'] == '/oxy/ecs'
            and log['options']['awslogs-region'] == base.REGION
            and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', log['options'].get('awslogs-stream-prefix', '')), 'Recovery logs differ')
    require(re.fullmatch(f'arn:aws:iam::{base.ACCOUNT}:role/[A-Za-z0-9_/+=,.@-]+', td['executionRoleArn']), 'Recovery execution role differs')
    return {'taskDefinition': td['arn'], 'image': container['image'], 'executionRoleArn': td['executionRoleArn'],
        'cpu': td['cpu'], 'memory': td['memory'], 'runtimePlatform': td['runtimePlatform'], 'network': network,
        'logGroup': '/oxy/ecs', 'logStreamPrefix': log['options']['awslogs-stream-prefix'], 'databaseSecret': secret,
        'stripeBindingPresent': any(row['name'] == 'STRIPE_SECRET_KEY' for row in container.get('secrets') or [])
            or 'STRIPE_SECRET_KEY' in container['environmentNames']}


def phase_live(operation, definition):
    return recovery_live(definition) if operation == 'recover' else live(definition)


def operator():
    identity = aws('sts', 'get-caller-identity')
    require(identity.get('Account') == base.ACCOUNT and re.fullmatch(
        r'arn:aws:(?:iam|sts)::237343248947:(?:user/[A-Za-z0-9+=,.@_/-]+|assumed-role/[A-Za-z0-9+=,.@_-]+/[A-Za-z0-9+=,.@_-]+)',
        identity.get('Arn', '')), 'Wrong AWS operator')
    return identity['Arn']


def verifier_binding(definition):
    require(re.fullmatch(r'oxy-alia:[1-9][0-9]*', definition), 'Exact Alia API revision required')
    arn = f'arn:aws:ecs:{base.REGION}:{base.ACCOUNT}:task-definition/{definition}'
    services = aws('ecs', 'describe-services', '--cluster', base.CLUSTER, '--services', 'alia')
    require(not services.get('failures') and len(services.get('services', [])) == 1, 'Alia service ambiguous')
    service = services['services'][0]
    require(service['taskDefinition'] == arn and service['pendingCount'] == 0
            and service['runningCount'] == service['desiredCount'] > 0
            and len(service['deployments']) == 1 and service['deployments'][0].get('rolloutState') == 'COMPLETED',
            'Alia verifier service not stable')
    td = aws('ecs', 'describe-task-definition', '--task-definition', arn,
             '--query', 'taskDefinition.{arn:taskDefinitionArn,status:status,taskRoleArn:taskRoleArn}')
    require(td.get('arn') == arn and td.get('status') == 'ACTIVE' and td.get('taskRoleArn') == ROLE,
            'Alia verifier role differs')
    return td


def canary_plan(value, actor, issuing):
    require(isinstance(value, dict) and set(value) == {'kind', 'applicationId', 'ownerAccountId', 'credentialId',
        'nonce', 'issuedAt', 'expiresAt', 'grantId', 'principalId', 'baselineSha256', 'authoritySha256', 'operator'},
        'Unexpected canary plan fields')
    require(value['kind'] == 'alia-credential-revocation-canary-v1' and value['applicationId'] == APP
            and value['ownerAccountId'] == OWNER and value['operator'] == actor, 'Canary identity/operator differs')
    require(re.fullmatch(r'[a-f0-9-]{36}', value['credentialId']) and re.fullmatch('[a-f0-9]{24}', value['nonce'])
            and all(re.fullmatch('[a-f0-9]{64}', value[key]) for key in ('baselineSha256', 'authoritySha256'))
            and all(isinstance(value[key], str) and 0 < len(value[key]) <= 128 for key in ('principalId', 'grantId')),
            'Canary identifiers differ')
    from datetime import datetime
    start = datetime.fromisoformat(value['issuedAt'].replace('Z', '+00:00')).timestamp()
    end = datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00')).timestamp()
    require(start <= time.time() and 0 < end - start <= 3600 and (not issuing or end - time.time() >= 122),
            'Canary lifetime differs')



def verify_prior_execution(evidence, canary, actor, current):
    require(isinstance(evidence, dict) and set(evidence) == {'plan', 'intent'}, 'Prior execution evidence required')
    prior, intent = evidence['plan'], evidence['intent']
    require(prior.get('kind') == 'alia-canary-dispatch-v1' and prior.get('operation') == 'execute'
            and prior.get('operator') == actor and prior.get('canaryPlan') == canary
            and prior.get('sourceSha256') == pins() and prior.get('live') == current
            and re.fullmatch('[a-f0-9]{32}', prior.get('nonce', '')), 'Prior execution plan differs')
    canary_plan(prior['canaryPlan'], actor, False)
    require(set(intent) == {'planSha256', 'taskDefinitionArn', 'startedBy', 'clientToken', 'operation', 'canaryPlan'}
            and intent['planSha256'] == digest(prior) and intent['operation'] == 'execute'
            and intent['canaryPlan'] == canary and intent['clientToken'] == prior['nonce']
            and intent['startedBy'] == 'oxy-i03-' + prior['nonce']
            and re.fullmatch(r'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-i03-alia-revocation-canary:[1-9][0-9]*',
                             intent['taskDefinitionArn']), 'Prior dispatch intent differs')
    definition = aws('ecs', 'describe-task-definition', '--task-definition', intent['taskDefinitionArn'])['taskDefinition']
    require(definition.get('status') in ('ACTIVE', 'INACTIVE'), 'Prior definition status differs')
    verify_definition({**definition, 'status':'ACTIVE'}, build_definition(prior))
    tasks = base.find_dispatched_tasks(intent['taskDefinitionArn'], intent['startedBy'])
    require(len(tasks) == 1, 'Original task absent/ambiguous; reconcile ACK before recovery')
    result = aws('ecs', 'describe-tasks', '--cluster', base.CLUSTER, '--tasks', tasks[0])
    require(not result.get('failures') and len(result.get('tasks', [])) == 1, 'Original task readback incomplete')
    task = result['tasks'][0]
    require(task['taskDefinitionArn'] == intent['taskDefinitionArn'] and task.get('startedBy') == intent['startedBy']
            and task.get('lastStatus') == 'STOPPED' and task.get('desiredStatus') == 'STOPPED'
            and len(task.get('containers', [])) == 1
            and task['containers'][0].get('imageDigest') == current['image'].split('@')[1],
            'Original task not conclusively STOPPED on the exact image')
    return tasks[0]


def invocation(plan):
    # Only executable code and a non-secret prior plan cross the task definition.
    sources = {Path(path).name: (ROOT / path).read_text() for path in HELPERS}
    payload = {key: plan[key] for key in ('nonce', 'operation', 'operator', 'principalId', 'canaryPlan', 'runtimeSha256')}
    encoded = base64.b64encode(json.dumps({'sources': sources, 'payload': payload}, separators=(',', ':')).encode()).decode()
    return r'''import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os'; import {join} from 'node:path';
import {createHash} from 'node:crypto'; import {pathToFileURL} from 'node:url';
const input=JSON.parse(Buffer.from(''' + json.dumps(encoded) + r''','base64').toString('utf8'));
const {payload,sources}=input;let scratch,staged;
const api=process.cwd();const controller=new AbortController();
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>controller.abort());
const bound=setTimeout(()=>process.exit(2),110000);bound.unref();
try {
  for(const [path,expected] of Object.entries(payload.runtimeSha256)) {
    if(createHash('sha256').update(readFileSync(join(api,path))).digest('hex')!==expected)throw new Error('runtime_pin_mismatch');
  }
  scratch=mkdtempSync(join(tmpdir(),'alia-canary-'));
  for(const [name,source] of Object.entries(sources))writeFileSync(join(scratch,name),source,{mode:0o400,flag:'wx'});
  const staging=await import(pathToFileURL(join(scratch,'stage-alia-canary-module.mjs')).href);
  staged=staging.stageAliaCanaryModule({apiPackage:join(api,'package.json'),source:Buffer.from(sources['alia-revocation-canary.cjs'],'utf8')});
  const helper=await import(pathToFileURL(join(scratch,'alia-revocation-canary.mjs')).href);
  if(controller.signal.aborted)throw new Error('interrupted_before_operation');
  const options={apiPackage:join(api,'package.json'),operator:payload.operator,plan:payload.canaryPlan,signal:controller.signal,canaryModulePath:staged.canaryModulePath};
  let result;
  if(payload.operation==='prepare')result=await helper.prepareCanary({...options,principalId:payload.principalId});
  else if(payload.operation==='execute')result=await helper.executeCanary(options);
  else if(payload.operation==='recover')result=await helper.recoverCanary(options);
  else throw new Error('invalid_operation');
  console.log('ALIA_CANARY_RESULT '+JSON.stringify({kind:'alia-canary-transport-v1',nonce:payload.nonce,operation:payload.operation,result}));
  if(payload.operation==='execute'&&!result.success)process.exitCode=1;
  if(payload.operation==='recover'&&!result.cleanupConfirmed)process.exitCode=1;
} catch {console.error('ALIA_CANARY_TASK_FAILED_RECONCILE_DURABLE_INTENT');process.exitCode=1;}
finally {
  clearTimeout(bound);
  try {if(staged)staged.cleanup();}
  catch {console.error('ALIA_CANARY_MODULE_CLEANUP_UNCONFIRMED');process.exitCode=1;}
  finally {if(scratch)rmSync(scratch,{recursive:true,force:true});}
}
'''


def build_definition(plan):
    current = plan['live']
    definition = {'family': 'oxy-i03-alia-revocation-canary', 'executionRoleArn': current['executionRoleArn'],
        'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], 'cpu': current['cpu'],
        'memory': current['memory'], 'runtimePlatform': current['runtimePlatform'], 'volumes': [],
        'containerDefinitions': [{'name': 'canary', 'image': current['image'], 'essential': True,
            'entryPoint': ['/usr/local/bin/node'], 'command': ['--input-type=module', '-e', invocation(plan)],
            'workingDirectory': '/app/packages/api', 'environment': [{'name': 'NODE_ENV', 'value': 'production'},
                {'name': 'OXY_API_URL', 'value': 'https://api.oxy.so'}], 'secrets': [current['databaseSecret']],
            'portMappings': [], 'mountPoints': [], 'volumesFrom': [], 'stopTimeout': 120,
            'logConfiguration': {'logDriver': 'awslogs', 'options': {'awslogs-group': current['logGroup'],
                'awslogs-region': base.REGION, 'awslogs-stream-prefix': current['logStreamPrefix']}}}]}
    if plan['operation'] == 'execute': definition['taskRoleArn'] = ROLE
    return definition


def verify_definition(actual, expected):
    require(actual.get('taskRoleArn') == expected.get('taskRoleArn'), 'Registered task role differs')
    # The common guard forbids task roles. Remove only the exact compared role for
    # that guard; all other authority/executable/sidecar/env checks remain exact.
    checked = copy.deepcopy({key: value for key, value in actual.items() if key != 'taskRoleArn'})
    intended = copy.deepcopy(expected)
    for definition in (checked, intended):
        for container in definition.get('containerDefinitions', []):
            for field in ('environment', 'secrets'):
                rows = container.get(field, [])
                require(all(isinstance(row, dict) and isinstance(row.get('name'), str) for row in rows), 'Malformed named input')
                require(len({row['name'] for row in rows}) == len(rows), 'Duplicate named input')
                container[field] = sorted(rows, key=lambda row: row['name'])
    base.verify_registered(checked, intended)
    require(actual['containerDefinitions'][0].get('stopTimeout') == 120, 'Stop grace differs')


def validate_plan(plan):
    require(set(plan) == {'schemaVersion', 'kind', 'preparedAt', 'nonce', 'operation', 'definition', 'verifierDefinition',
        'sourceHead', 'sourceSha256', 'operator', 'principalId', 'canaryPlan', 'runtimeSha256', 'live',
        'verifierBinding', 'priorExecution', 'taskDefinitionSha256'}, 'Unexpected dispatch plan fields')
    require(plan['schemaVersion'] == 1 and plan['kind'] == 'alia-canary-dispatch-v1'
            and plan['operation'] in ('prepare', 'execute', 'recover')
            and re.fullmatch('[a-f0-9]{32}', plan['nonce']), 'Wrong dispatch protocol')
    require(0 <= time.time() - plan['preparedAt'] <= 1800, 'Dispatch expired')
    require(transport.git_head() == plan['sourceHead'] and pins() == plan['sourceSha256'], 'Source differs')
    require(set(plan['operator']) == {'operatorArn', 'authorizationSha256'}
            and operator() == plan['operator']['operatorArn']
            and re.fullmatch('[a-f0-9]{64}', plan['operator']['authorizationSha256']), 'Operator differs')
    require(set(plan['runtimeSha256']) == set(COMPILED_PATHS)
            and all(re.fullmatch('[a-f0-9]{64}', value) for value in plan['runtimeSha256'].values()), 'Compiled runtime pins differ')
    require(phase_live(plan['operation'], plan['definition']) == plan['live'], 'Live API image/role/network/database differs')
    if plan['operation'] == 'execute':
        require(verifier_binding(plan['verifierDefinition']) == plan['verifierBinding'], 'Verifier role binding differs')
    else: require(plan['verifierDefinition'] is None and plan['verifierBinding'] is None, 'Non-execute gained role binding')
    if plan['operation'] == 'prepare':
        require(plan['canaryPlan'] is None and isinstance(plan['principalId'], str) and 0 < len(plan['principalId']) <= 128,
                'Prepare principal differs')
    else:
        require(plan['principalId'] is None, 'Execute/recover gained principal override')
        canary_plan(plan['canaryPlan'], plan['operator'], plan['operation'] == 'execute')
    if plan['operation'] == 'recover':
        verify_prior_execution(plan['priorExecution'], plan['canaryPlan'], plan['operator'], plan['live'])
    else: require(plan['priorExecution'] is None, 'Unexpected prior execution evidence')
    require(digest(build_definition(plan)) == plan['taskDefinitionSha256'], 'Definition bytes differ')


def verify_measurement(result, plan):
    """Closed metadata schema, including the independently measured expiry margin."""
    import math
    def number(value):
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    def integer(value):
        return type(value) is int and 0 <= value <= 9007199254740991
    def fields(row, names):
        require(isinstance(row, dict) and set(row) == set(names.split()), 'Canary check fields differ')
    checks = result['checks']
    require(isinstance(checks, list) and len(checks) <= 4, 'Canary measurement fields differ')
    order = ['two_independent_receivers', 'expiry_excluded', 'canonical_credential_revocation', 'existing_authority_unchanged']
    kinds = [row.get('kind') if isinstance(row, dict) else None for row in checks]
    require(all(kind in order for kind in kinds) and len(set(kinds)) == len(kinds)
            and kinds == sorted(kinds, key=order.index), 'Canary check kinds/order differ')
    indexed = dict(zip(kinds, checks))
    for kind, row in indexed.items():
        if kind == 'two_independent_receivers':
            fields(row, 'kind coreVersion cachePrewarmed verifierCredentialId verifierSameApplication effectsPerReceiverBefore receiverSamples')
            require(row['coreVersion'] == '4.2.0' and row['cachePrewarmed'] is True
                    and row['verifierSameApplication'] is True and row['effectsPerReceiverBefore'] == 1
                    and isinstance(row['verifierCredentialId'], str)
                    and re.fullmatch(r'wl_[a-f0-9]{24}', row['verifierCredentialId']) is not None
                    and row['verifierCredentialId'] != plan['canaryPlan']['credentialId'], 'Receiver identity differs')
            require(isinstance(row['receiverSamples'], list) and len(row['receiverSamples']) == 2, 'Receiver samples differ')
            for index, sample in enumerate(row['receiverSamples']):
                fields(sample, 'index outcome observedAtMillis')
                require(type(sample['index']) is int and sample['index'] == index and sample['outcome'] == 'ALLOW'
                        and integer(sample['observedAtMillis']), 'Warm sample differs')
        elif kind == 'expiry_excluded':
            fields(row, 'kind credentialExpiresAtMillis bearerExpiresAtMillis marginMs issueRemainingMillis measurementRemainingMillis beforeDatabaseMillis afterDatabaseMillis')
            require(all(integer(value) for key, value in row.items() if key != 'kind')
                    and row['marginMs'] == 2000 and row['issueRemainingMillis'] >= 122000
                    and row['measurementRemainingMillis'] >= 62000
                    and row['beforeDatabaseMillis'] <= row['afterDatabaseMillis']
                    and row['afterDatabaseMillis'] < min(row['credentialExpiresAtMillis'], row['bearerExpiresAtMillis']) - 2000,
                    'Expiry exclusion differs')
        elif kind == 'canonical_credential_revocation':
            fields(row, 'kind commitFromT0Ms receivers')
            require(number(row['commitFromT0Ms']) and row['commitFromT0Ms'] < 5000
                    and isinstance(row['receivers'], list) and len(row['receivers']) == 2, 'Revocation measurement differs')
            for index, sample in enumerate(row['receivers']):
                fields(sample, 'index outcome effectCount status observedAtMillis elapsedFromT0Ms')
                require(type(sample['index']) is int and sample['index'] == index and sample['outcome'] == 'DENY'
                        and type(sample['effectCount']) is int and sample['effectCount'] == 1
                        and type(sample['status']) is int and sample['status'] in (401, 403)
                        and integer(sample['observedAtMillis']) and number(sample['elapsedFromT0Ms'])
                        and row['commitFromT0Ms'] <= sample['elapsedFromT0Ms'] < 5000, 'Denied sample differs')
        else:
            fields(row, 'kind verified')
            require(type(row['verified']) is bool, 'Authority check differs')
    if result['measured']:
        require(all(kind in indexed for kind in order[:3]), 'Measured result is incomplete')
        expiry = indexed['expiry_excluded']; boundary = min(expiry['credentialExpiresAtMillis'], expiry['bearerExpiresAtMillis']) - 2000
        require(expiry['measurementRemainingMillis'] == min(expiry['credentialExpiresAtMillis'], expiry['bearerExpiresAtMillis']) - expiry['beforeDatabaseMillis'], 'Measurement remaining differs')
        from datetime import datetime
        expected = round(datetime.fromisoformat(plan['canaryPlan']['expiresAt'].replace('Z', '+00:00')).timestamp() * 1000)
        require(expiry['credentialExpiresAtMillis'] == expected, 'Credential expiry differs from intent')
        for sample in indexed['two_independent_receivers']['receiverSamples'] + indexed['canonical_credential_revocation']['receivers']:
            require(sample['observedAtMillis'] < boundary, 'Sample reached expiry')
    if result['success']:
        require(result['measured'] is True and result['cleanupConfirmed'] is True and kinds == order
                and indexed['existing_authority_unchanged']['verified'] is True
                and result['primaryFailure'] is None and result['cleanupFailure'] is None, 'Success contract differs')


def collect_result(plan, arn):
    stream = plan['live']['logStreamPrefix'] + '/canary/' + arn.rsplit('/', 1)[1]
    for attempt in range(12):
        rows = []; token = None; size = 0
        try:
            for _ in range(16):
                args = ['logs', 'get-log-events', '--log-group-name', plan['live']['logGroup'],
                        '--log-stream-name', stream, '--start-from-head', '--limit', '1000']
                if token: args += ['--next-token', token]
                page = aws(*args)
                for event in page.get('events', []):
                    message = event.get('message', '')
                    require(isinstance(message, str), 'Malformed task log')
                    size += len(message.encode()); require(size <= 256 * 1024, 'Task log bound exceeded')
                    if message.startswith(PREFIX):
                        row = json.loads(message[len(PREFIX):])
                        require(set(row) == {'kind', 'nonce', 'operation', 'result'} and row['kind'] == 'alia-canary-transport-v1'
                                and row['nonce'] == plan['nonce'] and row['operation'] == plan['operation'], 'Result protocol differs')
                        rows.append(row)
                next_token = page.get('nextForwardToken')
                if not next_token or token == next_token: break
                token = next_token
            else: raise RuntimeError('Task log pagination exceeded')
        except RuntimeError as error:
            if str(error) != 'AWS action/metadata failed; details withheld': raise
        require(len(rows) <= 1, 'Duplicate result acknowledgement')
        if rows:
            result = rows[0]['result']
            require(isinstance(result, dict), 'Malformed canary result')
            if plan['operation'] == 'prepare': canary_plan(result, plan['operator'], True)
            else:
                expected_keys = ({'kind', 'credentialId', 'nonce', 'operatorArn', 'authorizationSha256', 'checks', 'measured',
                    'cleanupConfirmed', 'success', 'primaryFailure', 'cleanupFailure'} if plan['operation'] == 'execute'
                    else {'kind', 'credentialId', 'nonce', 'cleanupConfirmed', 'authorityUnchanged'})
                require(set(result) == expected_keys and type(result['cleanupConfirmed']) is bool, 'Unexpected result fields')
                require(result['kind'] == ('alia-credential-revocation-canary-result-v1' if plan['operation'] == 'execute'
                    else 'alia-credential-revocation-canary-recovery-v1'), 'Result kind differs')
                if plan['operation'] == 'execute':
                    require(result['operatorArn'] == plan['operator']['operatorArn']
                        and result['authorizationSha256'] == plan['operator']['authorizationSha256']
                        and type(result['success']) is bool and type(result['measured']) is bool
                        and isinstance(result['checks'], list), 'Canary measurement fields differ')
                    verify_measurement(result, plan)
                else: require(type(result['authorityUnchanged']) is bool, 'Recovery authority result differs')
                require(result.get('credentialId') == plan['canaryPlan']['credentialId']
                        and result.get('nonce') == plan['canaryPlan']['nonce'], 'Foreign canary result')
            return rows[0]
        if attempt < 11: time.sleep(5)
    raise RuntimeError('Result ACK absent; reconcile intent/task/SQL without redispatch')


def execute(plan, directory):
    global cleanup_running
    cleanup_running = False
    validate_plan(plan)
    directory = outside(directory); directory.mkdir(parents=True, exist_ok=False); os.chmod(directory, 0o700)
    definition = build_definition(plan); private_json(directory / 'definition.json', definition)
    registered = None; launched = []; unknown = False; dispatched = False; credential_cleanup = False; complete = False
    try:
        private_json(directory / 'registration-intent.json', {'planSha256': digest(plan), 'definitionSha256': digest(definition)})
        try:
            registration = aws('ecs', 'register-task-definition', '--cli-input-json', 'file://' + str(directory / 'definition.json'))['taskDefinition']
        except BaseException:
            unknown = True; raise RuntimeError('Registration ACK unknown; inspect intent before retry')
        registered = registration['taskDefinitionArn']; verify_definition(registration, definition)
        verify_definition(aws('ecs', 'describe-task-definition', '--task-definition', registered)['taskDefinition'], definition)
        private_json(directory / 'registered-readback.json', {'taskDefinitionArn': registered, 'definitionSha256': digest(definition)})
        started_by = 'oxy-i03-' + plan['nonce']
        private_json(directory / 'dispatch-intent.json', {'planSha256': digest(plan), 'taskDefinitionArn': registered,
            'startedBy': started_by, 'clientToken': plan['nonce'], 'operation': plan['operation'], 'canaryPlan': plan['canaryPlan']})
        try:
            dispatched = True
            response = aws('ecs', 'run-task', '--cluster', base.CLUSTER, '--launch-type', 'FARGATE', '--task-definition', registered,
                '--network-configuration', json.dumps(plan['live']['network']), '--count', '1', '--started-by', started_by, '--client-token', plan['nonce'])
        except BaseException:
            unknown = True
            for attempt in range(6):
                launched = base.find_dispatched_tasks(registered, started_by)
                if launched: break
                if attempt < 5: time.sleep(5)
            private_json(directory / 'dispatch-unknown.json', {'taskArns': launched, 'noRedispatch': True, 'absenceDoesNotProveNoTask': not bool(launched)})
            raise RuntimeError('RunTask ACK unknown; reconcile task and exact credential before retry')
        launched = [task['taskArn'] for task in response.get('tasks', [])]
        require(not response.get('failures') and len(launched) == 1, 'Dispatch failed/ambiguous')
        private_json(directory / 'launch.json', {'taskArn': launched[0], 'taskDefinitionArn': registered})
        deadline = time.monotonic() + 240
        while True:
            response = aws('ecs', 'describe-tasks', '--cluster', base.CLUSTER, '--tasks', launched[0])
            require(not response.get('failures') and len(response.get('tasks', [])) == 1, 'Task readback incomplete')
            task = response['tasks'][0]
            require(task['taskDefinitionArn'] == registered and task.get('startedBy') == started_by, 'Task provenance differs')
            if task['lastStatus'] == 'STOPPED': break
            require(time.monotonic() < deadline, 'Task exceeded bound'); time.sleep(5)
        require(len(task['containers']) == 1 and task['containers'][0].get('imageDigest') == plan['live']['image'].split('@')[1], 'Image differs')
        result = collect_result(plan, launched[0]); private_json(directory / 'result.private.json', result)
        credential_cleanup = plan['operation'] == 'prepare' or result['result'].get('cleanupConfirmed') is True
        require(task['containers'][0].get('exitCode') == 0, 'Task failed; use prior intent for exact recovery')
        require(credential_cleanup, 'Credential cleanup unconfirmed')
        if plan['operation'] == 'execute': require(result['result'].get('success') is True and result['result'].get('measured') is True, 'Revocation sample not confirmed')
        private_json(directory / 'receipt.json', {'kind': 'alia-canary-dispatch-receipt-v1', 'operation': plan['operation'],
            'planSha256': digest(plan), 'resultSha256': digest(result), 'taskArn': launched[0], 'taskDefinitionArn': registered,
            'image': plan['live']['image'], 'credentialCleanupConfirmed': credential_cleanup})
        complete = True
    finally:
        cleanup_running = True; failures = []
        for arn in launched:
            try:
                response = aws('ecs', 'describe-tasks', '--cluster', base.CLUSTER, '--tasks', arn)
                require(not response.get('failures') and len(response.get('tasks', [])) == 1, 'Cleanup task missing')
                task = response['tasks'][0]
                if task['lastStatus'] != 'STOPPED':
                    aws('ecs', 'stop-task', '--cluster', base.CLUSTER, '--task', arn, '--reason', 'Own I03 canary cleanup; no redispatch')
                    deadline = time.monotonic() + 150
                    while time.monotonic() < deadline:
                        task = aws('ecs', 'describe-tasks', '--cluster', base.CLUSTER, '--tasks', arn)['tasks'][0]
                        if task['lastStatus'] == 'STOPPED': break
                        time.sleep(5)
                require(task['lastStatus'] == 'STOPPED', 'Task cleanup unconfirmed')
            except Exception: failures.append('task_cleanup_unconfirmed')
        if registered:
            try:
                aws('ecs', 'deregister-task-definition', '--task-definition', registered)
                require(aws('ecs', 'describe-task-definition', '--task-definition', registered, '--query', 'taskDefinition.status') == 'INACTIVE', 'Definition cleanup unconfirmed')
            except Exception: failures.append('definition_cleanup_unconfirmed')
        if unknown: failures.append('ack_unknown_requires_reconciliation')
        if dispatched and plan['operation'] in ('execute', 'recover') and not credential_cleanup:
            failures.append('credential_retirement_unconfirmed_requires_exact_recovery')
        private_json(directory / 'cleanup.json', {'taskArns': launched, 'definitionArn': registered, 'failures': failures,
            'credentialCleanupConfirmed': credential_cleanup, 'operationComplete': complete, 'operatorInterrupted': interrupted,
            'noAutomaticRetry': True, 'requiresIntentReconciliation': unknown or (dispatched and not complete)})
        require(not failures, 'Cleanup incomplete; review durable intent')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True); parser.add_argument('--execute', action='store_true'); parser.add_argument('--output')
    parser.add_argument('--operation', choices=('prepare', 'execute', 'recover'), default='prepare')
    parser.add_argument('--definition'); parser.add_argument('--verifier-definition'); parser.add_argument('--runtime-pins')
    parser.add_argument('--prior-plan'); parser.add_argument('--prior-intent')
    parser.add_argument('--authorization-sha256'); parser.add_argument('--principal-id'); parser.add_argument('--canary-plan')
    args = parser.parse_args(); outside(args.plan)
    if args.execute:
        require(args.output and not any((args.definition, args.verifier_definition, args.runtime_pins, args.authorization_sha256,
            args.principal_id, args.canary_plan, args.prior_plan, args.prior_intent)), 'Dispatch accepts only exact reviewed plan/output')
        execute(json.loads(Path(args.plan).read_text()), args.output); return
    require(args.definition and args.runtime_pins and args.authorization_sha256 and not args.output, 'Plan needs reviewed final definition/runtime pins/authorization digest')
    require(re.fullmatch('[a-f0-9]{64}', args.authorization_sha256), 'Authorization digest malformed')
    runtime = json.loads(Path(args.runtime_pins).read_text())
    require(set(runtime) == set(COMPILED_PATHS) and all(re.fullmatch('[a-f0-9]{64}', value) for value in runtime.values()), 'Runtime pins must be the closed compiled set')
    actor = {'operatorArn': operator(), 'authorizationSha256': args.authorization_sha256}
    if args.operation == 'prepare':
        require(args.principal_id and not args.canary_plan and not args.verifier_definition, 'Prepare accepts one existing principal only')
        prior = None
    else:
        require(args.canary_plan and not args.principal_id, 'Execute/recover needs exact prior plan')
        prior = json.loads(Path(args.canary_plan).read_text()); canary_plan(prior, actor, args.operation == 'execute')
    if args.operation == 'execute': require(args.verifier_definition, 'Execute needs exact Alia verifier role binding')
    else: require(args.verifier_definition is None, 'Prepare/recovery must have no task role')
    if args.operation == 'recover':
        require(args.prior_plan and args.prior_intent, 'Recovery requires the durable original plan and dispatch intent')
        evidence = {'plan': json.loads(outside(args.prior_plan).read_text()),
                    'intent': json.loads(outside(args.prior_intent).read_text())}
    else:
        require(not args.prior_plan and not args.prior_intent, 'Unexpected prior execution evidence'); evidence = None
    plan = {'schemaVersion': 1, 'kind': 'alia-canary-dispatch-v1', 'preparedAt': int(time.time()), 'nonce': secrets.token_hex(16),
        'operation': args.operation, 'definition': args.definition, 'verifierDefinition': args.verifier_definition,
        'sourceHead': transport.git_head(), 'sourceSha256': pins(), 'operator': actor, 'principalId': args.principal_id,
        'canaryPlan': prior, 'runtimeSha256': runtime, 'live': phase_live(args.operation, args.definition),
        'verifierBinding': verifier_binding(args.verifier_definition) if args.operation == 'execute' else None,
        'priorExecution': evidence}
    if args.operation == 'recover': verify_prior_execution(evidence, prior, actor, plan['live'])
    plan['taskDefinitionSha256'] = digest(build_definition(plan)); private_json(args.plan, plan)
    print(json.dumps({'prepared': True, 'operation': args.operation, 'planSha256': digest(plan), 'image': plan['live']['image']}))


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, handle_signal); signal.signal(signal.SIGINT, handle_signal)
    try: main()
    except Exception:
        print('ALIA_CANARY_TRANSPORT_FAILED_REVIEW_PRIVATE_INTENT', file=sys.stderr); raise SystemExit(1)
