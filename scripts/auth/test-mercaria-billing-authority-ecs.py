#!/usr/bin/env python3
"""Offline fixtures: no AWS calls, credentials, or provider effects."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ephemeral', Path(__file__).with_name('mercaria-billing-authority-ecs.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Fixtures(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.directory = Path(self.temp.name); os.chmod(self.directory, 0o700)
        identity = {'Account': m.ACCOUNT, 'Arn': 'arn:aws:iam::237343248947:user/synthetic-operator', 'UserId': 'synthetic'}
        self.plan = {'operator': identity, 'request': {'schemaVersion': 1, 'mode': 'prepare', 'nonce': 'a'*32,
            'operator': {'account': m.ACCOUNT, 'arn': identity['Arn'], 'receiptSha256': m.digest(identity)}}, 'live': {
            'image': '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:'+'b'*64,
            'executionRoleArn': 'arn:aws:iam::237343248947:role/oxy-ecs-execution', 'cpu': '1024', 'memory': '3072',
            'runtimePlatform': {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'},
            'databaseSecret': {'name': 'DATABASE_URL', 'valueFrom': 'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL'},
            'logGroup': '/oxy/ecs', 'logStreamPrefix': 'oxy-api', 'network': {'awsvpcConfiguration': {'assignPublicIp': 'DISABLED'}}},
            'definition': 'oxy-oxy-api:999', 'preparedAt': int(time.time()), 'launcherSha256': hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest(),
            'transportSha256': hashlib.sha256(m.BASE.read_bytes()).hexdigest(), 'runnerSha256': hashlib.sha256(m.RUNNER.read_bytes()).hexdigest()}
        self.plan['taskDefinitionSha256'] = m.digest(m.build_definition(self.plan))
    def tearDown(self): self.temp.cleanup()
    def test_definition_is_database_only_without_aws_or_plaintext(self):
        d=m.build_definition(self.plan); c=d['containerDefinitions'][0]
        self.assertNotIn('taskRoleArn', d); self.assertEqual(c['secrets'], [self.plan['live']['databaseSecret']])
        self.assertEqual(c['entryPoint'], ['/usr/local/bin/node'])
        self.assertEqual(c['command'][:2], ['--input-type=module', '--eval'])
        self.assertEqual(c['command'][2], m.RUNNER.read_text())
        self.assertEqual(c['command'][3:5], ['--', '--execute'])
        self.assertEqual(hashlib.sha256(c['command'][-2].encode()).hexdigest(), c['command'][-1])
        self.assertEqual(c['environment'], [{'name':'LOG_LEVEL','value':'silent'}])
        self.assertNotIn('secretHash', c['command'][1])
    def test_no_overwrite_or_symlink_read(self):
        file=self.directory/'original'; m.private_write(file,{'private':True})
        with self.assertRaises(FileExistsError):m.private_write(file,{'private':False})
        alias=self.directory/'alias';alias.symlink_to(file)
        with self.assertRaises(OSError):m.private_read(alias)
    def test_extra_payload_or_foreign_owner_rejected(self):
        p=copy.deepcopy(self.plan); p['request']['secretHash']='must-not-travel'
        with self.assertRaises(RuntimeError): m.build_definition(p)
        p=copy.deepcopy(self.plan);p['request'].update(mode='apply',input=self.result()['result'])
        p['request']['input']['target']={}
        with self.assertRaises(RuntimeError):m.build_definition(p)
    def test_source_changed_no_aws(self):
        self.plan['launcherSha256']='0'*64
        with patch.object(m,'aws',side_effect=AssertionError('AWS forbidden')):
            with self.assertRaises(RuntimeError):m.execute(self.plan,self.directory/'execute')
    def test_operator_changed_no_ecs(self):
        with patch.object(m,'aws',return_value={'Account':m.ACCOUNT,'Arn':'other','UserId':'other'}) as aws:
            with self.assertRaises(RuntimeError):m.execute(self.plan,self.directory/'execute')
            self.assertEqual(aws.call_count,1)
    def result(self):
        return {'schemaVersion':1,'nonce':'a'*32,'mode':'prepare','operatorReceiptSha256':self.plan['request']['operator']['receiptSha256'],
                'result':{'kind':'mercaria-billing-authority-v1','target':m.TARGET,'before':{'application':{'scopes':['user:read'],'version':'1','updatedAt':'2026-10-03'},'credential':{'scopes':['user:read'],'version':'2','updatedAt':'2026-10-03'}}}}
    def test_receipt_missing_duplicate_foreign_or_material_rejected(self):
        result=self.result();event={'message':'OXY_BILLING_AUTHORITY_RESULT '+json.dumps(result)}
        self.assertEqual(m.decode([event],self.plan['request']),result)
        for events in [[],[event,event],[{'message':'raw error'}]]:
            with self.assertRaises(RuntimeError):m.decode(events,self.plan['request'])
        for change in [{'nonce':'f'*32},{'mode':'issue'},{'operatorReceiptSha256':'f'*64}]:
            with self.assertRaises(RuntimeError):m.decode([{'message':'OXY_BILLING_AUTHORITY_RESULT '+json.dumps(result|change)}],self.plan['request'])
        result['result']['secret']='synthetic'
        with self.assertRaises(RuntimeError):m.decode([{'message':'OXY_BILLING_AUTHORITY_RESULT '+json.dumps(result)}],self.plan['request'])
    def test_registration_failure_still_reserves_recovery_and_never_runs(self):
        calls=[]
        def aws(*args): calls.append(args); raise RuntimeError('synthetic registration failure')
        with patch.object(m,'operator',return_value=self.plan['operator']),patch.object(m.transport,'describe',return_value=self.plan['live']),patch.object(m,'aws',side_effect=aws):
            with self.assertRaises(RuntimeError):m.execute(self.plan,self.directory/'execute')
        self.assertTrue((self.directory/'execute/attempt.json').exists());self.assertTrue((self.directory/'execute/result.private.json').exists())
        self.assertEqual([x[1] for x in calls],['register-task-definition'])
        self.assertEqual(json.loads((self.directory/'execute/cleanup.json').read_text())['failures'],[])

    def lifecycle(self, cleanup_failure=False):
        definition=m.build_definition(self.plan)
        registered=definition|{'taskDefinitionArn':'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-mercaria-billing-authority:1','status':'ACTIVE'}
        task_arn='arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/synthetic'
        calls=[]; describes=0
        def aws(*args):
            nonlocal describes
            calls.append(args); action=args[1]
            if action=='register-task-definition':return {'taskDefinition':registered}
            if action=='describe-task-definition':return 'INACTIVE' if '--query' in args else {'taskDefinition':registered}
            if action=='run-task':return {'tasks':[{'taskArn':task_arn}]}
            if action=='describe-tasks':
                describes+=1
                return {'tasks':[{'taskDefinitionArn':registered['taskDefinitionArn'],'lastStatus':'RUNNING' if cleanup_failure and describes>1 else 'STOPPED',
                    'containers':[{'exitCode':0,'imageDigest':'sha256:'+'b'*64}]}]}
            if action=='stop-task':raise RuntimeError('synthetic stop failure')
            if action=='deregister-task-definition':return {}
            raise AssertionError(action)
        with patch.object(m,'operator',return_value=self.plan['operator']),patch.object(m.transport,'describe',return_value=self.plan['live']),patch.object(m,'aws',side_effect=aws),patch.object(m,'collect',side_effect=RuntimeError('lost receipt')):
            with self.assertRaises(RuntimeError):m.execute(self.plan,self.directory/'execute')
        return calls,json.loads((self.directory/'execute/cleanup.json').read_text())
    def test_lost_receipt_has_one_dispatch_and_preserves_reconciliation_ids(self):
        calls,cleanup=self.lifecycle()
        self.assertEqual(sum(x[1]=='run-task' for x in calls),1)
        self.assertTrue(cleanup['taskStopped']);self.assertTrue(cleanup['definitionInactive'])
        self.assertTrue((self.directory/'execute/registered.json').exists())
        self.assertTrue((self.directory/'execute/launch.json').exists())
        self.assertEqual((self.directory/'execute/result.private.json').read_bytes(),b'')
        with self.assertRaises(FileExistsError): (self.directory/'execute').mkdir()
    def test_failed_stop_does_not_skip_definition_cleanup(self):
        calls,cleanup=self.lifecycle(True)
        self.assertIn('task_cleanup_failed',cleanup['failures'])
        self.assertTrue(cleanup['definitionInactive'])
        self.assertEqual(sum(x[1]=='deregister-task-definition' for x in calls),1)

    def test_runner_drift_and_stale_plan_fail_before_aws(self):
        for change in [{'runnerSha256':'0'*64}, {'preparedAt':int(time.time())-1801}]:
            plan=copy.deepcopy(self.plan);plan.update(change)
            with patch.object(m,'aws',side_effect=AssertionError('AWS forbidden')):
                with self.assertRaises(RuntimeError):m.execute(plan,self.directory/'execute')

    def test_apply_and_rollback_definitions_preserve_exact_input(self):
        plan=copy.deepcopy(self.plan);prior=self.result()['result']
        plan['request'].update(mode='apply',input=prior)
        command=m.build_definition(plan)['containerDefinitions'][0]['command']
        self.assertEqual(json.loads(command[-2])['input'],prior)
        receipt=prior|{'operation':'apply','actor':plan['operator']['Arn'],'after':prior['before']}
        plan['request'].update(mode='rollback',input=receipt)
        self.assertEqual(json.loads(m.build_definition(plan)['containerDefinitions'][0]['command'][-2])['input'],receipt)
        plan['request']['input']['secretHash']='must-not-travel'
        with self.assertRaises(RuntimeError):m.build_definition(plan)

    def test_configuration_drift_refuses_before_task_registration(self):
        with patch.object(m,'operator',return_value=self.plan['operator']),patch.object(m.transport,'describe',return_value={}),patch.object(m,'aws',side_effect=AssertionError('No ECS writes')):
            with self.assertRaises(RuntimeError):m.execute(self.plan,self.directory/'execute')

if __name__=='__main__':unittest.main()
