#!/usr/bin/env python3
"""Offline AWS fixtures only. Never authenticates or dispatches a task."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('commercial-inventory-ecs.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class InventoryFixtures(unittest.TestCase):
    def setUp(self):
        self.plan = {'profile': 'oxy', 'nonce': 'a'*32, 'readerSha256': hashlib.sha256(module.READER.read_bytes()).hexdigest(), 'live': {
            'image': '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:'+'b'*64,
            'executionRoleArn': 'arn:aws:iam::237343248947:role/oxy-ecs-execution', 'cpu': '1024', 'memory': '3072',
            'runtimePlatform': {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'},
            'databaseSecret': {'name': 'DATABASE_URL', 'valueFrom': 'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL'}, 'logGroup': '/oxy/ecs', 'logStreamPrefix': 'clarity-api'}}
        self.definition = module.build_definition(self.plan)
        self.registered = copy.deepcopy(self.definition)
        self.registered.update({'taskDefinitionArn': 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-billing-inventory-oxy:1', 'status': 'ACTIVE', 'taskRoleArn': '', 'placementConstraints': []})
        self.registered['containerDefinitions'][0]['cpu'] = 0
    def test_actual_receiver_definition_is_minimal(self):
        module.verify_registered(self.registered, self.definition)
        container = self.definition['containerDefinitions'][0]
        self.assertEqual(container['entryPoint'], ['/usr/local/bin/node'])
        self.assertEqual(container['workingDirectory'], '/app/packages/api')
        self.assertEqual(container['environment'], [])
        self.assertEqual(container['secrets'], [self.plan['live']['databaseSecret']])
        self.assertEqual(container['logConfiguration']['options']['awslogs-stream-prefix'], 'clarity-api')
        self.assertNotIn('taskRoleArn', self.definition)
        self.assertNotIn('STRIPE_SECRET_KEY', json.dumps(self.definition))
    def test_authority_and_execution_deltas_reject(self):
        variations = [lambda d: d.update(taskRoleArn='arn:aws:iam::237343248947:role/extra'),
            lambda d: d['containerDefinitions'].append(copy.deepcopy(d['containerDefinitions'][0])),
            lambda d: d['containerDefinitions'][0].update(command=['arbitrary']),
            lambda d: d['containerDefinitions'][0].update(image='different'),
            lambda d: d['containerDefinitions'][0].update(entryPoint=['/bin/sh']),
            lambda d: d['containerDefinitions'][0].update(environment=[{'name':'TOKEN','value':'synthetic'}]),
            lambda d: d['containerDefinitions'][0].update(secrets=[{'name':'TOKEN','valueFrom':'synthetic'}]),
            lambda d: d['containerDefinitions'][0].update(portMappings=[{'containerPort':3000}]),
            lambda d: d['containerDefinitions'][0].update(environmentFiles=[{'value':'synthetic','type':'s3'}]),
            lambda d: d['containerDefinitions'][0].update(healthCheck={'command':['side-effect']}),
            lambda d: d['containerDefinitions'][0]['logConfiguration']['options'].update({'awslogs-stream-prefix':'unapproved'})]
        for mutate in variations:
            altered = copy.deepcopy(self.registered); mutate(altered)
            with self.assertRaises(RuntimeError): module.verify_registered(altered, self.definition)
    def test_cohort_profiles_preserve_exact_deployment_and_only_database_authority(self):
        for profile, expected in [('mercaria-cohort', 'oxy-mercaria:59'), ('peable-cohort', 'oxy-peable:7')]:
            self.assertEqual(module.PROFILES[profile]['definition'], expected)
            self.plan['profile'] = profile
            definition = module.build_definition(self.plan)
            self.assertEqual(definition['family'], 'oxy-billing-inventory-'+profile)
            self.assertEqual(definition['containerDefinitions'][0]['entryPoint'], ['/usr/local/bin/bun' if profile == 'peable-cohort' else '/usr/local/bin/node'])
            self.assertEqual(definition['containerDefinitions'][0]['command'][0], '-e' if profile == 'peable-cohort' else '--input-type=module')
            self.assertEqual(definition['containerDefinitions'][0]['workingDirectory'], '/app/packages/backend')
            self.assertNotIn('taskRoleArn', definition)
            self.assertEqual(len(definition['containerDefinitions'][0]['secrets']), 1)
    def test_reader_changed_rejects_before_definition(self):
        self.plan['readerSha256']='0'*64
        with self.assertRaisesRegex(RuntimeError,'Reader source'): module.build_definition(self.plan)
    def packet(self):
        raw=json.dumps({'profile':'oxy','readOnly':True,'isolation':'repeatable read','tables':{}}).encode()
        return {'nonce':'a'*32,'seq':0,'total':1,'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()}
    def test_result_roundtrip(self):
        self.assertTrue(module.decode([{'message':'OXY_BILLING_INVENTORY '+json.dumps(self.packet())}], 'a'*32)['readOnly'])
    def test_foreign_missing_duplicate_or_changed_result_rejects(self):
        for change in [{'nonce':'b'*32},{'total':2},{'seq':-1},{'sha256':'0'*64},{'extra':True}]:
            packet=self.packet()|change
            with self.assertRaises(RuntimeError): module.decode([{'message':'OXY_BILLING_INVENTORY '+json.dumps(packet)}], 'a'*32)
        event={'message':'OXY_BILLING_INVENTORY '+json.dumps(self.packet())}
        with self.assertRaises(RuntimeError): module.decode([event,event], 'a'*32)
        with self.assertRaises(RuntimeError): module.decode([{'message':'unrelated log'}], 'a'*32)
    def test_changed_launcher_rejects_before_any_aws_call(self):
        plan={'launcherSha256':'0'*64}
        with self.assertRaisesRegex(RuntimeError,'Launcher source'): module.execute(plan, '/never-created-by-fixture')

if __name__ == '__main__': unittest.main()
