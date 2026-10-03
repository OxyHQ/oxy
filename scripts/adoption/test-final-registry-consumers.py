#!/usr/bin/env python3
"""Offline fixtures only; no registry, consumer, or production effects."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('adoption', Path(__file__).with_name('final-registry-consumers.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def archive(value=b'{}', name='package/package.json', duplicate=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        for _ in range(2 if duplicate else 1):
            info=tarfile.TarInfo(name);info.size=len(value);tar.addfile(info,io.BytesIO(value))
    return output.getvalue()

class Fixtures(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        subprocess.run(['git','init','-q','-b','fixture'],cwd=self.root,check=True)
        subprocess.run(['git','config','user.name','Local Fixture'],cwd=self.root,check=True)
        subprocess.run(['git','config','user.email','fixture@invalid'],cwd=self.root,check=True)
        (self.root/'package.json').write_text('{"name":"fixture","version":"1"}\n')
        subprocess.run(['git','add','package.json'],cwd=self.root,check=True)
        subprocess.run(['git','commit','-qm','fixture'],cwd=self.root,check=True)
        p=self.root/'patch';p.write_text('--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{"name":"fixture","version":"1"}\n+{"name":"fixture","version":"2"}\n')
        self.row={'repository':'OxyHQ/fixture','worktree':str(self.root),'branch':'fixture','preparedHead':m.command(['git','rev-parse','HEAD'],self.root),'manifestPatch':{'path':str(p),'sha256':m.sha(p.read_bytes()),'changes':[{'path':'package.json','before':m.sha((self.root/'package.json').read_bytes()),'after':m.sha(b'{"name":"fixture","version":"2"}\n')}]}}
    def tearDown(self):self.temp.cleanup()
    def test_dry_preflight_changes_nothing(self):
        before=(self.root/'package.json').read_bytes();m.preflight(self.row)
        self.assertEqual((self.root/'package.json').read_bytes(),before)
    def test_changed_head_branch_manifest_or_patch_refuses(self):
        for field in ('preparedHead','branch'):
            with self.assertRaises(RuntimeError):m.preflight(self.row|{field:'different'})
        (self.root/'package.json').write_text('{}')
        with self.assertRaises(RuntimeError):m.preflight(self.row)
    def test_archive_rejects_traversal_and_duplicates(self):
        for data in [archive(name='package/../escape'),archive(duplicate=True)]:
            with self.assertRaises(RuntimeError):m.member_hashes(data)
        self.assertEqual(m.member_hashes(archive()),{'package.json':m.sha(b'{}')})
    def fixture_registry(self, mutate=None):
        data=archive();candidate=self.root/'candidate.tgz';candidate.write_bytes(data)
        plan={'targetVersions':{name:'1.0.0' for name in m.SDK},'sdkCandidate':'source'}
        candidates=[{'name':name,'version':'1.0.0','source':'source','path':str(candidate),'sha256':m.sha(data)} for name in m.SDK]
        def download(url,limit):
            if mutate=='missing':raise RuntimeError('Registry version absent')
            if url.endswith('.tgz'):return archive(b'{"changed":true}') if mutate=='members' else data
            name=__import__('urllib').parse.unquote(url.split('/')[-2])
            integrity='sha512-'+base64.b64encode(hashlib.sha512(archive(b'{"changed":true}') if mutate=='members' else data).digest()).decode()
            return json.dumps({'name':name,'version':'1.0.0','dist':{'tarball':'https://registry.npmjs.org/x.tgz','integrity':'sha512-bad' if mutate=='integrity' else integrity}}).encode()
        with patch.object(m,'download',side_effect=download):return m.verify_registry(plan,candidates,self.root)
    def test_all_five_registry_packages_must_match(self):self.assertEqual(len(self.fixture_registry()),5)
    def test_registry_integrity_mismatch_fails_closed(self):
        with self.assertRaises(RuntimeError):self.fixture_registry('integrity')
    def test_registry_member_change_fails_closed(self):
        with self.assertRaises(RuntimeError):self.fixture_registry('members')
    def test_missing_registry_version_never_installs(self):
        with patch.object(m,'install',side_effect=AssertionError('no writes')):
            with self.assertRaises(RuntimeError):self.fixture_registry('missing')
    def test_new_main_commit_requires_reconciliation(self):
        subprocess.run(['git','checkout','-qb','main'],cwd=self.root,check=True)
        (self.root/'new-runtime').write_text('preserve this')
        subprocess.run(['git','add','new-runtime'],cwd=self.root,check=True)
        subprocess.run(['git','commit','-qm','new main'],cwd=self.root,check=True)
        subprocess.run(['git','checkout','-q','fixture'],cwd=self.root,check=True)
        subprocess.run(['git','remote','add','origin',str(self.root)],cwd=self.root,check=True)
        with self.assertRaisesRegex(RuntimeError,'Main advanced'):m.preflight(self.row,check_main=True)

    def test_actual_node_importer_resolution_and_member_check(self):
        package=self.root/'node_modules/@oxy.so/core';package.mkdir(parents=True)
        files={'package.json':b'{"name":"@oxy.so/core","version":"4.2.0","main":"index.js"}', 'index.js':b'module.exports={}'}
        for name,data in files.items():(package/name).write_bytes(data)
        (self.root/'package.json').write_text('{"dependencies":{"@oxy.so/core":"4.2.0"}}')
        registry=[{'name':'@oxy.so/core','version':'4.2.0','memberHashes':{name:m.sha(data) for name,data in files.items()}}]
        self.assertEqual(m.verify_installed(self.row,registry)[0]['files'],2)
        (package/'index.js').write_text('changed')
        with self.assertRaises(RuntimeError):m.verify_installed(self.row,registry)

    def test_explicit_nested_workspace_importer_is_discovered(self):
        (self.root/'package.json').write_text('{"workspaces":["packages/*","packages/extension/webview-ui"]}')
        nested=self.root/'packages/extension/webview-ui';nested.mkdir(parents=True)
        (nested/'package.json').write_text('{"name":"nested","dependencies":{"@oxy.so/core":"4.2.0"}}')
        self.assertIn(nested/'package.json',m.importer_manifests(self.root))

    def test_foreign_registry_origin_refuses_before_network(self):
        with self.assertRaises(RuntimeError):m.download('https://foreign.invalid/pkg.tgz',100)

    def test_private_receipt_no_overwrite(self):
        path=self.root/'receipt';m.write(path,{'first':True})
        with self.assertRaises(FileExistsError):m.write(path,{'first':False})
        self.assertEqual(path.stat().st_mode & 0o777,0o600)

if __name__=='__main__':unittest.main()
