import os,subprocess,tempfile,pathlib,sys,json
p=pathlib.Path('/usr/lib/postgresql/17/bin');d=pathlib.Path(tempfile.mkdtemp(prefix='i03-cas-'));out=pathlib.Path(__file__).parent
root='/home/nate/Oxy/oxy/.worktrees/1519-i03-mint-metadata-cas-20261004'
e={k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG']}; e.update(NODE_ENV='test',BUN_OPTIONS='--no-env-file',TEST_DATABASE_URL='postgresql://oxy@127.0.0.1:5633/postgres')
def c(args):return subprocess.run([str(x) for x in args],env=e,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,check=True).stdout
print(c([p/'initdb','-D',d/'data','-U','oxy','-A','trust','--no-locale']))
started=False
try:
 print(c([p/'pg_ctl','-D',d/'data','-l',d/'server.log','-w','-o',f'-h 127.0.0.1 -p 5633 -k {d}','start']));started=True
 pid=int((d/'data/postmaster.pid').read_text().splitlines()[0]);assert pathlib.Path(f'/proc/{pid}/exe').resolve()==p/'postgres'
 r=subprocess.run(['bun','--no-env-file','run','test','--runInBand','--runTestsByPath','src/services/__tests__/aliaRevocationCanary.db.test.ts'],env=e,cwd=root+'/packages/api',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 (out/(sys.argv[1]+'.log')).write_text(r.stdout); print(r.stdout[-7500:]);print('TEST_EXIT',r.returncode)
finally:
 if started:print(c([p/'pg_ctl','-D',d/'data','-m','fast','-w','stop']));assert not pathlib.Path(f'/proc/{pid}').exists();print('OWNED_PG_STOPPED',pid)
