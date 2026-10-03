#!/usr/bin/env python3
"""Owned AUTH-only compiled bootstrap rehearsal. No DB URL or remote overrides."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import tempfile
import importlib.util
import shutil
import time
from diagnostics import failure_diagnostic, required_extensions

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = ROOT.parent / '1519-i05-foreground-capability-20261003'
SCHEMA_SHA = '38d5ce28c0a5ec0338775810d5681e2834416f25'
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5602

def socket_fds(pid):
    values=set()
    for descriptor in Path(f'/proc/{pid}/fd').iterdir():
        try: values.add(os.readlink(descriptor))
        except FileNotFoundError: pass  # A completed local readiness client closed its FD.
    return values

def main():
    global SCHEMA
    assert os.sys.argv[1:] in ([], ['--production-bootstrap'], ['--arm-image-bootstrap']), 'Only fixed bootstrap controls are supported'
    image_mode = os.sys.argv[1:] == ['--arm-image-bootstrap']
    bootstrap_environment = 'production' if os.sys.argv[1:] else 'test'
    if image_mode:
        SCHEMA = Path(os.environ['AUTH_ONLY_SCHEMA_SOURCE']).resolve()
        assert SCHEMA != ROOT and SCHEMA.is_dir()
        image_spec = importlib.util.spec_from_file_location('auth_only_image', ROOT/'scripts/rehearsal/old-auth-only/image-bootstrap.py')
        image_module = importlib.util.module_from_spec(image_spec); image_spec.loader.exec_module(image_module)
    os.umask(0o077)
    for source in [ROOT,SCHEMA]:
        assert not (source/'.env').exists() and not (source/'packages/api/.env').exists()
    env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','LC_ALL')}
    env['BUN_OPTIONS'] = '--no-env-file'
    def command(args, cwd=ROOT, extra=None, timeout=120):
        return subprocess.check_output([str(x) for x in args],cwd=cwd,env=env | (extra or {}),text=True,stderr=subprocess.STDOUT,timeout=timeout)
    assert command(['git','rev-parse','HEAD'],SCHEMA).strip() == SCHEMA_SHA
    scratch = Path(os.environ['RUNNER_TEMP']).resolve()/'auth-only-bootstrap' if image_mode else Path('/home/nate/Oxy/.agent-evidence/integration-old-auth-only-20261003')
    scratch.mkdir(exist_ok=True, mode=0o700)
    owned=Path(tempfile.mkdtemp(prefix='rollback-',dir=scratch)); owned.chmod(0o700)
    sockets=Path(tempfile.mkdtemp(prefix='i04-rb-',dir='/tmp' if image_mode else '/home/nate/Oxy/.agent-evidence')); sockets.chmod(0o700)
    proof_output=owned/'proof';proof_output.mkdir(mode=0o700)
    data=owned/'pg'; children=[]; logs=[]; started=False; database=None; pg_pid=None
    image = image_module.ImageBootstrap(os.environ['AUTH_ONLY_IMAGE_ID'], ROOT, proof_output, command) if image_mode else None
    receipt={'schemaSource':SCHEMA_SHA,'variantSource':command(['git','rev-parse','HEAD']).strip(),'derivedFrom':'67c09e853db308d102624a2ffd40db19959344f4','directory':str(owned),'productionAccess':False,'bootstrapNodeEnv':bootstrap_environment,'imageMode':image_mode}
    if image:
        assert image.inspection['Config']['Labels']['org.opencontainers.image.revision']==receipt['variantSource']
        receipt['imageConfigId']=image.image
        receipt['fixtureInputSha256']={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted((ROOT/'scripts/rehearsal/old-auth-only').glob('*')) if path.is_file()}
    def save(): (owned/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    def sql(query,db='postgres'):
        return command([PG/'psql','-X','-h','127.0.0.1','-p',PORT,'-U','oxy','-d',db,'-v','ON_ERROR_STOP=1','-Atc',query]).strip()
    def logged(args,name,cwd=ROOT,extra=None,timeout=180):
        with (owned/name).open('w') as output:
            task=subprocess.Popen([str(x) for x in args],cwd=cwd,env=env|(extra or {}),text=True,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
            children.append(task)
            try: task.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(task.pid,signal.SIGTERM)
                try: task.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(task.pid,signal.SIGKILL);task.wait(timeout=10)
                raise RuntimeError(f'{name} exceeded its bound; own process group stopped')
        raw=(owned/name).read_bytes(); receipt[name]={'exitCode':task.returncode,'sha256':hashlib.sha256(raw).hexdigest()};save()
        if task.returncode:
            receipt[name]['diagnostic']=failure_diagnostic(raw);save()
            print(json.dumps({'phase':name,'exitCode':task.returncode,'diagnostic':receipt[name]['diagnostic']}),flush=True)
            raise RuntimeError(f'{name} failed; inspect owned private log')
    if image_mode:
        def interrupted(signum, _frame):
            signal.signal(signal.SIGTERM, signal.SIG_IGN);signal.signal(signal.SIGINT, signal.SIG_IGN)
            raise InterruptedError('Owned image bootstrap interrupted; entering cleanup')
        signal.signal(signal.SIGTERM, interrupted);signal.signal(signal.SIGINT, interrupted)
    try:
        command([PG/'initdb','-D',data,'-U','oxy','-A','trust','--no-locale','--encoding=UTF8'])
        epoch=int(time.time())
        command([PG/'pg_ctl','-D',data,'-l',owned/'postgres.log','-w','-o',f'-h 127.0.0.1 -p {PORT} -k {sockets}','start']);started=True
        rows=(data/'postmaster.pid').read_text().splitlines();pg_pid=int(rows[0])
        assert Path(rows[1]).resolve()==data.resolve() and int(rows[2])>=epoch and int(rows[3])==PORT
        assert Path(rows[4]).resolve()==sockets.resolve()
        assert Path(f'/proc/{pg_pid}').stat().st_uid==os.getuid()
        assert Path(f'/proc/{pg_pid}/exe').resolve()==(PG/'postgres').resolve()
        fds=socket_fds(pg_pid)
        listener=[r.split() for r in Path('/proc/net/tcp').read_text().splitlines()[1:] if r.split()[1]==f'0100007F:{PORT:04X}' and r.split()[3]=='0A']
        assert len(listener)==1 and f'socket:[{listener[0][9]}]' in fds
        assert Path(sql("select current_setting('data_directory')")).resolve()==data.resolve()
        extensions=json.loads(sql("SELECT coalesce(json_object_agg(name,default_version),'{}'::json)::text FROM pg_available_extensions WHERE name IN ('postgis','pg_trgm')"))
        receipt['requiredExtensionAvailability']=extensions;save()
        receipt['requiredExtensions']=required_extensions(extensions);save()
        database='oxy_rollback_'+secrets.token_hex(8);sql(f'CREATE DATABASE "{database}"')
        receipt.update(postgresPid=pg_pid,postgresData=str(data),database=database,port=PORT);save()
        redis_log=(owned/'redis.log').open('w');logs.append(redis_log)
        redis=subprocess.Popen(['/usr/bin/redis-server','--bind','127.0.0.1','--port','5603','--save','','--appendonly','no','--dir',str(owned)],env=env,stdout=redis_log,stderr=subprocess.STDOUT,start_new_session=True);children.append(redis)
        deadline=time.monotonic()+10
        while True:
            if redis.poll() is not None: raise RuntimeError('Own Redis exited before ready')
            try:
                if command(['redis-cli','-h','127.0.0.1','-p','5603','PING'],timeout=2).strip()=='PONG':break
            except subprocess.CalledProcessError:pass
            if time.monotonic()>deadline:raise RuntimeError('Own Redis readiness timeout')
            time.sleep(.1)
        assert Path(f'/proc/{redis.pid}').stat().st_uid==os.getuid()
        assert Path(f'/proc/{redis.pid}/exe').resolve()==Path('/usr/bin/redis-server').resolve()
        redis_sockets=socket_fds(redis.pid)
        redis_listener=[r.split() for r in Path('/proc/net/tcp').read_text().splitlines()[1:] if r.split()[1]==f'0100007F:{5603:04X}' and r.split()[3]=='0A']
        assert len(redis_listener)==1 and f'socket:[{redis_listener[0][9]}]' in redis_sockets
        receipt['redis']={'pid':redis.pid,'port':5603,'persistence':False};save()
        signing_key=command(['openssl','genpkey','-algorithm','ED25519'])
        runtime={'SERVICE_TOKEN_SIGNING_KEY_ID':'rollback-owned','SERVICE_TOKEN_PRIVATE_KEY':signing_key,'CAPABILITY_TICKET_SIGNING_KEY_ID':'rollback-owned','CAPABILITY_TICKET_SIGNING_PRIVATE_KEY':signing_key,'REDIS_URL':'redis://127.0.0.1:5603', 'DATABASE_URL':f'postgresql://oxy@127.0.0.1:{PORT}/{database}','NODE_ENV':'test',
          'ACCESS_TOKEN_SECRET':'rollback-fixture-access-secret-only-64-characters-not-production',
          'REFRESH_TOKEN_SECRET':'rollback-fixture-refresh-secret-only-64-characters-not-production',
          'DEVICE_ID_SALT':'rollback-fixture-device-salt-only-64-characters-not-production',
          'AWS_REGION':'us-west-2','AWS_ACCESS_KEY_ID':'fixture-no-aws-key','AWS_SECRET_ACCESS_KEY':'fixture-no-aws-secret','AWS_S3_BUCKET':'fixture-no-bucket',
          'AUTH_WEB_ORIGIN':'http://127.0.0.1:18002','OXY_API_URL':'http://127.0.0.1:18002','ASSET_CDN_URL':'http://127.0.0.1:18002','LOG_LEVEL':'warn','AUTH_ONLY_SCHEMA_SOURCE':str(SCHEMA),'AUTH_ONLY_BOOTSTRAP_ENVIRONMENT':bootstrap_environment}
        for phase in ['fresh','repeat']:
            assert not (ROOT/'packages/api/.env').exists()
            logged(['bun','--no-env-file','run','db:migrate'],f'migrate-{phase}.log',SCHEMA/'packages/api',runtime)
            assert sql('select count(*) from drizzle.__drizzle_migrations',database)=='142'
        manifest=proof_output/'fixture.private.json'
        logged(['bun','--no-env-file',ROOT/'scripts/rehearsal/old-auth-only/seed.mjs','seed',manifest],'seed.log',extra=runtime)
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
        if not image_mode:
            logged(['bun','--no-env-file','run','test','--runInBand','--runTestsByPath','src/middleware/__tests__/rollbackAuthAdmission.test.ts','src/__tests__/bootGate.test.ts'], 'admission-unit.log',ROOT/'packages/api',{k:v for k,v in runtime.items() if k != 'REDIS_URL'},timeout=240)
        ready=proof_output/'variant-ready.json'; log=(owned/'variant-host.log').open('w');logs.append(log)
        node=Path(shutil.which('node') or '/home/nate/.nvm/versions/node/v24.21.0/bin/node')
        host_env=runtime|{'OXY_RUNTIME_MODE':'rollback-auth-only','PORT':'18002','NODE_ENV':bootstrap_environment,'HOME':'/tmp'}
        if image:
            host_env.pop('AUTH_ONLY_SCHEMA_SOURCE')
            host_args=image.run('host.mjs',['/app','/proof/output/variant-ready.json'],host_env)
        else:
            host_args=[str(node),str(ROOT/'scripts/rehearsal/old-auth-only/host.mjs'),str(ROOT),str(ready)]
        child=subprocess.Popen(host_args,cwd=owned,env=env|host_env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);children.append(child)
        deadline=time.monotonic()+90
        while not ready.exists():
            if child.poll() is not None: raise RuntimeError('Variant bootstrap exited before ready; inspect private host log')
            if time.monotonic()>deadline: raise RuntimeError('Variant readiness timeout')
            time.sleep(.1)
        receipt['variantHost']=json.loads(ready.read_text())
        if image:
            assert receipt['variantHost']['pid']==1 and receipt['variantHost']['nodeEnv']=='production'
            receipt['hostContainer']=image.verify(image.containers[0],running=True)
            probe_env={k:v for k,v in runtime.items() if k!='AUTH_ONLY_SCHEMA_SOURCE'}|{'HOME':'/tmp'}
            # Probe uses the same compiled image while creating old-state fixtures in normal/test mode.
            logged(image.run('probe.mjs',['/proof/output/fixture.private.json'],probe_env),'http-sql-probe.log',ROOT,probe_env,timeout=180)
            receipt['probeContainer']=image.verify(image.containers[-1]);assert receipt['probeContainer']['exitCode']==0
        else:
            assert receipt['variantHost']['pid']==child.pid
            logged([node,ROOT/'scripts/rehearsal/old-auth-only/probe.mjs',manifest],'http-sql-probe.log',ROOT,runtime,timeout=180)
        probe_rows=[]
        for line in (owned/'http-sql-probe.log').read_text().splitlines():
            try: row=json.loads(line)
            except json.JSONDecodeError: continue
            if row.get('case') and row.get('passed') is True: probe_rows.append(row['case'])
        assert len(probe_rows)==14 and len(set(probe_rows))==14
        receipt['checkpoints']=probe_rows;save()
        receipt['preservedAfter']=census();assert receipt['preservedAfter']==before
        for path in [str(manifest)+'.seed.external.json',str(manifest)+'.probe.external.json',str(ready)+'.external.json']:
            assert json.loads(Path(path).read_text())['externalAttempts']==0
        receipt['externalAttempts']=0
        receipt['probePassed']=True
    finally:
        outcomes=[];cleanup_errors=[]
        containers_safe=True
        if image:
            # Never drop the DB beneath a still-running or unknown own Docker container.
            try: receipt['containerCleanup']=image.stop()
            except Exception as error:
                containers_safe=False;cleanup_errors.append('containers:'+type(error).__name__)
                receipt['containerCleanupRequiresReconciliation']=True
            save()
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
        if started and containers_safe:
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
        if started and not containers_safe:
            receipt['databaseRetainedForUnresolvedContainer']=True
        try:sockets.rmdir()
        except OSError as error:cleanup_errors.append(f'sockets:{type(error).__name__}')
        receipt['cleanupErrors']=cleanup_errors;save()
        if image_mode:
            (scratch/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        if cleanup_errors:raise RuntimeError('Owned cleanup requires reconciliation; see receipt')
        print(json.dumps({'receipt':str(owned/'receipt.json'),'probePassed':receipt.get('probePassed',False),'databaseAbsent':receipt.get('databaseAbsent'),'postgresStopped':receipt.get('postgresStopped')}))

if __name__=='__main__': main()
