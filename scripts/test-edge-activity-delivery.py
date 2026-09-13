#!/usr/bin/env python3
import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('edge', Path(__file__).resolve().parents[1] / '.github/scripts/deliver-edge-activity.py')
edge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edge)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def test_unknown_principal_never_reads_or_writes(self):
        with patch.object(edge, 'api') as api, patch.object(edge, 'secret') as secret:
            for app in ('Kaana', '68b7c4e19f2a6d0e3c8b5174', 'nilo', '6a2f851751b784a86fd0e8f6'):
                with self.assertRaises(edge.DeliveryError):
                    edge.deliver(app, False, True)
            api.assert_not_called()
            secret.assert_not_called()

    def test_dry_run_never_decrypts_or_writes(self):
        with patch.object(edge, 'deployed', return_value=True), patch.object(edge, 'secret') as secret, patch.object(edge, 'api') as api:
            edge.deliver('6a2f851751b784a86fd0e94f')
            secret.assert_not_called()
            api.assert_not_called()

    def test_no_deployed_target_never_decrypts(self):
        with patch.object(edge, 'deployed', return_value=False), patch.object(edge, 'secret') as secret:
            with self.assertRaises(RuntimeError):
                edge.deliver('6a2f851751b784a86fd0e94f', False, True)
            secret.assert_not_called()

    def test_worker_pair_and_flag_are_one_merge_patch(self):
        with patch.object(edge, 'deployed', return_value=True), patch.object(edge, 'secret', side_effect=['key', 'secret']), patch.object(edge, 'api') as api:
            edge.deliver('6a2f851751b784a86fd0e92b', False)
            method, path, payload = api.call_args.args
            self.assertEqual((method, path), ('PATCH', 'workers/scripts/allo-frontend/secrets-bulk'))
            self.assertEqual(set(payload['secrets']), {'OXY_EDGE_ACTIVITY_API_KEY', 'OXY_EDGE_ACTIVITY_API_SECRET', 'OXY_EDGE_ACTIVITY_ENABLED'})
            self.assertEqual(payload['secrets']['OXY_EDGE_ACTIVITY_ENABLED']['text'], 'false')
            self.assertEqual(payload['secrets']['OXY_EDGE_ACTIVITY_API_SECRET']['type'], 'secret_text')

    def test_pages_only_changes_production_owned_keys_and_skips_absent(self):
        with patch.object(edge, 'deployed', side_effect=[True, False]), patch.object(edge, 'secret', side_effect=['key', 'secret']), patch.object(edge, 'api') as api:
            edge.deliver('6a2f851751b784a86fd0e958', False, True)
            api.assert_called_once()
            self.assertEqual(api.call_args.args[1], 'pages/projects/peable-frontend')
            config = api.call_args.args[2]['deployment_configs']
            self.assertEqual(set(config), {'production'})
            self.assertEqual(set(config['production']), {'env_vars'})
            self.assertEqual(len(config['production']['env_vars']), 3)

    def test_inventory_failure_never_decrypts_or_mutates(self):
        with patch.object(edge, 'deployed', side_effect=RuntimeError('inventory unavailable')), patch.object(edge, 'secret') as secret, patch.object(edge, 'api') as api:
            with self.assertRaises(RuntimeError):
                edge.deliver('6a2f851751b784a86fd0e92b', False, True)
            secret.assert_not_called()
            api.assert_not_called()

    def test_incomplete_pair_never_mutates(self):
        with patch.object(edge, 'deployed', return_value=True), patch.object(edge, 'secret', side_effect=['key', RuntimeError('missing')]), patch.object(edge, 'api') as api:
            with self.assertRaises(RuntimeError):
                edge.deliver('6a2f851751b784a86fd0e92b', False, True)
            api.assert_not_called()

    def test_unexpected_exception_text_is_never_logged(self):
        for error in (ValueError('Invalid header: Bearer private-token'),
                      RuntimeError('response contains private-secret')):
            self.assertNotIn('private', edge.safe_error_message(error))
        self.assertEqual(edge.safe_error_message(edge.DeliveryError('fixed status')), 'fixed status')

    def test_preview_is_not_production(self):
        with patch.object(edge, 'api', return_value={'canonical_deployment': {'environment': 'preview', 'latest_stage': {'status': 'success'}}}):
            self.assertFalse(edge.deployed('pages', 'atlas'))


unittest.main()
