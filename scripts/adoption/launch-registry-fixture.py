#!/usr/bin/env python3
"""Owned RP/Metro launch after artifact verification. No installs, ADB, API or DB writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time


def command_for(kind, lane, fixture, manifest):
    if not manifest.get('fixtureOnly') or manifest['origins']['api']!='http://127.0.0.1:17960' or manifest['origins']['idp']!='http://127.0.0.1:17961':
        raise ValueError('Unexpected fixture authority')
    env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')}
    env.update(BUN_OPTIONS='--no-env-file',EXPO_NO_DOTENV='1',CI='1')
    if kind=='native':
        variants={'mention':('nativeFirst',17977),'allo':('nativeSecond',17978)}
        client,port=variants[lane]
        env.update(EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE='1',EXPO_PUBLIC_OXY_NATIVE_SIBLING=lane,
                   EXPO_PUBLIC_OXY_CLIENT_ID=manifest['clients'][client]['clientId'])
        args=['bun','--no-env-file',str(fixture/'node_modules/expo/bin/cli'),'start','--localhost','--port',str(port)]
    else:
        if lane not in ('webFirst','webSecond','a','b'):raise ValueError('Unregistered RP lane')
        client=manifest['clients'][lane]
        # Never invent a redirect to get a free port. Root releases this exact RP first.
        from urllib.parse import urlparse
        origin=urlparse(client['origin']);port=origin.port
        if origin.scheme!='http' or origin.hostname!='127.0.0.1' or port not in (17962,17963,17972,17973) or client['redirectUri']!=client['origin']+'/':
            raise ValueError('Registered RP origin differs')
        env.update(VITE_OXY_CLIENT_ID=client['clientId'],VITE_FIXTURE_LANE=lane)
        args=['bun','--no-env-file',str(fixture/'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',str(port),'--strictPort']
    if not (env.get('EXPO_PUBLIC_OXY_CLIENT_ID') or env.get('VITE_OXY_CLIENT_ID','')).startswith('oxy_dk_'):
        raise ValueError('Expected registered public client')
    return args,env,port


def main():
    p=argparse.ArgumentParser();p.add_argument('--kind',choices=['native','web'],required=True);p.add_argument('--lane',required=True)
    p.add_argument('--fixture',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--verified-receipt',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--launch',action='store_true');a=p.parse_args()
    fixture=a.fixture.resolve();receipt_bytes=a.verified_receipt.read_bytes();receipt=json.loads(receipt_bytes)
    manifest_bytes=a.manifest.read_bytes()
    if receipt['fixture']!=str(fixture) or receipt['lockSha256']!=hashlib.sha256((fixture/'bun.lock').read_bytes()).hexdigest():raise ValueError('Verified installation changed')
    args,env,port=command_for(a.kind,a.lane,fixture,json.loads(manifest_bytes))
    with socket.socket() as probe:probe.bind(('127.0.0.1',port))
    a.output.mkdir(mode=0o700,parents=False,exist_ok=False)
    intent={'kind':a.kind,'lane':a.lane,'fixture':str(fixture),'port':port,'command':args,'manifestSha256':hashlib.sha256(manifest_bytes).hexdigest(),'verifiedReceiptSha256':hashlib.sha256(receipt_bytes).hexdigest(),'launch':a.launch}
    def write(name,value):
        fd=os.open(a.output/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w') as stream:json.dump(value,stream,indent=2);stream.write('\n')
    write('intent.json',intent)
    if not a.launch:return
    stopping=False
    def stop(_signal,_frame):
        nonlocal stopping
        stopping=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    child=None
    fd=os.open(a.output/'process.log',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as log:
        try:
            child=subprocess.Popen(args,cwd=fixture,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            write('started.json',{'pid':child.pid,'port':port,'deviceUntouched':True,'runtimeAcceptancePending':True})
            while not stopping:
                if child.poll() is not None:raise RuntimeError('Fixture process exited; inspect private log')
                time.sleep(.5)
        finally:
            forced=False
            if child and child.poll() is None:
                try:os.killpg(child.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    forced=True
                    try:os.killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    child.wait(timeout=10)
            write('stopped.json',{'pid':child.pid if child else None,'forced':forced,'apiIdpDatabaseDeviceUntouched':True})

if __name__=='__main__':main()
