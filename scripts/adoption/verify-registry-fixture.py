#!/usr/bin/env python3
"""Read-only registry/member/resolver verification, run AFTER registry-ready install."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import base64
import hashlib
import urllib.parse
spec = importlib.util.spec_from_file_location('adoption', Path(__file__).with_name('final-registry-consumers.py'))
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)
TARGETS = {'@oxy.so/core': '4.2.0', '@oxy.so/contracts': '4.9.0', '@oxy.so/protocol': '1.2.2', '@oxy.so/services': '11.1.0', '@oxy.so/telemetry': '1.2.0', '@oxy.so/bloom': '6.2.1', '@oxy.so/app-preset': '3.0.0'}
RESOLVE = r'''const fs=require('node:fs'),path=require('node:path');const {createRequire}=require('node:module');
const root=fs.realpathSync(process.argv[1]); const names=JSON.parse(process.argv[2]);
function pkg(importer,name){const req=createRequire(importer); let p;try{p=path.dirname(req.resolve(name+'/package.json'))}catch{p=path.dirname(req.resolve(name))}while(true){const f=path.join(p,'package.json');if(fs.existsSync(f)&&JSON.parse(fs.readFileSync(f)).name===name)return fs.realpathSync(p);const parent=path.dirname(p);if(parent===p)throw Error('Package root unavailable');p=parent}}
const app=path.join(root,'package.json');const imported=names.map(n=>pkg(app,n));const importers=[app,...imported.map(p=>path.join(p,'package.json'))];const records=[];
for(const importer of importers){const j=JSON.parse(fs.readFileSync(importer));for(const name of names){if(importer!==app&&!Object.hasOwn({...j.dependencies,...j.peerDependencies},name))continue;const resolved=pkg(importer,name);if(!resolved.startsWith(root+'/node_modules/'))throw Error('Resolution outside fixture'); records.push({importer:path.relative(root,importer),name,root:resolved});}}
process.stdout.write(JSON.stringify(records));'''

def verify(fixture):
    fixture = fixture.resolve()
    manifest = json.loads((fixture/'package.json').read_text())
    for section in ['dependencies', 'devDependencies']:
        shared.require(all(not v.startswith(('file:', 'workspace:', 'catalog:')) for v in manifest.get(section, {}).values()), 'Local dependency protocol refused')
    records=json.loads(subprocess.check_output(['node','-e',RESOLVE,str(fixture),json.dumps(list(TARGETS))],text=True,timeout=30))
    artifacts={}
    for name,version in TARGETS.items():
        metadata=json.loads(shared.download('https://registry.npmjs.org/'+urllib.parse.quote(name,safe='')+'/'+version,4*1024*1024))
        archive=shared.download(metadata['dist']['tarball'],128*1024*1024)
        integrity='sha512-'+base64.b64encode(hashlib.sha512(archive).digest()).decode()
        shared.require(metadata['name']==name and metadata['version']==version and integrity in metadata['dist']['integrity'].split(), 'Registry identity/integrity mismatch')
        artifacts[name]={'version':version,'integrity':integrity,'sha256':shared.sha(archive),'members':shared.member_hashes(archive)}
    for record in records:
        expected=artifacts[record['name']];installed=Path(record['root'])
        shared.require(json.loads((installed/'package.json').read_text())['version']==expected['version'],'Installed version mismatch')
        for rel,digest in expected['members'].items():
            shared.require(shared.sha((installed/rel).read_bytes())==digest,'Installed package bytes differ')
        record.update(version=expected['version'],files=len(expected['members']),allFilesEqual=True)
    for name in TARGETS:
        shared.require(len({r['root'] for r in records if r['name']==name})==1,'Multiple installed package instances')
    return {'fixture':str(fixture),'lockSha256':shared.sha((fixture/'bun.lock').read_bytes()),'artifacts':{n:{k:v for k,v in a.items() if k!='members'} for n,a in artifacts.items()},'resolvers':records,'runtimeTested':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--fixture',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    shared.write(args.output,verify(args.fixture))
