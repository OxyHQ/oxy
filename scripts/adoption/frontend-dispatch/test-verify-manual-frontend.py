import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('verify-manual-frontend.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
SHA = 'a' * 40


class GateTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(GITHUB_REPOSITORY='OxyHQ/Mention', GITHUB_EVENT_NAME='workflow_dispatch',
                        GITHUB_REF='refs/heads/main', GITHUB_SHA=SHA, EXPECTED_SHA=SHA,
                        EXPECTED_CI_RUN_ID='123', EXPECTED_CI_WORKFLOW='.github/workflows/ci.yml')
        self.run = dict(id=123, head_sha=SHA, path='.github/workflows/ci.yml', event='push',
                        head_branch='main', status='completed', conclusion='success',
                        repository={'full_name':'OxyHQ/Mention'}, head_repository={'full_name':'OxyHQ/Mention'})
        self.main = SHA

    def read(self, path):
        return {'sha': self.main} if path.endswith('/commits/main') else self.run

    def test_exact_main_ci(self):
        self.assertEqual(gate.verify(self.env, self.read, SHA)['ciRunId'], '123')

    def test_wrong_event_branch_hold_checkout_and_inputs(self):
        for key, value in [('GITHUB_EVENT_NAME','push'), ('GITHUB_REF','refs/heads/other'),
                           ('OXY_1519_ROLLOUT_HOLD','true'), ('GITHUB_SHA','b'*40),
                           ('EXPECTED_SHA','main'), ('EXPECTED_CI_RUN_ID',''),
                           ('EXPECTED_CI_WORKFLOW','.github/workflows/deploy.yml')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                gate.verify({**self.env,key:value},self.read,SHA)
        with self.assertRaises(ValueError): gate.verify(self.env,self.read,'b'*40)

    def test_stale_main(self):
        self.main = 'b' * 40
        with self.assertRaises(ValueError): gate.verify(self.env,self.read,SHA)

    def test_wrong_ci_provenance_and_status(self):
        original = copy.deepcopy(self.run)
        for key,value in [('id',124),('head_sha','b'*40),('path','.github/workflows/deploy.yml'),
                          ('event','pull_request'),('head_branch','feature'),('status','in_progress'),
                          ('conclusion','failure'),('repository',{'full_name':'foreign/repo'}),
                          ('head_repository',{'full_name':'foreign/repo'})]:
            self.run = {**original,key:value}
            with self.subTest(key=key),self.assertRaises(ValueError):gate.verify(self.env,self.read,SHA)

    def test_api_error_is_not_success(self):
        def denied(_): raise ValueError('Read failed')
        with self.assertRaises(ValueError):gate.verify(self.env,denied,SHA)


if __name__ == '__main__':unittest.main()
