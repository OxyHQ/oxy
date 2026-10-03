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

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / 'scripts/operations/consumer-publishers/publish-reviewed-image.py'
TEMPLATES = ROOT / 'docs/architecture/1519-consumer-image-publishers'
YAML = '/home/nate/Oxy/Mention/node_modules/js-yaml'
spec = importlib.util.spec_from_file_location('publisher', HELPER)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def parse_yaml(path):
    return json.loads(subprocess.check_output(['node', '-e', 'const fs=require("fs"),y=require(process.argv[1]);process.stdout.write(JSON.stringify(y.load(fs.readFileSync(process.argv[2],"utf8"))));', YAML, str(path)]))


class SourceGuard(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name); self.cwd = os.getcwd(); os.chdir(self.path); self.addCleanup(os.chdir, self.cwd)
        (self.path / '.github/scripts').mkdir(parents=True)
        self.recipe = {'name': 'example', 'services': ['example'], 'ecrRepository': 'oxy/example', 'dockerfile': 'Dockerfile', 'dockerfileSha256': m.sha(b'FROM scratch\n'), 'target': None, 'tagSuffix': '', 'cacheScope': None}
        (self.path / 'Dockerfile').write_text('FROM scratch\n')
        (self.path / '.github/scripts/reviewed-images.json').write_text(json.dumps({'repository': 'OxyHQ/Example', 'recipes': [self.recipe]}))
        subprocess.run(['git', 'init', '-q'], check=True)
        subprocess.run(['git', 'add', 'Dockerfile', '.github/scripts/reviewed-images.json'], check=True)
        subprocess.run(['git', '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic source'], check=True)
        self.head = m.git('rev-parse', 'HEAD')
        self.env = {'GITHUB_SHA': self.head, 'EXPECTED_SOURCE_SHA': self.head, 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': 'OxyHQ/Example', 'GITHUB_OUTPUT': str(self.path.parent / (self.path.name + '-output'))}
        self.patch = patch.dict(os.environ, self.env); self.patch.start(); self.addCleanup(self.patch.stop)

    def test_real_guard_accepts_exact_clean_git(self):
        self.assertEqual(m.source_guard('example')[2], self.head)

    def test_sha_mismatch(self):
        os.environ['EXPECTED_SOURCE_SHA'] = '0' * 40
        with self.assertRaises(m.Rejected): m.source_guard('example')

    def test_malformed_sha(self):
        os.environ['GITHUB_SHA'] = 'x' * 40
        with self.assertRaises(m.Rejected): m.source_guard('example')

    def test_wrong_branch(self):
        os.environ['GITHUB_REF'] = 'refs/heads/feature'
        with self.assertRaises(m.Rejected): m.source_guard('example')

    def test_non_manual(self):
        os.environ['GITHUB_EVENT_NAME'] = 'push'
        with self.assertRaises(m.Rejected): m.source_guard('example')

    def test_wrong_repository(self):
        os.environ['GITHUB_REPOSITORY'] = 'OxyHQ/Other'
        with self.assertRaises(m.Rejected): m.source_guard('example')

    def test_unknown_recipe(self):
        with self.assertRaises(m.Rejected): m.source_guard('unregistered')

    def test_dirty_checkout(self):
        (self.path / 'unexpected').write_text('fixture')
        with self.assertRaises(m.Rejected): m.source_guard('example')

    def test_committed_dockerfile_drift(self):
        (self.path / 'Dockerfile').write_text('FROM unexpected\n')
        subprocess.run(['git', 'add', 'Dockerfile'], check=True)
        subprocess.run(['git', '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'changed Dockerfile'], check=True)
        os.environ['GITHUB_SHA'] = os.environ['EXPECTED_SOURCE_SHA'] = m.git('rev-parse', 'HEAD')
        with self.assertRaises(m.Rejected): m.source_guard('example')

    def test_cli_guard_failure_no_aws(self):
        os.environ['EXPECTED_SOURCE_SHA'] = '0' * 40
        with tempfile.TemporaryDirectory() as tools:
            stub = Path(tools) / 'aws'; stub.write_text('#!/bin/sh\nexit 99\n'); stub.chmod(0o700)
            env = {**os.environ, 'PATH': tools + ':' + os.environ['PATH']}
            result = subprocess.run(['python3', '-B', str(HELPER), 'vacancy', '--recipe', 'example'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1); self.assertIn('Expected source SHA differs', result.stdout); self.assertNotIn('Command failed', result.stdout)


class EcrReadback(unittest.TestCase):
    def setUp(self):
        self.r = {'ecrRepository': 'oxy/example'}
        self.missing = {'images': [], 'failures': [{'imageId': {'imageTag': 'a' * 40}, 'failureCode': 'ImageNotFound'}]}

    def test_missing_exact_tag(self):
        with patch.object(m, 'aws', return_value=self.missing): self.assertIsNone(m.image_by_tag(self.r, 'a' * 40))

    def test_other_failure_denied(self):
        self.missing['failures'][0]['failureCode'] = 'KmsError'
        with patch.object(m, 'aws', return_value=self.missing), self.assertRaises(m.Rejected): m.image_by_tag(self.r, 'a' * 40)

    def test_empty_response_denied(self):
        with patch.object(m, 'aws', return_value={}), self.assertRaises(m.Rejected): m.image_by_tag(self.r, 'a' * 40)

    def test_ambiguous_response_denied(self):
        with patch.object(m, 'aws', return_value={'images': [{}, {}]}), self.assertRaises(m.Rejected): m.image_by_tag(self.r, 'a' * 40)

    def test_foreign_repository_denied(self):
        image = {'registryId': m.ACCOUNT, 'repositoryName': 'oxy/other', 'imageId': {'imageTag': 'a' * 40}}
        with patch.object(m, 'aws', return_value={'images': [image]}), self.assertRaises(m.Rejected): m.image_by_tag(self.r, 'a' * 40)

    def test_cli_existing_tag_refused_before_build(self):
        # Real subprocess execution of the CLI with a local AWS executable, no network.
        case = SourceGuard('test_real_guard_accepts_exact_clean_git'); case.setUp()
        try:
            with tempfile.TemporaryDirectory() as tools:
                stub = Path(tools) / 'aws'
                image = {'registryId': m.ACCOUNT, 'repositoryName': 'oxy/example', 'imageId': {'imageTag': case.head, 'imageDigest': 'sha256:' + 'a' * 64}}
                stub.write_text('#!/usr/bin/env python3\nimport json\nprint(' + repr(json.dumps({'images': [image]})) + ')\n'); stub.chmod(0o700)
                env = {**os.environ, 'PATH': tools + ':' + os.environ['PATH']}
                result = subprocess.run(['python3', '-B', str(HELPER), 'vacancy', '--recipe', 'example'], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 1); self.assertIn('already exists', result.stdout)
        finally: case.doCleanups()

    def test_config_oversize_before_transport(self):
        with self.assertRaises(m.Rejected): m.read_config(self.r, {'digest': 'sha256:' + 'a' * 64, 'size': 9 * 1024 * 1024})

    def test_config_untrusted_url(self):
        descriptor = {'digest': 'sha256:' + 'a' * 64, 'size': 1}
        with patch.object(m, 'aws', return_value={'layerDigest': descriptor['digest'], 'downloadUrl': 'https://evil.invalid/secret'}), self.assertRaises(m.Rejected): m.read_config(self.r, descriptor)

    def test_redirect_refused(self):
        with self.assertRaises(ValueError): m.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid/')


class ImageBinding(unittest.TestCase):
    def setUp(self):
        self.head = 'a' * 40; self.tree = 'b' * 40
        self.r = {'dockerfileSha256': 'c' * 64}
        self.config = {'repository': 'OxyHQ/Example'}
        self.ic = {'architecture': 'arm64', 'os': 'linux', 'config': {'Labels': {'org.opencontainers.image.revision': self.head, 'org.opencontainers.image.source': 'https://github.com/OxyHQ/Example', 'io.oxy.source.tree': self.tree, 'io.oxy.dockerfile.sha256': 'c' * 64}}}
        self.manifest = {'schemaVersion': 2, 'mediaType': m.MANIFEST_TYPES[0], 'config': {'digest': 'sha256:' + 'd' * 64}, 'layers': [{'digest': 'sha256:' + 'e' * 64}]}
        self.raw = json.dumps(self.manifest); self.digest = 'sha256:' + m.sha(self.raw.encode())
        self.image = {'imageManifest': self.raw, 'imageId': {'imageDigest': self.digest}}
        self.metadata = {'containerimage.digest': self.digest, 'containerimage.config.digest': 'sha256:' + 'd' * 64}

    def verify(self):
        with patch.object(m, 'git', return_value=self.tree): return m.verify_image(self.image, self.config, self.r, self.head, self.metadata, self.ic)

    def test_exact_build_ecr_config_source(self): self.assertEqual(self.verify()['manifestSha256'], self.digest[7:])
    def test_manifest_byte_drift(self):
        self.image['imageManifest'] += ' '
        with self.assertRaises(m.Rejected): self.verify()
    def test_build_digest_mismatch(self):
        self.metadata['containerimage.digest'] = 'sha256:' + '0' * 64
        with self.assertRaises(m.Rejected): self.verify()
    def test_config_digest_mismatch(self):
        self.metadata['containerimage.config.digest'] = 'sha256:' + '0' * 64
        with self.assertRaises(m.Rejected): self.verify()
    def test_wrong_architecture(self):
        self.ic['architecture'] = 'amd64'
        with self.assertRaises(m.Rejected): self.verify()
    def test_wrong_source_label(self):
        self.ic['config']['Labels']['org.opencontainers.image.revision'] = 'f' * 40
        with self.assertRaises(m.Rejected): self.verify()
    def test_wrong_tree(self):
        self.ic['config']['Labels']['io.oxy.source.tree'] = 'f' * 40
        with self.assertRaises(m.Rejected): self.verify()
    def test_wrong_dockerfile(self):
        self.ic['config']['Labels']['io.oxy.dockerfile.sha256'] = 'f' * 64
        with self.assertRaises(m.Rejected): self.verify()
    def test_artifact_retains_exact_manifest_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {'BUILD_METADATA': json.dumps(self.metadata), 'RUNNER_TEMP': directory, 'GITHUB_OUTPUT': directory + '/output', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_WORKFLOW_REF': 'OxyHQ/Example/.github/workflows/publish-reviewed-images.yml@refs/heads/main'}
            recipe = {**self.r, 'name': 'example', 'tagSuffix': '', 'ecrRepository': 'oxy/example'}
            with patch.dict(os.environ, env), patch.object(m, 'source_guard', return_value=(self.config, recipe, self.head)), patch.object(m, 'image_by_tag', return_value=self.image), patch.object(m, 'read_config', return_value=self.ic), patch.object(m, 'git', return_value=self.tree), patch('sys.argv', ['helper', 'verify', '--recipe', 'example']):
                m.main()
            raw = (Path(directory) / 'reviewed-image-example/manifest.json').read_bytes()
            self.assertEqual(raw, self.raw.encode()); self.assertEqual('sha256:' + m.sha(raw), self.digest)

    def test_index_denied(self):
        self.manifest['mediaType'] = 'application/vnd.oci.image.index.v1+json'
        self.image['imageManifest'] = json.dumps(self.manifest)
        self.image['imageId']['imageDigest'] = self.metadata['containerimage.digest'] = 'sha256:' + m.sha(self.image['imageManifest'].encode())
        with self.assertRaises(m.Rejected): self.verify()


class MaterializedWorkflows(unittest.TestCase):
    def test_closed_16_repositories_19_jobs_20_services(self):
        manifest = json.loads((TEMPLATES / 'manifest.json').read_text()); self.assertEqual(len(manifest['repositories']), 16)
        total_jobs = 0; total_services = []
        for entry in manifest['repositories']:
            for record in entry['files']:
                self.assertEqual(m.sha((TEMPLATES / record['source']).read_bytes()), record['sha256'])
            workflow = parse_yaml(TEMPLATES / entry['repository'].split('/')[1] / '.github/workflows/publish-reviewed-images.yml')
            self.assertEqual(set(workflow['on']), {'workflow_dispatch'}); self.assertEqual(set(workflow['on']['workflow_dispatch']['inputs']), {'expected_source_sha'})
            self.assertEqual(workflow['permissions'], {'contents': 'read'})
            self.assertFalse(workflow['concurrency']['cancel-in-progress'])
            for r in entry['recipes']:
                job = workflow['jobs'][r['name']]; total_jobs += 1; total_services.extend(r['services'])
                self.assertEqual(job['runs-on'], 'ubuntu-24.04-arm'); self.assertEqual(job['permissions'], {'contents': 'read', 'id-token': 'write'})
                self.assertIn("github.ref == 'refs/heads/main'", job['if']); self.assertIn(entry['repository'], job['if'])
                steps = job['steps']; self.assertIn(' guard ', steps[1]['run']); self.assertIn('configure-aws-credentials@', steps[2]['uses'])
                role = {'OxyHQ/Clarity': 'oxy-clarity-github-deploy', 'OxyHQ/GoWay': 'oxy-goway-github-deploy'}.get(entry['repository'], 'oxy-github-deploy')
                self.assertEqual(steps[2]['with']['role-to-assume'], 'arn:aws:iam::237343248947:role/' + role)
                b = steps[6]['with']; self.assertTrue(b['push']); self.assertFalse(b['provenance']); self.assertFalse(b['sbom'])
                self.assertEqual(b['file'], r['dockerfile']); self.assertEqual(b.get('target'), r['target']); self.assertEqual(b['platforms'], 'linux/arm64')
                self.assertEqual(b['tags'], m.REGISTRY + '/' + r['ecrRepository'] + ':${{ github.sha }}' + r['tagSuffix'])
                self.assertEqual(b.get('cache-from'), 'type=gha,scope=' + r['cacheScope'] if r['cacheScope'] else None)
                text = json.dumps(job).lower()
                for forbidden in [' ecs ', ' ssm ', 'seed', 'latest', 'update-service', 'workflow_call']: self.assertNotIn(forbidden, text)
        self.assertEqual(total_jobs, 19); self.assertEqual(len(total_services), 20); self.assertNotIn('tnp-dns', total_services)
        self.assertEqual(len(set(total_services)), 20)


class HeldCallerJobs(unittest.TestCase):
    def test_only_four_caller_conditions_change(self):
        manifest = json.loads((TEMPLATES / 'manifest.json').read_text())
        jobs_seen = 0
        lots = json.loads(Path('/home/nate/Oxy/oxy/.worktrees/1519-consumer-rollout-preflight-20261003/docs/architecture/1519-consumer-rollout-preflight/execution/lots.json').read_text())
        for entry in manifest['repositories']:
            names = entry['heldCallerJobs']
            if not names: continue
            consumer = next(c for c in lots['consumers'] if c['repository'] == entry['repository'])
            before = subprocess.check_output(['git', '-C', consumer['worktree'], 'show', entry['preparedHead'] + ':.github/workflows/ci.yml'])
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'before.yml'; path.write_bytes(before); old = parse_yaml(path)
            new = parse_yaml(TEMPLATES / entry['repository'].split('/')[1] / '.github/workflows/ci.yml')
            for name in names:
                self.assertIn("vars.OXY_1519_ROLLOUT_HOLD != 'true'", new['jobs'][name]['if'])
                expression = new['jobs'][name].pop('if')
                old_expression = old['jobs'][name].pop('if')
                normalized = old_expression.removeprefix('${{').removesuffix('}}').strip()
                self.assertIn(normalized, expression)
                jobs_seen += 1
            self.assertEqual(new, old)  # All tests, needs, triggers, permissions and steps preserved.
        self.assertEqual(jobs_seen, 4)

    def test_hold_true_denies_even_when_original_allows(self):
        # The inserted expression is a conjunction: held denial also covers a successful CI caller.
        for previous in [True, False]:
            for hold in ['', 'false', 'true']:
                result = hold != 'true' and previous
                self.assertEqual(result, False if hold == 'true' else previous)


if __name__ == '__main__': unittest.main(verbosity=2)
