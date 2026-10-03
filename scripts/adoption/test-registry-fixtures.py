#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('materialize',ROOT/'materialize-registry-fixture.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Fixtures(unittest.TestCase):
    def test_materializes_only_into_new_standalone_directory(self):
        with tempfile.TemporaryDirectory() as parent:
            output=Path(parent)/'native';receipt=m.materialize('native',output)
            self.assertFalse(receipt['installed']);self.assertFalse((output/'node_modules').exists())
            self.assertEqual((output/'package.json').stat().st_mode&0o777,0o600)
            with self.assertRaises(FileExistsError):m.materialize('native',output)
    def test_refuses_workspace_ancestors(self):
        with tempfile.TemporaryDirectory() as parent:
            p=Path(parent);(p/'package.json').write_text('{}')
            with self.assertRaises(ValueError):m.materialize('web',p/'child')
    def test_preserved_sources_and_no_sdk_aliases(self):
        import hashlib
        records=json.loads((ROOT/'registry-fixtures/preserved-inputs.json').read_text())['records']
        for record in records:
            target=ROOT.parents[1]/record['target']
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(),record['sha256'])
        for kind in ['native','web']:
            manifest=json.loads((ROOT/f'registry-fixtures/{kind}/package.json').read_text())
            for section in ['dependencies','devDependencies']:
                for version in manifest.get(section,{}).values():self.assertFalse(version.startswith(('file:','workspace:','catalog:')))
            self.assertEqual(manifest['dependencies']['@oxy.so/core'],'4.2.0')
            self.assertEqual(manifest['dependencies']['@oxy.so/services'],'11.1.0')
            self.assertEqual(manifest['dependencies']['@oxy.so/bloom'],'6.2.1')
    def test_metro_refuses_external_resolution_preserves_preset(self):
        script=r'''const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(process.argv[1],'utf8');const dir='/owned/fixture';let target=dir+'/node_modules/@oxy.so/core/lib/index.js',records=[];
const base={watchFolders:['/unsafe'],resolver:{nodeModulesPaths:['/unsafe/node_modules'],extraNodeModules:{'@oxy.so/core':'/unsafe/source'},resolveRequest:()=>({type:'sourceFile',filePath:target})}};
const ctx={__dirname:dir,module:{exports:{}},Set,require:(id)=>id==='node:path'?path:id==='node:fs'?{realpathSync:p=>p,appendFileSync:(_p,s)=>records.push(s)}:{createOxyMetroConfig:()=>base}};vm.runInNewContext(source,ctx);const c=ctx.module.exports;
if(c.watchFolders.length||c.resolver.nodeModulesPaths.join()!==dir+'/node_modules'||Object.keys(c.resolver.extraNodeModules).length)throw Error('isolation config');
c.resolver.resolveRequest({originModulePath:dir+'/entry.tsx'},'@oxy.so/core','android');if(records.length!==1)throw Error('missing resolver receipt');
target='/outside/core.js';let refused=false;try{c.resolver.resolveRequest({},'@oxy.so/core','android')}catch{refused=true}if(!refused)throw Error('escaped');'''
        subprocess.run(['node','-e',script,str(ROOT/'registry-fixtures/native/metro.config.js')],check=True)
    def test_package_root_resolver_rejects_ancestor_node_modules(self):
        spec=importlib.util.spec_from_file_location('verify',ROOT/'verify-registry-fixture.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
        with tempfile.TemporaryDirectory() as parent:
            p=Path(parent);fixture=p/'fixture';fixture.mkdir();(fixture/'package.json').write_text('{}')
            pkg=p/'node_modules/@oxy.so/core';pkg.mkdir(parents=True);(pkg/'package.json').write_text('{"name":"@oxy.so/core","version":"4.2.0","main":"index.js"}');(pkg/'index.js').write_text('')
            result=subprocess.run(['node','-e',v.RESOLVE,str(fixture),'["@oxy.so/core"]'],capture_output=True)
            self.assertNotEqual(result.returncode,0);self.assertIn(b'Resolution outside fixture',result.stderr)
    def test_launch_uses_public_manifest_and_exact_ports_without_secret_environment(self):
        import os
        from unittest.mock import patch
        spec=importlib.util.spec_from_file_location('launch',ROOT/'launch-registry-fixture.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
        manifest={'fixtureOnly':True,'origins':{'api':'http://127.0.0.1:17960','idp':'http://127.0.0.1:17961'},'clients':{'nativeFirst':{'clientId':'oxy_dk_fixture'},'webFirst':{'clientId':'oxy_dk_fixture','origin':'http://127.0.0.1:17972','redirectUri':'http://127.0.0.1:17972/'}}}
        with patch.dict(os.environ,{'SECRET_CANARY':'must-not-inherit','DATABASE_URL':'must-not-inherit'}):
            args,env,port=v.command_for('native','mention',Path('/fixture'),manifest)
        self.assertEqual(port,17977);self.assertNotIn('SECRET_CANARY',env);self.assertNotIn('DATABASE_URL',env);self.assertEqual(env['EXPO_NO_DOTENV'],'1');self.assertIn('--no-env-file',args)
        self.assertEqual(v.command_for('web','webFirst',Path('/fixture'),manifest)[2],17972)
        manifest['clients']['webFirst']['redirectUri']='http://127.0.0.1:17982/'
        with self.assertRaises(ValueError):v.command_for('web','webFirst',Path('/fixture'),manifest)
if __name__=='__main__':unittest.main()
