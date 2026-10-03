"""Construction/state fixtures; never substitutes for Docker execution in Actions."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('image_bootstrap', Path(__file__).with_name('image-bootstrap.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
IMAGE = 'sha256:' + 'a' * 64
CID = 'b' * 64


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.calls = []
        self.running = True
        self.absent = False
        self.bad_image = False
        self.stop_fails = False

    def tearDown(self):
        self.temp.cleanup()

    def command(self, args, **kwargs):
        self.calls.append(args)
        if args[:2] == ['docker', 'inspect']:
            if args[2] == IMAGE:
                return json.dumps([{'Id': IMAGE, 'Architecture': 'arm64', 'Os': 'linux'}])
            if self.absent:
                raise subprocess.CalledProcessError(1, args)
            return json.dumps([{
                'Id': CID, 'Image': 'sha256:' + 'c' * 64 if self.bad_image else IMAGE,
                'Name': '/' + self.row['name'],
                'Config': {'Labels': {'oxy.auth-only.proof': self.row['name']},
                           'Entrypoint': ['node'], 'Cmd': ['/proof/old-auth-only/host.mjs']},
                'HostConfig': {'ReadonlyRootfs': True, 'NetworkMode': 'host',
                               'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true']},
                'State': {'Running': self.running, 'Pid': 123 if self.running else 0, 'ExitCode': 0}}])
        if args[:2] == ['docker', 'stop']:
            if self.stop_fails:
                raise subprocess.TimeoutExpired(args, 30)
            self.running = False
        if args[:2] == ['docker', 'rm']:
            assert not self.running
            self.absent = True
        if args[:2] == ['docker', 'ps']:
            return '' if self.absent else CID
        return ''

    def create(self):
        image = module.ImageBootstrap(IMAGE, self.root, self.root / 'proof', self.command)
        (self.root / 'proof').mkdir()
        argv = image.run('host.mjs', ['/app', '/proof/output/variant-ready.json'], {'NODE_ENV': 'production'})
        self.row = image.containers[0]
        self.row['cidfile'].write_text(CID)
        return image, argv

    def test_exact_image_and_runtime_command(self):
        image, args = self.create()
        self.assertEqual(args[-4:], [IMAGE, '/proof/old-auth-only/host.mjs', '/app', '/proof/output/variant-ready.json'])
        for value in ('--read-only', 'ALL', 'no-new-privileges:true', 'host', 'NODE_ENV'):
            self.assertIn(value, args)
        self.assertIn(f'{os.getuid()}:{os.getgid()}', args)
        self.assertIn(f'type=bind,src={self.root / "proof"},dst=/proof/output', args)
        self.assertNotIn('pg', ' '.join(args))
        self.assertEqual(image.verify(self.row, running=True)['image'], IMAGE)

    def test_rejects_mutable_tag_before_dispatch(self):
        with self.assertRaises(ValueError):
            module.ImageBootstrap('candidate:latest', self.root, self.root, self.command)
        self.assertEqual(self.calls, [])

    def test_only_reviewed_scripts(self):
        image, _ = self.create()
        with self.assertRaises(ValueError):
            image.run('unreviewed.mjs', [], {})

    def test_changed_image_rejected_without_stopping_unowned_container(self):
        image, _ = self.create()
        self.bad_image = True
        with self.assertRaises(AssertionError):
            image.stop()
        self.assertFalse(any(c[:2] == ['docker', 'stop'] for c in self.calls))

    def test_owned_container_stopped_and_absence_read_back(self):
        image, _ = self.create()
        self.assertTrue(image.stop()[0]['absent'])
        verbs = [c[1] for c in self.calls]
        self.assertLess(verbs.index('stop'), verbs.index('rm'))
        self.assertEqual(verbs[-1], 'ps')

    def test_lost_cli_response_reconciles_exact_own_name(self):
        image, _ = self.create()
        self.row['cidfile'].unlink()  # Dispatch returned no cid/ACK; exact name + label still identifies it.
        self.assertTrue(image.stop()[0]['absent'])

    def test_failed_inspect_does_not_mean_absent(self):
        image, _ = self.create()
        original = self.command
        def failed(args, **kw):
            if args[:2] == ['docker', 'inspect']:
                raise subprocess.CalledProcessError(1, args)
            return original(args, **kw)
        image.command = failed
        with self.assertRaises(AssertionError):
            image.stop()

    def test_stop_timeout_blocks_success_and_remove(self):
        image, _ = self.create()
        self.stop_fails = True
        with self.assertRaises(subprocess.TimeoutExpired):
            image.stop()
        self.assertFalse(any(c[:2] == ['docker', 'rm'] for c in self.calls))

    def test_runner_tears_down_image_before_database(self):
        source = Path(__file__).with_name('run.py').read_text()
        self.assertLess(source.index('image.stop()'), source.index('DROP DATABASE'))
        self.assertIn('if started and containers_safe:', source)
        self.assertIn('databaseRetainedForUnresolvedContainer', source)
        self.assertIn("proof_output=owned/'proof'", source)


if __name__ == '__main__':
    unittest.main()
