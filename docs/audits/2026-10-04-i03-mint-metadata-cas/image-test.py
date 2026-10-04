import os,subprocess,tempfile,pathlib,sys,json
p=pathlib.Path('/usr/lib/postgresql/17/bin');d=pathlib.Path(tempfile.mkdtemp(prefix='i03-cas-'));out=pathlib.Path(__file__).parent
root='/home/nate/Oxy/oxy/.worktrees/1519-i03-mint-metadata-cas-20261004'
e={k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG']}; e.update(NODE_ENV='test',BUN_OPTIONS='--no-env-file',TEST_DATABASE_URL='postgresql://oxy@127.0.0.1:5598/postgres')
def c(args):return subprocess.run([str(x) for x in args],env=e,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,check=True).stdout
print(c([p/'initdb','-D',d/'data','-U','oxy','-A','trust','--no-locale']))
started=False
try:
 print(c([p/'pg_ctl','-D',d/'data','-l',d/'server.log','-w','-o',f'-h 127.0.0.1 -p 5598 -k {d}','start']));started=True
 pid=int((d/'data/postmaster.pid').read_text().splitlines()[0]);assert pathlib.Path(f'/proc/{pid}/exe').resolve()==p/'postgres'
 import secrets
 name='i03_staged_'+secrets.token_hex(8)
 print(c([p/'psql','-X','-h','127.0.0.1','-p','5598','-U','oxy','-d','postgres','-v','ON_ERROR_STOP=1','-c',f'CREATE DATABASE "{name}"']))
 e.update(NODE_ENV='production',DATABASE_URL=f'postgresql://oxy@127.0.0.1:5598/{name}')
 for cmd,label in [(['bun','--no-env-file','run','db:migrate'],'image-migration'),(['node',root+'/scripts/agency/tests/alia-canary-staged-db.mjs','/home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/image-base-api/package.json'],'image-staged')]:
  r=subprocess.run(cmd,env=e,cwd=root+'/packages/api',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  (out/(label+'.log')).write_text(r.stdout);print(r.stdout[-1600:]);r.check_returncode()
 print(c([p/'psql','-X','-h','127.0.0.1','-p','5598','-U','oxy','-d','postgres','-v','ON_ERROR_STOP=1','-c',f'DROP DATABASE "{name}"']))

finally:
 if started:print(c([p/'pg_ctl','-D',d/'data','-m','fast','-w','stop']));assert not pathlib.Path(f'/proc/{pid}').exists();print('OWNED_PG_STOPPED',pid)
