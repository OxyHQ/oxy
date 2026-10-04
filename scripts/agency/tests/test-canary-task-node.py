#!/usr/bin/env python3
"""Actual generated Node entrypoint and compiled API, own PG only; no AWS/HTTPS."""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('canary_entry_transport', ROOT/'scripts/agency/alia-revocation-canary-ecs.py')
m = importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PG = Path('/usr/lib/postgresql/17/bin');PORT=5616


def env():
    return {k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')} | {'BUN_OPTIONS':'--no-env-file'}


def run(args, **kwargs):
    return subprocess.check_output([str(a) for a in args],env=env(),text=True,stderr=subprocess.STDOUT,**kwargs)


def main():
    if len(sys.argv)!=1: raise RuntimeError('No connection/runtime overrides accepted')
    scratch=Path('/home/nate/Oxy/.agent-evidence/i03-canary-task-node');scratch.mkdir(exist_ok=True)
    owned=Path(tempfile.mkdtemp(prefix='pg-',dir=scratch));data=owned/'data'; started=int(time.time()); running=False
    print(run([PG/'initdb','-D',data,'-U','oxy','-A','trust','--no-locale']))
    try:
        print(run([PG/'pg_ctl','-D',data,'-l',owned/'server.log','-w','-o',f'-h 127.0.0.1 -p {PORT} -k {owned}','start']));running=True
        lines=(data/'postmaster.pid').read_text().splitlines();pid=int(lines[0])
        assert Path(lines[1]).resolve()==data.resolve() and int(lines[2])>=started and int(lines[3])==PORT
        assert Path(f'/proc/{pid}').stat().st_uid==os.getuid()
        assert Path(f'/proc/{pid}/exe').resolve()==(PG/'postgres').resolve()
        args=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0');assert b'-D' in args and str(data).encode() in args
        sockets={os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}
        listeners=[r.split() for r in Path('/proc/net/tcp').read_text().splitlines()[1:]]
        rows=[r for r in listeners if r[1]==f'0100007F:{PORT:04X}' and r[3]=='0A']
        assert len(rows)==1 and f'socket:[{rows[0][9]}]' in sockets
        def sql(query,database='postgres'):
            return run([PG/'psql','-X','-h','127.0.0.1','-p',PORT,'-U','oxy','-d',database,'-v','ON_ERROR_STOP=1','-Atc',query]).strip()
        assert Path(sql("SELECT current_setting('data_directory')")).resolve()==data.resolve()
        database='oxy_canary_transport_'+secrets.token_hex(8);sql(f'CREATE DATABASE "{database}"')
        node_env=env()|{'NODE_ENV':'production','DATABASE_URL':f'postgresql://oxy@127.0.0.1:{PORT}/{database}','OXY_API_URL':'https://api.oxy.so'}
        api=ROOT/'packages/api'
        def command(args,name):
            result=subprocess.run(args,cwd=api,env=node_env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (owned/name).write_text(result.stdout);result.check_returncode();return result.stdout
        for phase in ('fresh','repeat'):command(['bun','--no-env-file','run','db:migrate'],'migrate-'+phase+'.log')
        seeded=command(['node',str(ROOT/'scripts/agency/tests/canary-task-node-seed.mjs')],'seed.log')
        seed=json.loads(next(line.split(' ',1)[1] for line in seeded.splitlines() if line.startswith('CANARY_NODE_SEED ')))
        import hashlib
        runtime={p:hashlib.sha256((api/p).read_bytes()).hexdigest() for p in m.COMPILED_PATHS}
        actor=seed['canaryPlan']['operator'];results=[]
        staged_path=api/'dist/services/alia-canary-operational-46c15e4b6d3492b57df3f459abd72e5193e83c61ec2ada93e0935c31dbef98a9.cjs'
        assert not staged_path.exists()
        for operation in ('prepare','recover'):
            payload={'nonce':'e'*32,'operation':operation,'operator':actor,'principalId':seed['principalId'] if operation=='prepare' else None,
                'canaryPlan':seed['canaryPlan'] if operation=='recover' else None,'runtimeSha256':runtime}
            code=m.invocation(payload);(owned/(operation+'.mjs')).write_text(code)
            output=command(['node','--input-type=module','-e',code],operation+'.log')
            record=json.loads(next(line[len(m.PREFIX):] for line in output.splitlines() if line.startswith(m.PREFIX)))
            assert record['operation']==operation and record['nonce']==payload['nonce'];results.append(record)
            assert not staged_path.exists(), 'Owned operational module was not cleaned'
            assert {p:hashlib.sha256((api/p).read_bytes()).hexdigest() for p in m.COMPILED_PATHS}==runtime
        bad = dict(payload); bad['runtimeSha256'] = {**runtime, m.COMPILED_PATHS[0]:'0'*64}
        rejected=subprocess.run(['node','--input-type=module','-e',m.invocation(bad)],cwd=api,env=node_env,
            text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (owned/'runtime-pin-rejected.log').write_text(rejected.stdout)
        assert rejected.returncode==1 and m.PREFIX not in rejected.stdout
        assert 'ALIA_CANARY_TASK_FAILED_RECONCILE_DURABLE_INTENT' in rejected.stdout
        assert not staged_path.exists()
        with staged_path.open('xb') as sentinel: sentinel.write(b'existing-owned-fixture')
        try:
            collision=subprocess.run(['node','--input-type=module','-e',m.invocation(payload)],cwd=api,env=node_env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (owned/'staging-collision-rejected.log').write_text(collision.stdout)
            assert collision.returncode==1 and m.PREFIX not in collision.stdout
            assert staged_path.read_bytes()==b'existing-owned-fixture'
        finally:
            assert staged_path.read_bytes()==b'existing-owned-fixture';staged_path.unlink()
        assert results[1]['result']['cleanupConfirmed'] and results[1]['result']['authorityUnchanged']
        status=sql(f"SELECT status FROM application_credentials WHERE id='{seed['canaryPlan']['credentialId']}'",database);assert status=='revoked'
        assert sql(f"SELECT count(*) FROM application_credential_audit_events WHERE credential_id='{seed['canaryPlan']['credentialId']}'",database)=='2'
        sql(f'DROP DATABASE "{database}"')
        print(json.dumps({'kind':'generated-node-canary-entrypoint','pid':pid,'ownedDirectory':str(owned),'compiledImageLayoutRelocatedOnlyByCwd':True,
            'nodeEnv':'production','phases':['prepare','recover'],'checks':8,'runtimePinRejectedBeforeOperation':True,'databaseDropped':True,'awsRequests':0,'providerRequests':0}))
    finally:
        if running:
            print(run([PG/'pg_ctl','-D',data,'-m','fast','-w','stop']));assert not Path(f'/proc/{pid}').exists()


if __name__=='__main__':main()
