#!/usr/bin/env python3
"""Offline protocol fixtures: AWS facts mocked, no AWS or provider operations."""
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('canary_transport_fixture', ROOT/'scripts/agency/alia-revocation-canary-ecs.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ACTOR = {'operatorArn': 'arn:aws:sts::237343248947:assumed-role/Fixture/operator', 'authorizationSha256': 'a'*64}
LIVE = {'image': '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/api@sha256:'+'1'*64,
    'executionRoleArn': 'arn:aws:iam::237343248947:role/oxy-oxy-execution', 'cpu': '1024', 'memory': '2048',
    'runtimePlatform': {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'},
    'network': {'awsvpcConfiguration': {'assignPublicIp': 'DISABLED', 'subnets': ['fixture'], 'securityGroups': ['fixture']}},
    'databaseSecret': {'name': 'DATABASE_URL', 'valueFrom': 'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL'},
    'logGroup': '/oxy/ecs', 'logStreamPrefix': 'oxy-api'}
VERIFIER = {'arn': 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-alia:448', 'status': 'ACTIVE', 'taskRoleArn': m.ROLE}


def prior():
    now = datetime.now(timezone.utc)
    return {'kind': 'alia-credential-revocation-canary-v1', 'applicationId': m.APP, 'ownerAccountId': m.OWNER,
        'credentialId': 'aaaaaaaa-1111-4111-8111-111111111111', 'nonce': 'b'*24,
        'issuedAt': now.isoformat(), 'expiresAt': (now+timedelta(minutes=59)).isoformat(),
        'grantId': 'synthetic-grant', 'principalId': 'synthetic-principal', 'baselineSha256': 'c'*64,
        'authoritySha256': 'd'*64, 'operator': ACTOR}


def plan(operation='execute'):
    value = {'schemaVersion': 1, 'kind': 'alia-canary-dispatch-v1', 'preparedAt': int(time.time()), 'nonce': 'e'*32,
        'operation': operation, 'definition': 'oxy-oxy-api:1', 'verifierDefinition': 'oxy-alia:448' if operation == 'execute' else None,
        'sourceHead': 'f'*40, 'sourceSha256': m.pins(), 'operator': ACTOR,
        'principalId': 'synthetic-principal' if operation == 'prepare' else None,
        'canaryPlan': None if operation == 'prepare' else prior(),
        'runtimeSha256': {path: '1'*64 for path in m.COMPILED_PATHS}, 'live': LIVE,
        'verifierBinding': VERIFIER if operation == 'execute' else None, 'priorExecution': {} if operation == 'recover' else None}
    value['taskDefinitionSha256'] = m.digest(m.build_definition(value)); return value


def registration(expected):
    actual = copy.deepcopy(expected)
    actual.update({'taskDefinitionArn': 'arn:aws:ecs:us-west-2:237343248947:task-definition/'+expected['family']+':1', 'status': 'ACTIVE'})
    return actual


class Protocol(unittest.TestCase):
    def valid(self, value):
        with patch.object(m.transport, 'git_head', return_value='f'*40), patch.object(m, 'operator', return_value=ACTOR['operatorArn']), \
             patch.object(m, 'phase_live', return_value=LIVE), patch.object(m, 'verifier_binding', return_value=VERIFIER), patch.object(m, 'verify_prior_execution'):
            m.validate_plan(value)

    def test_three_phase_inputs_and_roles(self):
        for phase in ('prepare', 'execute', 'recover'):
            p = plan(phase); self.valid(p); definition = m.build_definition(p)
            self.assertEqual(definition.get('taskRoleArn'), m.ROLE if phase == 'execute' else None)
            self.assertEqual(definition['containerDefinitions'][0]['secrets'], [LIVE['databaseSecret']])
            self.assertEqual([e['name'] for e in definition['containerDefinitions'][0]['environment']], ['NODE_ENV', 'OXY_API_URL'])
            m.verify_definition(registration(definition), definition)

    def test_registered_wrong_role_sidecar_secret_command(self):
        expected = m.build_definition(plan())
        for change in ('role', 'sidecar', 'secret', 'command', 'stop'):
            bad = registration(expected)
            if change == 'role': bad['taskRoleArn'] = 'arn:aws:iam::237343248947:role/Wrong'
            if change == 'sidecar': bad['containerDefinitions'].append(copy.deepcopy(bad['containerDefinitions'][0]))
            if change == 'secret': bad['containerDefinitions'][0]['secrets'].append({'name': 'TOKEN', 'valueFrom': 'wrong'})
            if change == 'command': bad['containerDefinitions'][0]['command'].append('unsafe')
            if change == 'stop': bad['containerDefinitions'][0]['stopTimeout'] = 30
            with self.assertRaises(RuntimeError): m.verify_definition(bad, expected)


    def test_registered_reordered_environment_exact_values_and_no_duplicates(self):
        expected = m.build_definition(plan()); actual = registration(expected)
        actual['containerDefinitions'][0]['environment'].reverse()
        m.verify_definition(actual, expected)
        actual['containerDefinitions'][0]['environment'][0]['value'] = 'wrong'
        with self.assertRaises(RuntimeError): m.verify_definition(actual, expected)
        actual = registration(expected); actual['containerDefinitions'][0]['environment'].append(
            copy.deepcopy(actual['containerDefinitions'][0]['environment'][0]))
        with self.assertRaises(RuntimeError): m.verify_definition(actual, expected)


    def test_real_alia_service_family_role_metadata_shape(self):
        service = {'taskDefinition':VERIFIER['arn'],'pendingCount':0,'runningCount':2,'desiredCount':2,
            'deployments':[{'rolloutState':'COMPLETED'}]}
        with patch.object(m, 'aws', side_effect=[{'services':[service]}, VERIFIER]) as calls:
            self.assertEqual(m.verifier_binding('oxy-alia:448'), VERIFIER)
            self.assertEqual(calls.call_args_list[0].args[-2:], ('--services','alia'))
        with patch.object(m, 'aws', side_effect=[{'services':[service]}, {**VERIFIER,'taskRoleArn':'wrong'}]):
            with self.assertRaises(RuntimeError): m.verifier_binding('oxy-alia:448')
        with self.assertRaises(RuntimeError): m.verifier_binding('oxy-alia-api:448')

    def test_source_runtime_operator_and_definition_changes(self):
        for key, value in [('sourceHead', '0'*40), ('sourceSha256', {}), ('runtimeSha256', {}),
                           ('operator', {'operatorArn': ACTOR['operatorArn'], 'authorizationSha256': 'invalid'}),
                           ('taskDefinitionSha256', '0'*64), ('unexpected', True)]:
            p = plan(); p[key] = value
            with self.assertRaises(RuntimeError): self.valid(p)

    def test_non_execute_has_no_authority_role(self):
        for phase in ('prepare', 'recover'):
            p = plan(phase); p['verifierBinding'] = VERIFIER
            with self.assertRaises(RuntimeError): self.valid(p)

    def test_expired_canary_recovery_allowed_not_issue(self):
        p = prior(); now = datetime.now(timezone.utc)
        p['issuedAt'] = (now-timedelta(hours=2)).isoformat()
        p['expiresAt'] = (now-timedelta(hours=2)+timedelta(minutes=59)).isoformat()
        m.canary_plan(p, ACTOR, False)
        with self.assertRaises(RuntimeError): m.canary_plan(p, ACTOR, True)

    def test_near_expiry_rejected_before_dispatch_recovery_preserved(self):
        p = prior(); now = datetime.now(timezone.utc)
        p['issuedAt'] = (now-timedelta(minutes=10)).isoformat()
        p['expiresAt'] = (now+timedelta(seconds=30)).isoformat()
        with self.assertRaises(RuntimeError): m.canary_plan(p, ACTOR, True)
        m.canary_plan(p, ACTOR, False)
        p['expiresAt'] = (now+timedelta(minutes=3)).isoformat()
        m.canary_plan(p, ACTOR, True)

    def test_wrong_canary_actor_and_namespace(self):
        for field, value in [('applicationId', 'wrong'), ('ownerAccountId', 'wrong'), ('operator', {**ACTOR, 'authorizationSha256': 'e'*64})]:
            p = prior(); p[field] = value
            with self.assertRaises(RuntimeError): m.canary_plan(p, ACTOR, False)

    def test_cloudwatch_lag_reads_only_and_duplicate_reject(self):
        p = plan('prepare'); row = {'kind': 'alia-canary-transport-v1', 'nonce': p['nonce'], 'operation': 'prepare', 'result': prior()}
        event = {'message': m.PREFIX+json.dumps(row)}
        with patch.object(m, 'aws', side_effect=[{'events': []}, {'events': [event]}]) as calls, patch.object(m.time, 'sleep'):
            self.assertEqual(m.collect_result(p, 'task/own'), row)
            self.assertTrue(all(c.args[:2] == ('logs', 'get-log-events') for c in calls.call_args_list))
        with patch.object(m, 'aws', return_value={'events': [event, event]}):
            with self.assertRaises(RuntimeError): m.collect_result(p, 'task/own')

    def test_cloudwatch_foreign_ack_reject(self):
        p = plan('prepare'); event = {'message': m.PREFIX+json.dumps({'kind': 'alia-canary-transport-v1', 'nonce': '0'*32, 'operation': 'prepare', 'result': prior()})}
        with patch.object(m, 'aws', return_value={'events': [event]}):
            with self.assertRaises(RuntimeError): m.collect_result(p, 'task/own')

    def test_dispatch_intent_durable_before_unknown_ack_no_retry(self):
        p = plan(); expected = m.build_definition(p); registered = registration(expected); seen = []; directory = None
        def mocked(*args):
            seen.append(args)
            if args[:2] == ('ecs', 'register-task-definition'): return {'taskDefinition': registered}
            if args[:2] == ('ecs', 'describe-task-definition'):
                return 'INACTIVE' if '--query' in args else {'taskDefinition': registered}
            if args[:2] == ('ecs', 'run-task'):
                self.assertTrue((directory/'dispatch-intent.json').exists())
                intent = json.loads((directory/'dispatch-intent.json').read_text())
                self.assertEqual(intent['canaryPlan'], p['canaryPlan'])
                self.assertIn('--client-token', args); self.assertEqual(args[args.index('--client-token')+1], p['nonce'])
                raise RuntimeError('lost_ack')
            if args[:2] == ('ecs', 'deregister-task-definition'): return {}
            raise AssertionError(args[:2])
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)/'own-run'
            with patch.object(m, 'validate_plan'), patch.object(m, 'aws', side_effect=mocked), \
                 patch.object(m.base, 'find_dispatched_tasks', return_value=[]), patch.object(m.time, 'sleep'):
                with self.assertRaises(RuntimeError): m.execute(p, directory)
            cleanup = json.loads((directory/'cleanup.json').read_text())
            self.assertFalse(cleanup['credentialCleanupConfirmed'])
            self.assertTrue(cleanup['requiresIntentReconciliation'])
            self.assertIn('credential_retirement_unconfirmed_requires_exact_recovery', cleanup['failures'])
            self.assertEqual(sum(args[:2] == ('ecs', 'run-task') for args in seen), 1)

    def test_generated_entrypoint_parse_and_no_raw_secret_in_definition(self):
        p = plan(); code = m.invocation(p)
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch)/'task.mjs'; path.write_text(code)
            subprocess.run(['node', '--check', str(path)], check=True, capture_output=True)
        serialized = json.dumps(m.build_definition(p))
        self.assertNotIn('apiSecret', serialized)
        self.assertNotIn('secretHash', serialized)
        self.assertNotIn('publicKey', serialized)
        self.assertNotIn('AWS_ACCESS_KEY_ID', serialized)


    def test_recovery_at_quiesced_zero_keeps_exact_definition_and_namespace(self):
        td = {'arn': 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:1', 'status': 'ACTIVE',
            'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], **{key:LIVE[key] for key in
                ('executionRoleArn', 'cpu', 'memory', 'runtimePlatform')}, 'containers': [{'name':'oxy-api',
                'image':LIVE['image'], 'secrets':[LIVE['databaseSecret']], 'environmentNames':[],
                'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-group':'/oxy/ecs',
                    'awslogs-region':'us-west-2','awslogs-stream-prefix':'oxy-api'}}}]}
        service = {'taskDefinition':td['arn'],'pendingCount':0,'runningCount':0,'desiredCount':0,
            'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED','desiredCount':0,'runningCount':0,'pendingCount':0}],'networkConfiguration':LIVE['network']}
        with patch.object(m, 'aws', side_effect=[{'services':[service]}, td]):
            self.assertEqual(m.recovery_live('oxy-oxy-api:1'), {**LIVE, 'taskDefinition':td['arn'], 'stripeBindingPresent':False})
        service['deployments']=[{'status':'PRIMARY','rolloutState':'FAILED','desiredCount':0,'runningCount':0,'pendingCount':0},
            {'status':'ACTIVE','rolloutState':'IN_PROGRESS','desiredCount':0,'runningCount':0,'pendingCount':0}]
        with patch.object(m, 'aws', side_effect=[{'services':[service]}, td]):
            self.assertEqual(m.recovery_live('oxy-oxy-api:1')['image'], LIVE['image'])
        service['deployments'][1]['runningCount']=1
        with patch.object(m, 'aws', return_value={'services':[service]}):
            with self.assertRaises(RuntimeError):m.recovery_live('oxy-oxy-api:1')
        service['deployments'][1]['runningCount']=0
        service['desiredCount']=service['runningCount']=1
        with patch.object(m, 'aws', return_value={'services':[service]}):
            with self.assertRaises(RuntimeError):m.recovery_live('oxy-oxy-api:1')
        service['desiredCount']=service['runningCount']=0
        service['taskDefinition']='wrong'
        with patch.object(m, 'aws', return_value={'services':[service]}):
            with self.assertRaises(RuntimeError): m.recovery_live('oxy-oxy-api:1')


    def test_recovery_requires_unique_stopped_original_task_and_exact_intent(self):
        p = plan(); definition = registration(m.build_definition(p))
        intent = {'planSha256':m.digest(p),'taskDefinitionArn':definition['taskDefinitionArn'],
            'startedBy':'oxy-i03-'+p['nonce'],'clientToken':p['nonce'],'operation':'execute','canaryPlan':p['canaryPlan']}
        evidence = {'plan':p,'intent':intent}
        task = {'taskDefinitionArn':intent['taskDefinitionArn'],'startedBy':intent['startedBy'],'lastStatus':'STOPPED',
            'desiredStatus':'STOPPED','containers':[{'imageDigest':LIVE['image'].split('@')[1]}]}
        for matches in ([], ['task/one','task/two']):
            with patch.object(m, 'aws', return_value={'taskDefinition':definition}), patch.object(m.base, 'find_dispatched_tasks', return_value=matches):
                with self.assertRaises(RuntimeError):m.verify_prior_execution(evidence,p['canaryPlan'],ACTOR,LIVE)
        for state in ('RUNNING','STOPPED'):
            actual = {**task,'lastStatus':state}
            with patch.object(m, 'aws', side_effect=[{'taskDefinition':definition},{'tasks':[actual]}]), \
                 patch.object(m.base, 'find_dispatched_tasks', return_value=['task/one']):
                if state=='RUNNING':
                    with self.assertRaises(RuntimeError):m.verify_prior_execution(evidence,p['canaryPlan'],ACTOR,LIVE)
                else:self.assertEqual(m.verify_prior_execution(evidence,p['canaryPlan'],ACTOR,LIVE),'task/one')
        evidence['intent']={**intent,'clientToken':'0'*32}
        with self.assertRaises(RuntimeError):m.verify_prior_execution(evidence,p['canaryPlan'],ACTOR,LIVE)

    def test_help_default_only_no_aws(self):
        result = subprocess.run([sys.executable, '-B', str(ROOT/'scripts/agency/alia-revocation-canary-ecs.py'), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0); self.assertIn('--execute', result.stdout)


if __name__ == '__main__': unittest.main()
