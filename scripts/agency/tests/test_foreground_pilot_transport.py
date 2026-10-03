"""Offline AWS protocol fixtures only; no ECS/HTTP/SQL requests or secret material."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'foreground-pilot-ecs.py'
spec = importlib.util.spec_from_file_location('foreground_pilot', SCRIPT)
pilot = importlib.util.module_from_spec(spec); spec.loader.exec_module(pilot)
NONCE = 'a' * 32
TD = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-i05-foreground-configuration:1'
TASK = 'arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/' + 'b' * 32
HEAD = 'c' * 40


def plan():
    live = {'executionRoleArn': 'arn:aws:iam::237343248947:role/oxy-execution',
        'cpu': '512', 'memory': '1024', 'runtimePlatform': {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'},
        'image': '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:' + 'd' * 64,
        'databaseSecret': {'name': 'DATABASE_URL', 'valueFrom': 'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL'},
        'network': {'awsvpcConfiguration': {'subnets': ['synthetic'], 'securityGroups': ['synthetic'], 'assignPublicIp': 'DISABLED'}},
        'logGroup': '/oxy/ecs', 'logStreamPrefix': 'oxy-api'}
    value = {'schemaVersion': 1, 'kind': 'i05-foreground-dispatch', 'preparedAt': int(time.time()), 'nonce': NONCE,
        'operation': 'execute', 'definition': 'oxy-oxy-api:999', 'sourceHead': HEAD, 'sourceSha256': pilot.source_pins(),
        # The real TS definition parser is exercised by 73 source SQL/HTTPS tests;
        # this unit only isolates the AWS carrier protocol, never claims authority.
        'configuration': {'schemaVersion': 1, 'kind': 'i05-foreground-configuration', 'nonce': NONCE}, 'live': live}
    value['configurationSha256'] = pilot.digest(value['configuration'])
    value['taskDefinitionSha256'] = pilot.digest(pilot.build_definition(value))
    return value


def stopped(value):
    return {'taskArn': TASK, 'taskDefinitionArn': TD, 'lastStatus': 'STOPPED',
        'containers': [{'name': 'configuration', 'exitCode': 0, 'imageDigest': value['live']['image'].split('@')[1]}]}


def operations():
    rows = [{'kind': 'i05-foreground-operation', 'nonce': NONCE, 'phase': phase} for phase in [
        'configuration-intent', 'configuration-confirmed', 'credential-intent', 'credential-confirmed',
        'mint-intent', 'mint-confirmed', 'register-intent', 'register-confirmed', 'cleanup-confirmed']]
    return rows + [{'kind': 'i05-foreground-operation', 'nonce': NONCE, 'operation': 'execute', 'status': 'confirmed'}]


class Transport(unittest.TestCase):
    def setUp(self):
        self.value = plan(); self.temp = tempfile.TemporaryDirectory(); self.directory = Path(self.temp.name) / 'operation'
        self.head = patch.object(pilot, 'git_head', return_value=HEAD); self.head.start()
        self.live = patch.object(pilot.base, 'describe', return_value=self.value['live']); self.live.start()
        self.calls = []; pilot.interrupted = False
    def tearDown(self):
        self.head.stop(); self.live.stop(); self.temp.cleanup()
    def aws(self, *args):
        self.calls.append(args)
        if args[:2] == ('ecs', 'register-task-definition'):
            intent = json.loads((self.directory / 'registration-intent.json').read_text())
            self.assertEqual(intent['definitionSha256'], self.value['taskDefinitionSha256'])
            actual = pilot.build_definition(self.value) | {'taskDefinitionArn': TD, 'status': 'ACTIVE'}
            return {'taskDefinition': actual}
        if args[:2] == ('ecs', 'describe-task-definition'):
            if '--query' in args: return 'INACTIVE'
            return {'taskDefinition': pilot.build_definition(self.value) | {'taskDefinitionArn': TD, 'status': 'ACTIVE'}}
        if args[:2] == ('ecs', 'run-task'):
            intent_path = self.directory / 'dispatch-intent.json'
            self.assertEqual(os.stat(intent_path).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(intent_path.read_text())['clientToken'], NONCE)
            self.assertEqual(args[args.index('--client-token') + 1], NONCE)
            return {'tasks': [{'taskArn': TASK}], 'failures': []}
        if args[:2] == ('ecs', 'describe-tasks'): return {'tasks': [stopped(self.value)], 'failures': []}
        if args[:2] == ('ecs', 'deregister-task-definition'): return {}
        if args[:2] == ('logs', 'get-log-events'):
            first = '--next-token' not in args
            return {'events': [{'message': json.dumps(row)} for row in operations()] if first else [], 'nextForwardToken': 'same'}
        raise AssertionError('Unexpected offline AWS command')
    def test_exact_definition_has_no_task_role_sidecars_extra_secrets_or_shell(self):
        definition = pilot.build_definition(self.value)
        self.assertNotIn('taskRoleArn', definition)
        self.assertEqual(len(definition['containerDefinitions']), 1)
        container = definition['containerDefinitions'][0]
        self.assertEqual(container['secrets'], [self.value['live']['databaseSecret']])
        self.assertEqual(container['entryPoint'], ['/usr/local/bin/node'])
        self.assertEqual(container['command'][:2], ['dist/scripts/foregroundPilotExecutor.js', 'execute'])
        self.assertEqual(container['stopTimeout'], 120)
    def test_positive_checks_durable_intents_exact_image_protocol_and_cleanup(self):
        with patch.object(pilot.base, 'aws', side_effect=self.aws): pilot.execute(self.value, self.directory)
        self.assertEqual(json.loads((self.directory / 'receipt.json').read_text())['authorityCleanupConfirmed'], True)
        self.assertEqual(json.loads((self.directory / 'cleanup.json').read_text())['failures'], [])
        self.assertEqual(sum(row[:2] == ('ecs', 'run-task') for row in self.calls), 1)
    def test_unknown_ack_reconciles_once_and_never_claims_authority_cleanup(self):
        def unknown(*args):
            if args[:2] == ('ecs', 'run-task'):
                self.aws(*args); raise RuntimeError('synthetic lost ACK')
            return self.aws(*args)
        with patch.object(pilot.base, 'aws', side_effect=unknown), patch.object(pilot.base, 'find_dispatched_tasks', return_value=[TASK]):
            with self.assertRaises(RuntimeError): pilot.execute(self.value, self.directory)
        self.assertTrue((self.directory / 'dispatch-intent.json').exists())
        cleanup = json.loads((self.directory / 'cleanup.json').read_text())
        self.assertFalse(cleanup['authorityCleanupConfirmed'])
        self.assertIn('ack_unknown_requires_intent_reconciliation', cleanup['failures'])
        self.assertEqual(sum(row[:2] == ('ecs', 'run-task') for row in self.calls), 1)
    def test_failed_container_with_cleanup_record_is_not_success(self):
        def failed(*args):
            if args[:2] == ('ecs', 'describe-tasks'):
                row = stopped(self.value); row['containers'][0]['exitCode'] = 1
                return {'tasks': [row], 'failures': []}
            return self.aws(*args)
        with patch.object(pilot.base, 'aws', side_effect=failed):
            with self.assertRaises(RuntimeError): pilot.execute(self.value, self.directory)
        self.assertFalse((self.directory / 'receipt.json').exists())
        self.assertFalse(json.loads((self.directory / 'cleanup.json').read_text())['operationConfirmed'])
        self.assertTrue(json.loads((self.directory / 'cleanup.json').read_text())['operationIncompleteRequiresSqlReview'])
        self.assertEqual(json.loads((self.directory / 'cleanup.json').read_text())['failures'], [])
    def test_plan_pin_expiry_and_unknown_field_refused_before_write(self):
        for mutate in [lambda p: p.update(preparedAt=int(time.time()) - 1801),
                       lambda p: p['sourceSha256'].update({'unexpected': 'x'}),
                       lambda p: p.update(configurationSha256='0' * 64),
                       lambda p: p.update(taskDefinitionSha256='0' * 64),
                       lambda p: p.update(unexpected=True)]:
            with self.subTest(mutate=mutate):
                changed = copy.deepcopy(self.value); mutate(changed)
                with patch.object(pilot.base, 'aws', side_effect=AssertionError('write forbidden')):
                    with self.assertRaises(RuntimeError): pilot.execute(changed, self.directory)
                self.assertFalse(self.directory.exists())
    def test_registered_extra_task_role_or_short_grace_is_refused(self):
        expected = pilot.build_definition(self.value)
        actual = expected | {'taskDefinitionArn': TD, 'status': 'ACTIVE'}
        for mutate in [lambda p: p.update(taskRoleArn='arn:aws:iam::237343248947:role/forbidden'),
                       lambda p: p['containerDefinitions'][0].update(stopTimeout=30),
                       lambda p: p['containerDefinitions'][0]['environment'].append({'name': 'TOKEN', 'value': 'synthetic'})]:
            changed = copy.deepcopy(actual); mutate(changed)
            with self.assertRaises(RuntimeError): pilot.verify_definition(changed, expected)
    def test_foreign_nonce_or_unexpected_fields_never_become_receipt(self):
        for extra in [{'kind': 'i05-foreground-operation', 'nonce': 'f' * 32, 'phase': 'cleanup-confirmed'},
                      {'kind': 'i05-foreground-operation', 'nonce': NONCE, 'phase': 'cleanup-confirmed', 'token': 'synthetic'}]:
            with self.subTest(extra=extra):
                with patch.object(pilot.base, 'aws', return_value={'events': [{'message': json.dumps(extra)}], 'nextForwardToken': 'same'}):
                    with self.assertRaises(RuntimeError): pilot.collect_operations(self.value, TASK)
    def test_repeated_log_token_does_not_spin_and_output_is_bounded(self):
        with patch.object(pilot.base, 'aws', return_value={'events': [], 'nextForwardToken': 'same'}) as api:
            self.assertEqual(pilot.collect_operations(self.value, TASK), []); self.assertEqual(api.call_count, 2)
        with patch.object(pilot.base, 'aws', return_value={'events': [{'message': 'x' * (256 * 1024 + 1)}]}):
            with self.assertRaises(RuntimeError): pilot.collect_operations(self.value, TASK)
    def test_log_delivery_lag_retries_only_bounded_reads(self):
        with patch.object(pilot, 'collect_operations', side_effect=[[], operations()]) as read, patch.object(pilot.time, 'sleep'):
            self.assertEqual(pilot.collect_confirmed_operations(self.value, TASK), operations()); self.assertEqual(read.call_count, 2)
        with patch.object(pilot, 'collect_operations', return_value=[]) as read, patch.object(pilot.time, 'sleep'):
            with self.assertRaises(RuntimeError): pilot.collect_confirmed_operations(self.value, TASK)
            self.assertEqual(read.call_count, 12)
        with patch.object(pilot, 'collect_operations', side_effect=RuntimeError('Foreign operation nonce')) as read:
            with self.assertRaises(RuntimeError): pilot.collect_confirmed_operations(self.value, TASK)
            self.assertEqual(read.call_count, 1)
    def test_private_records_cannot_dirty_frozen_source(self):
        with self.assertRaises(RuntimeError): pilot.outside_source(pilot.ROOT / 'own-plan.json')
        self.assertEqual(pilot.outside_source(self.directory), self.directory.resolve())
    def test_operator_signal_defers_repeated_signal_during_cleanup(self):
        pilot.cleanup_running = False
        with self.assertRaises(InterruptedError): pilot.handle_signal(15, None)
        self.assertTrue(pilot.interrupted)
        pilot.cleanup_running = True; pilot.handle_signal(15, None)  # cleanup proceeds


if __name__ == '__main__': unittest.main()
