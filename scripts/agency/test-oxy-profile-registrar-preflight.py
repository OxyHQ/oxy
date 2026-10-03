#!/usr/bin/env python3
"""Offline real encoder/decoder and launcher paths; AWS boundary is synthetic."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mention_preflight', HERE/'oxy-profile-registrar-preflight-ecs.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
NONCE = 'a'*32
RESULT = {'schemaVersion': 1, 'kind': 'oxy-profile-registrar-preflight', 'profile': 'oxy', 'readOnly': True, 'isolation': 'repeatable read', 'tables': {'applications': {'status': 'complete', 'count': 0, 'rows': []}}}


def encoded(result):
    # Import only: actual Node encoder + real resolved postgres, no SQL/client.
    code = 'import {encodeInventory} from '+json.dumps(launcher.READER.as_uri())+'; for(const line of encodeInventory('+json.dumps(result)+','+json.dumps(NONCE)+')) console.log(line);'
    env = {key: os.environ[key] for key in ['PATH', 'HOME', 'LANG'] if key in os.environ}
    completed = subprocess.run(['node', '--input-type=module', '-e', code], cwd=HERE.parents[1]/'packages/api', env=env, capture_output=True, text=True, timeout=20, check=True)
    return [{'message': line} for line in completed.stdout.splitlines()]


class FakeAWS:
    def __init__(self, definition, events, failure=None, found=1):
        self.definition = definition; self.events = events; self.failure = failure; self.found = found
        self.calls = []; self.active = True; self.intent_verified = False; self.directory = None
        self.arn = f'arn:aws:ecs:{launcher.REGION}:{launcher.ACCOUNT}:task-definition/{definition["family"]}:1'
        self.started = 'oxy-registrar-'+NONCE

    def task(self, index=0):
        return {'taskArn': f'arn:aws:ecs:{launcher.REGION}:{launcher.ACCOUNT}:task/oxy-cluster/task{index}', 'taskDefinitionArn': self.arn, 'startedBy': self.started, 'lastStatus': 'STOPPED', 'containers': [{'exitCode': 0, 'imageDigest': 'sha256:'+'b'*64}]}

    def __call__(self, *args):
        self.calls.append(args); operation = args[1]
        if operation in ['register-task-definition', 'describe-task-definition']:
            if '--query' in args: return 'INACTIVE' if not self.active else 'ACTIVE'
            return {'taskDefinition': {**self.definition, 'taskDefinitionArn': self.arn, 'status': 'ACTIVE'}}
        if operation == 'run-task':
            intent = json.loads((self.directory/'dispatch-attempt.json').read_text())
            assert intent['clientToken'] == NONCE and intent['startedBy'] == self.started
            assert args[args.index('--client-token')+1] == NONCE
            assert (self.directory/'dispatch-attempt.json').stat().st_mode & 0o777 == 0o600
            self.intent_verified = True
            if self.failure: raise RuntimeError('AWS metadata/action failed; raw errors withheld')
            return {'tasks': [self.task()], 'failures': []}
        if operation == 'list-tasks':
            if '--started-by' in args:
                assert '--desired-status' not in args and '--family' not in args
            return {'taskArns': [self.task(i)['taskArn'] for i in range(self.found)]}
        if operation == 'describe-tasks':
            requested = args[args.index('--tasks')+1:]
            return {'tasks': [self.task(i) for i in range(self.found) if self.task(i)['taskArn'] in requested], 'failures': []}
        if operation == 'get-log-events':
            return {'events': [] if '--next-token' in args else self.events, 'nextForwardToken': 'terminal'}
        if operation == 'deregister-task-definition': self.active = False; return {}
        raise AssertionError('Unexpected boundary operation '+operation)


class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.events = encoded(RESULT)

    def test_real_reader_protocol_round_trip(self):
        result = launcher.decode(self.events, NONCE)
        launcher.validate_result(result, 'oxy')
        self.assertEqual(result, RESULT)

    def test_old_protocol_kind_is_rejected(self):
        result = copy.deepcopy(RESULT); result['kind'] = 'service-authority-preflight'
        with self.assertRaisesRegex(RuntimeError, 'Invalid result'): launcher.validate_result(launcher.decode(encoded(result), NONCE), 'oxy')

    def test_wrong_profile_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'Invalid result'): launcher.validate_result(RESULT, 'other')

    def test_wrong_nonce_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'Foreign result nonce'): launcher.decode(self.events, 'c'*32)

    def test_duplicate_packet_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'): launcher.decode(self.events*2, NONCE)

    def test_tampered_digest_is_rejected(self):
        events = copy.deepcopy(self.events); packet = json.loads(events[0]['message'].split(' ', 1)[1]); packet['sha256'] = '0'*64
        events[0]['message'] = 'OXY_BILLING_INVENTORY '+json.dumps(packet)
        with self.assertRaisesRegex(RuntimeError, 'digest differ'): launcher.decode(events, NONCE)

    def execute_fake(self, failure=None, found=1, events=None):
        live = {'image': 'registry@sha256:'+'b'*64, 'executionRoleArn': 'role', 'cpu': '256', 'memory': '512', 'runtimePlatform': {}, 'databaseSecret': {'name': 'DATABASE_URL', 'valueFrom': 'fixture'}, 'logGroup': '/fixture', 'logStreamPrefix': 'fixture', 'network': {'fixture': True}}
        plan = {'schemaVersion': 1, 'profile': 'oxy', 'nonce': NONCE, 'preparedAt': int(launcher.time.time()), 'launcherSha256': hashlib.sha256(Path(launcher.__file__).read_bytes()).hexdigest(), 'readerSha256': hashlib.sha256(launcher.READER.read_bytes()).hexdigest(), 'live': live}
        definition = launcher.build_definition(plan); plan['taskDefinitionSha256'] = launcher.digest(definition)
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch)/'output'; fake = FakeAWS(definition, self.events if events is None else events, failure, found); fake.directory = output
            with patch.object(launcher, 'aws', fake), patch.object(launcher, 'describe', return_value=live), patch.object(launcher.time, 'sleep'):
                if failure:
                    with self.assertRaisesRegex(RuntimeError, 'Cleanup readback incomplete'): launcher.execute(plan, output)
                else: launcher.execute(plan, output)
            records = {p.name: json.loads(p.read_text()) for p in output.glob('*.json')}
            self.assertTrue(fake.intent_verified)
            self.assertEqual(sum(call[1] == 'run-task' for call in fake.calls), 1)
            self.assertTrue(records['cleanup.json']['definitionInactive'])
            return fake, records

    def test_complete_execute_uses_real_protocol_and_durable_intent(self):
        _, records = self.execute_fake()
        self.assertEqual(records['result.private.json'], RESULT)
        self.assertEqual(records['cleanup.json']['failures'], [])

    def test_unknown_ack_reconciles_exact_task_and_never_redispatches(self):
        _, records = self.execute_fake(failure=True)
        self.assertEqual(len(records['dispatch-unknown.json']['matchedTaskArns']), 1)
        self.assertTrue(records['cleanup.json']['taskStopped'])
        self.assertIn('dispatch_acknowledgement_unknown_requires_review', records['cleanup.json']['failures'])

    def test_unknown_absent_ack_stays_unresolved(self):
        fake, records = self.execute_fake(failure=True, found=0)
        self.assertTrue(records['dispatch-unknown.json']['absenceDoesNotProveNoTask'])
        self.assertFalse(records['cleanup.json']['taskStopped'])
        self.assertEqual(sum(call[1] == 'list-tasks' for call in fake.calls), 12)

    def test_unknown_ambiguous_ack_cleans_all_exact_tasks_and_rejects(self):
        _, records = self.execute_fake(failure=True, found=2)
        self.assertEqual(len(records['dispatch-unknown.json']['matchedTaskArns']), 2)
        self.assertTrue(records['cleanup.json']['taskStopped'])

    def test_recovered_wrong_definition_rejected(self):
        fake = FakeAWS({'family': 'fixture'}, self.events)
        original = fake.task
        fake.task = lambda i=0: {**original(i), 'taskDefinitionArn': 'different'}
        with patch.object(launcher, 'aws', fake):
            with self.assertRaisesRegex(RuntimeError, 'another definition'): launcher.find_dispatched_tasks(fake.arn, fake.started)

    def test_dispatch_census_pagination_bound(self):
        def endless(*args): return {'taskArns': [], 'nextToken': str(endless.counter())}
        values = iter(range(100)); endless.counter = lambda: next(values)
        with patch.object(launcher, 'aws', endless):
            with self.assertRaisesRegex(RuntimeError, 'exceeded bound'): launcher.find_dispatched_tasks('arn/family:1', 'started')


if __name__ == '__main__': unittest.main(verbosity=2)
