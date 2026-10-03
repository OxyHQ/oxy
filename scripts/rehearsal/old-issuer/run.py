#!/usr/bin/env python3
"""Owned local old/final runtime rehearsal. No DB URL or remote override accepted."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
OLD = ROOT.parent / '1519-old-issuer-runtime-20261003'
OLD_SHA = '67c09e853db308d102624a2ffd40db19959344f4'
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5599

def main():
    assert len(os.sys.argv) == 1, 'No connection/runtime overrides'
    os.umask(0o077)
    for source in [ROOT,OLD]:
        assert not (source/'.env').exists() and not (source/'packages/api/.env').exists()
    env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','LC_ALL')}
    env['BUN_OPTIONS'] = '--no-env-file'
    def command(args, cwd=ROOT, extra=None, timeout=120):
        return subprocess.check_output([str(x) for x in args],cwd=cwd,env=env | (extra or {}),text=True,stderr=subprocess.STDOUT,timeout=timeout)
    assert command(['git','rev-parse','HEAD'],OLD).strip() == OLD_SHA
    assert command(['git','status','--porcelain'],OLD) == ''
    scratch=ROOT/'.integration-evidence'; scratch.mkdir(exist_ok=True)
    owned=Path(tempfile.mkdtemp(prefix='rollback-',dir=scratch)); owned.chmod(0o700)
    sockets=Path(tempfile.mkdtemp(prefix='i04-rb-',dir='/home/nate/Oxy/.agent-evidence')); sockets.chmod(0o700)
    data=owned/'pg'; children=[]; logs=[]; started=False; database=None; pg_pid=None
    receipt={'oldSource':OLD_SHA,'finalSource':command(['git','rev-parse','HEAD']).strip(),'directory':str(owned),'productionAccess':False}
    def save(): (owned/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    def sql(query,db='postgres'):
        return command([PG/'psql','-X','-h','127.0.0.1','-p',PORT,'-U','oxy','-d',db,'-v','ON_ERROR_STOP=1','-Atc',query]).strip()
    def logged(args,name,cwd=ROOT,extra=None,timeout=180):
        result=subprocess.run([str(x) for x in args],cwd=cwd,env=env|(extra or {}),text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
        (owned/name).write_text(result.stdout); receipt[name]={'exitCode':result.returncode,'sha256':hashlib.sha256(result.stdout.encode()).hexdigest()};save()
        if result.returncode: raise RuntimeError(f'{name} failed; inspect owned private log')
    try:
        command([PG/'initdb','-D',data,'-U','oxy','-A','trust','--no-locale','--encoding=UTF8'])
        epoch=int(time.time())
        command([PG/'pg_ctl','-D',data,'-l',owned/'postgres.log','-w','-o',f'-h 127.0.0.1 -p {PORT} -k {sockets}','start']);started=True
        rows=(data/'postmaster.pid').read_text().splitlines();pg_pid=int(rows[0])
        assert Path(rows[1]).resolve()==data.resolve() and int(rows[2])>=epoch and int(rows[3])==PORT
        assert Path(rows[4]).resolve()==sockets.resolve()
        assert Path(f'/proc/{pg_pid}').stat().st_uid==os.getuid()
        assert Path(f'/proc/{pg_pid}/exe').resolve()==(PG/'postgres').resolve()
        fds={os.readlink(p) for p in Path(f'/proc/{pg_pid}/fd').iterdir()}
        listener=[r.split() for r in Path('/proc/net/tcp').read_text().splitlines()[1:] if r.split()[1]==f'0100007F:{PORT:04X}' and r.split()[3]=='0A']
        assert len(listener)==1 and f'socket:[{listener[0][9]}]' in fds
        assert Path(sql("select current_setting('data_directory')")).resolve()==data.resolve()
        database='oxy_rollback_'+secrets.token_hex(8);sql(f'CREATE DATABASE "{database}"')
        receipt.update(postgresPid=pg_pid,postgresData=str(data),database=database,port=PORT);save()
        redis_log=(owned/'redis.log').open('w');logs.append(redis_log)
        redis=subprocess.Popen(['/usr/bin/redis-server','--bind','127.0.0.1','--port','5598','--save','','--appendonly','no','--dir',str(owned)],env=env,stdout=redis_log,stderr=subprocess.STDOUT,start_new_session=True);children.append(redis)
        deadline=time.monotonic()+10
        while True:
            if redis.poll() is not None: raise RuntimeError('Own Redis exited before ready')
            try:
                if command(['redis-cli','-h','127.0.0.1','-p','5598','PING'],timeout=2).strip()=='PONG':break
            except subprocess.CalledProcessError:pass
            if time.monotonic()>deadline:raise RuntimeError('Own Redis readiness timeout')
            time.sleep(.1)
        assert Path(f'/proc/{redis.pid}').stat().st_uid==os.getuid()
        assert Path(f'/proc/{redis.pid}/exe').resolve()==Path('/usr/bin/redis-server').resolve()
        redis_sockets={os.readlink(p) for p in Path(f'/proc/{redis.pid}/fd').iterdir()}
        redis_listener=[r.split() for r in Path('/proc/net/tcp').read_text().splitlines()[1:] if r.split()[1]==f'0100007F:{5598:04X}' and r.split()[3]=='0A']
        assert len(redis_listener)==1 and f'socket:[{redis_listener[0][9]}]' in redis_sockets
        receipt['redis']={'pid':redis.pid,'port':5598,'persistence':False};save()
        signing_key=command(['openssl','genpkey','-algorithm','ED25519'])
        runtime={'SERVICE_TOKEN_SIGNING_KEY_ID':'rollback-owned','SERVICE_TOKEN_PRIVATE_KEY':signing_key,'CAPABILITY_TICKET_SIGNING_KEY_ID':'rollback-owned','CAPABILITY_TICKET_SIGNING_PRIVATE_KEY':signing_key,'REDIS_URL':'redis://127.0.0.1:5598', 'DATABASE_URL':f'postgresql://oxy@127.0.0.1:{PORT}/{database}','NODE_ENV':'test',
          'ACCESS_TOKEN_SECRET':'rollback-fixture-access-secret-only-64-characters-not-production',
          'REFRESH_TOKEN_SECRET':'rollback-fixture-refresh-secret-only-64-characters-not-production',
          'DEVICE_ID_SALT':'rollback-fixture-device-salt-only-64-characters-not-production',
          'AWS_REGION':'us-west-2','AWS_ACCESS_KEY_ID':'fixture-no-aws-key','AWS_SECRET_ACCESS_KEY':'fixture-no-aws-secret','AWS_S3_BUCKET':'fixture-no-bucket',
          'AUTH_WEB_ORIGIN':'http://127.0.0.1:17974','OXY_API_URL':'http://127.0.0.1:17975','ASSET_CDN_URL':'http://127.0.0.1:17975','LOG_LEVEL':'warn'}
        for phase in ['fresh','repeat']:
            assert not (ROOT/'packages/api/.env').exists()
            logged(['bun','--no-env-file','run','db:migrate'],f'migrate-{phase}.log',ROOT/'packages/api',runtime)
            assert sql('select count(*) from drizzle.__drizzle_migrations',database)=='142'
        manifest=owned/'fixture.private.json'
        logged(['bun','--no-env-file',ROOT/'scripts/rehearsal/old-issuer/probe.mjs','seed',manifest],'seed.log',extra=runtime)
        preserved=json.loads(manifest.read_text())['preservedTables']
        def census():
            records={}
            for table in preserved:
                assert table.replace('_','').isalnum()
                data=sql(f"SELECT coalesce(jsonb_agg(r ORDER BY r::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t) r FROM {table} t) q",database)
                rows=json.loads(data); assert rows, f'Empty preserved fixture {table}'
                records[table]={'rows':len(rows),'sha256':hashlib.sha256(data.encode()).hexdigest()}
            return records
        before=census();receipt['preservedBefore']=before;save()
        def host(label,source,port):
            ready=owned/f'{label}-ready.json'; log=(owned/f'{label}-host.log').open('w');logs.append(log)
            child=subprocess.Popen(['bun','--no-env-file',str(ROOT/'scripts/rehearsal/old-issuer/host.mjs'),str(source),str(port),str(ready)],cwd=owned,env=env|runtime|{'PORT':str(port)},stdout=log,stderr=subprocess.STDOUT,start_new_session=True);children.append(child)
            deadline=time.monotonic()+90
            while not ready.exists():
                if child.poll() is not None: raise RuntimeError(f'{label} exited before ready')
                if time.monotonic()>deadline: raise RuntimeError(f'{label} ready timeout')
                time.sleep(.1)
            r=json.loads(ready.read_text());assert r['pid']==child.pid and r['port']==port
            assert Path(f'/proc/{child.pid}').stat().st_uid==os.getuid()
            receipt[label]={'pid':child.pid,'executable':str(Path(f'/proc/{child.pid}/exe').resolve()),'source':str(source),'port':port};save()
            return child
        old_host=host('old',OLD,17974)
        host('final',ROOT,17975)
        logged(['bun','--no-env-file',ROOT/'scripts/rehearsal/old-issuer/probe.mjs','probe',manifest],'http-sql-probe.log',extra=runtime)
        os.killpg(old_host.pid,signal.SIGTERM);old_host.wait(timeout=15)
        assert old_host.returncode==0 and not Path(f'/proc/{old_host.pid}').exists()
        host('old-cold',OLD,17974)
        logged(['bun','--no-env-file',ROOT/'scripts/rehearsal/old-issuer/probe.mjs','cold',manifest],'cold-stop-control.log',extra=runtime)
        receipt['preservedAfter']=census();assert receipt['preservedAfter']==before
        for phase in ['seed','probe','cold']:
            assert json.loads(Path(str(manifest)+'.'+phase+'.external.json').read_text())['externalAttempts']==0
        for label in ['old','final','old-cold']:
            assert json.loads((owned/f'{label}-ready.json.external.json').read_text())['externalAttempts']==0
        receipt['externalAttempts']=0

        receipt['probePassed']=True
    finally:
        outcomes=[];cleanup_errors=[]
        for child in reversed(children):
            try:
                if child.poll() is None: os.killpg(child.pid,signal.SIGTERM)
                try: child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
                    cleanup_errors.append(f'forced-stop:{child.pid}')
            except (OSError, subprocess.TimeoutExpired) as error:
                cleanup_errors.append(f'child:{child.pid}:{type(error).__name__}')
            outcomes.append({'pid':child.pid,'exitCode':child.returncode,'stopped':not Path(f'/proc/{child.pid}').exists()})
        for log in logs:log.close()
        receipt['processCleanup']=outcomes
        if started:
            try:
                if database:
                    sql(f'DROP DATABASE "{database}" WITH (FORCE)')
                    receipt['databaseAbsent']=sql(f"select count(*) from pg_database where datname='{database}'")=='0'
            except Exception as error:
                cleanup_errors.append(f'database:{type(error).__name__}')
            finally:
                try:
                    command([PG/'pg_ctl','-D',data,'-m','fast','-w','stop'])
                    receipt['postgresStopped']=not Path(f'/proc/{pg_pid}').exists()
                except Exception as error:
                    cleanup_errors.append(f'postgres:{type(error).__name__}')
        try:sockets.rmdir()
        except OSError as error:cleanup_errors.append(f'sockets:{type(error).__name__}')
        receipt['cleanupErrors']=cleanup_errors;save()
        if cleanup_errors:raise RuntimeError('Owned cleanup requires reconciliation; see receipt')
        print(json.dumps({'receipt':str(owned/'receipt.json'),'probePassed':receipt.get('probePassed',False),'databaseAbsent':receipt.get('databaseAbsent'),'postgresStopped':receipt.get('postgresStopped')}))

if __name__=='__main__': main()
