"""Offline guard tests. No key is read, no database or provider request is made."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest

SOURCE = Path(__file__).with_name('stripe-oxy-sandbox.py')
SPEC = importlib.util.spec_from_file_location('stripe_sandbox_runner', SOURCE)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class FrozenPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.good = {'schemaVersion': 1, 'nonce': 'a' * 24, 'preparedAt': int(time.time()),
                    'expiresAt': int(time.time()) + 86400, 'scope': RUNNER.scope(),
                    'sourceHead': RUNNER.run(['git', 'rev-parse', 'HEAD'], cwd=RUNNER.ROOT).strip(),
                    'sourceSha256': RUNNER.input_hashes()}

    def validate(self, plan):
        with tempfile.TemporaryDirectory(prefix='oxy-stripe-plan-') as folder:
            path = Path(folder) / 'plan.json'
            RUNNER.write_private(path, plan)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            return RUNNER.validate_plan(path)

    def test_exact_reviewed_plan(self):
        self.assertEqual(self.validate(self.good), self.good)

    def test_namespace_account_and_budget_changes_refused(self):
        for key, value in [('providerAccountId', 'acct_other'), ('mode', 'live'),
                           ('environment', 'production'), ('port', 5432),
                           ('maximumSyntheticPaidMinorUnits', 50001)]:
            with self.subTest(key=key):
                plan = copy.deepcopy(self.good)
                plan['scope'][key] = value
                with self.assertRaisesRegex(ValueError, 'scope'):
                    self.validate(plan)

    def test_expired_plan_refused(self):
        plan = copy.deepcopy(self.good)
        plan['preparedAt'] = int(time.time()) - 10
        plan['expiresAt'] = int(time.time()) - 1
        with self.assertRaisesRegex(ValueError, 'expired'):
            self.validate(plan)

    def test_changed_source_or_head_refused(self):
        plan = copy.deepcopy(self.good)
        plan['sourceSha256'][RUNNER.CHILD] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'bytes'):
            self.validate(plan)
        plan = copy.deepcopy(self.good)
        plan['sourceHead'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'head'):
            self.validate(plan)

    def test_foreign_inputs_and_reused_nonce_shape_refused(self):
        plan = copy.deepcopy(self.good)
        plan['databaseUrl'] = 'postgresql://foreign.invalid/live'
        with self.assertRaisesRegex(ValueError, 'fields'):
            self.validate(plan)
        plan = copy.deepcopy(self.good)
        plan['nonce'] = '../foreign'
        with self.assertRaisesRegex(ValueError, 'nonce'):
            self.validate(plan)

    def test_same_router_loader_bootstraps_without_credentials(self):
        self.assertEqual(json.loads(RUNNER.bootstrap_router()),
                         {'actualLoader': 'function', 'remoteRequests': 0, 'keyRead': False})

    def test_diagnostics_never_return_arbitrary_provider_messages(self):
        code = """
          import { rehearsalErrorDiagnostic } from './packages/api/scripts/stripe-billing-sandbox-rehearsal.ts';
          import assert from 'node:assert/strict';
          const arbitrary = rehearsalErrorDiagnostic(new Error('secret sk_test_do_not_emit header Bearer token'), 'fixture');
          assert.equal(arbitrary.reason, 'unclassified');
          assert.equal(JSON.stringify(arbitrary).includes('do_not_emit'), false);
          assert.equal(JSON.stringify(arbitrary).includes('Bearer'), false);
          assert.equal(rehearsalErrorDiagnostic(new Error('SubtleCryptoProvider cannot be used in a synchronous context.'), 'fixture').reason, 'crypto_sync_provider');
          assert.equal(rehearsalErrorDiagnostic(new Error('Event census exceeds five bounded pages'), 'fixture').reason, 'event_census_bound');
          console.log(JSON.stringify({passed: 5, remoteRequests: 0, keyRead: false}));
        """
        result = RUNNER.run(['bun', '-e', code], cwd=RUNNER.ROOT)
        self.assertEqual(json.loads(result), {'passed': 5, 'remoteRequests': 0, 'keyRead': False})

    def test_credential_environment_is_not_forwarded(self):
        previous = RUNNER.os.environ.copy()
        try:
            RUNNER.os.environ.update({'PGHOST': 'foreign.invalid', 'PGOPTIONS': '-c oxy.billing_namespace=test:test',
                                      'STRIPE_SECRET_KEY': 'sk_live_DO_NOT_FORWARD', 'AWS_SECRET_ACCESS_KEY': 'fixture',
                                      'DATABASE_URL': 'postgresql://foreign.invalid/live'})
            clean = RUNNER.scrub()
            self.assertFalse(any(key.startswith('PG') for key in clean))
            self.assertFalse({'STRIPE_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL'} & set(clean))
        finally:
            RUNNER.os.environ.clear()
            RUNNER.os.environ.update(previous)


if __name__ == '__main__':
    unittest.main(verbosity=2)
