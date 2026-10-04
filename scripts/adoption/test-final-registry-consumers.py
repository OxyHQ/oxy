#!/usr/bin/env python3
"""Offline fixtures only; no registry, consumer, or production effects."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import shutil
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

    def sdk_graph(self, edge='dependencies', cycle=False):
        names=['services','core','contracts','protocol']
        self.sdk_files={}; registry=[]
        for name in names:
            manifest={'name':'@oxy.so/'+name,'version':'1.0.0','main':'index.js'}
            children={'services':['core'],'core':['contracts','protocol']}.get(name,[])
            if cycle and name=='protocol':children=['services']
            if children:manifest[edge]={'@oxy.so/'+child:'1.0.0' for child in children}
            files={'package.json':json.dumps(manifest).encode(),'index.js':b'module.exports={}'}
            self.sdk_files[name]=files
            self.put_sdk(self.root,name)
            registry.append({'name':manifest['name'],'version':'1.0.0','memberHashes':{k:m.sha(v) for k,v in files.items()}})
        (self.root/'package.json').write_text(json.dumps({'dependencies':{'@oxy.so/services':'1.0.0','@oxy.so/core':'1.0.0'}}))
        return registry

    def put_sdk(self, parent, name):
        package=parent/'node_modules/@oxy.so'/name;package.mkdir(parents=True,exist_ok=True)
        for rel,data in self.sdk_files[name].items():(package/rel).write_bytes(data)
        return package

    def test_nested_sdk_wrong_version_rejected(self):
        registry=self.sdk_graph();nested=self.put_sdk(self.root/'node_modules/@oxy.so/services','core')
        manifest=json.loads((nested/'package.json').read_text());manifest['version']='0.9.0';(nested/'package.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError,'version differs'):m.verify_installed(self.row,registry)

    def test_nested_sdk_same_version_changed_member_rejected(self):
        registry=self.sdk_graph();nested=self.put_sdk(self.root/'node_modules/@oxy.so/services','core');(nested/'index.js').write_text('altered')
        with self.assertRaisesRegex(RuntimeError,'member differs'):m.verify_installed(self.row,registry)

    def test_transitive_only_contracts_and_protocol_are_checked(self):
        registry=self.sdk_graph()
        for name in ['contracts','protocol']:
            with self.subTest(name=name):
                member=self.root/'node_modules/@oxy.so'/name/'index.js';original=member.read_bytes();member.write_text('altered')
                with self.assertRaisesRegex(RuntimeError,'member differs'):m.verify_installed(self.row,registry)
                member.write_bytes(original)

    def test_sdk_peer_and_optional_edges_checked(self):
        for edge in ['peerDependencies','optionalDependencies']:
            with self.subTest(edge=edge):
                registry=self.sdk_graph(edge);(self.root/'node_modules/@oxy.so/protocol/index.js').write_text('altered')
                with self.assertRaisesRegex(RuntimeError,'member differs'):m.verify_installed(self.row,registry)

    def test_hoisted_graph_records_parent_child_edges(self):
        receipts=m.verify_installed(self.row,self.sdk_graph())
        edges={(x['importer'],x['name']) for x in receipts}
        self.assertIn(('node_modules/@oxy.so/services/package.json','@oxy.so/core'),edges)
        self.assertIn(('node_modules/@oxy.so/core/package.json','@oxy.so/contracts'),edges)
        self.assertIn(('node_modules/@oxy.so/core/package.json','@oxy.so/protocol'),edges)

    def test_identical_nested_copy_and_cycle_terminate(self):
        registry=self.sdk_graph(cycle=True);self.put_sdk(self.root/'node_modules/@oxy.so/services','core')
        receipts=m.verify_installed(self.row,registry)
        self.assertEqual(len({x['root'] for x in receipts}),5)
        self.assertTrue(all(x['allFilesEqual'] for x in receipts))
        self.assertLess(len(receipts),12)

    def test_required_transitive_dependency_absent_rejected(self):
        registry=self.sdk_graph();shutil.rmtree(self.root/'node_modules/@oxy.so/protocol')
        with self.assertRaisesRegex(RuntimeError,'Required SDK dependency is absent'):
            m.verify_installed(self.row,registry)

    def test_optional_absence_has_explicit_disposition_not_member_claim(self):
        registry=self.sdk_graph('optionalDependencies');shutil.rmtree(self.root/'node_modules/@oxy.so/protocol')
        rows=m.verify_installed(self.row,registry);absent=[x for x in rows if x.get('status')=='optional-absent']
        self.assertEqual(len(absent),1);self.assertEqual(absent[0]['name'],'@oxy.so/protocol')
        self.assertNotIn('allFilesEqual',absent[0])

    def test_present_broken_optional_entrypoint_does_not_count_as_absent(self):
        registry=self.sdk_graph('optionalDependencies');(self.root/'node_modules/@oxy.so/protocol/index.js').unlink()
        with self.assertRaises(subprocess.CalledProcessError):m.verify_installed(self.row,registry)

    def test_transitive_package_requires_verified_registry_record(self):
        registry=self.sdk_graph();registry=[x for x in registry if x['name']!='@oxy.so/protocol']
        with self.assertRaisesRegex(RuntimeError,'lacks verified registry artifact'):
            m.verify_installed(self.row,registry)

    def test_foreign_registry_origin_refuses_before_network(self):
        with self.assertRaises(RuntimeError):m.download('https://foreign.invalid/pkg.tgz',100)

    def test_private_receipt_no_overwrite(self):
        path=self.root/'receipt';m.write(path,{'first':True})
        with self.assertRaises(FileExistsError):m.write(path,{'first':False})
        self.assertEqual(path.stat().st_mode & 0o777,0o600)

if __name__=='__main__':unittest.main()
