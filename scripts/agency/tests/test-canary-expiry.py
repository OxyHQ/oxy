#!/usr/bin/env python3
"""Owned random PG only; execute actual parent helper against controlled SQL clock."""
from pathlib import Path
import os,secrets,subprocess,tempfile,time,sys
ROOT=Path(__file__).resolve().parents[3];PG=Path('/usr/lib/postgresql/17/bin');PORT=5628
base={k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')}
scratch=Path('/home/nate/Oxy/.agent-evidence/i03-canary-expiry-20261004');scratch.mkdir(exist_ok=True)
owned=Path(tempfile.mkdtemp(prefix='pg-',dir=scratch));data=owned/'data';running=False
run=lambda args,**kw:subprocess.check_output([str(a) for a in args],env=base,text=True,stderr=subprocess.STDOUT,**kw)
print(run([PG/'initdb','-D',data,'-U','oxy','-A','trust','--no-locale']))
started=int(time.time())
try:
 print(run([PG/'pg_ctl','-D',data,'-l',owned/'server.log','-w','-o',f'-h 127.0.0.1 -p {PORT} -k {owned}','start']));running=True
 lines=(data/'postmaster.pid').read_text().splitlines();pid=int(lines[0])
 assert Path(lines[1]).resolve()==data.resolve() and int(lines[2])>=started and int(lines[3])==PORT
 assert Path(f'/proc/{pid}').stat().st_uid==os.getuid() and Path(f'/proc/{pid}/exe').resolve()==(PG/'postgres').resolve()
 assert str(data).encode() in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
 def sql(query,db='postgres'):return run([PG/'psql','-X','-h','127.0.0.1','-p',PORT,'-U','oxy','-d',db,'-v','ON_ERROR_STOP=1','-Atc',query]).strip()
 assert Path(sql("SELECT current_setting('data_directory')")).resolve()==data.resolve()
 name='canary_expiry_'+secrets.token_hex(8);sql(f'CREATE DATABASE "{name}"');sql('CREATE TABLE owned_credential (id text PRIMARY KEY,status text NOT NULL)',name)
 result=subprocess.run(['node','--experimental-vm-modules',str(ROOT/'scripts/agency/tests/test-canary-expiry.mjs'),sys.argv[1] if len(sys.argv)>1 else str(ROOT/'scripts/agency/alia-revocation-canary.mjs'),*sys.argv[2:]],env=base|{'EXPIRY_FIXTURE_DATABASE':name},text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 print(result.stdout);sql(f'DROP DATABASE "{name}"');print(f'OWNED_DATABASE_DROPPED {name}');result.check_returncode()
finally:
 if running:
  print(run([PG/'pg_ctl','-D',data,'-m','fast','-w','stop']));assert not Path(f'/proc/{pid}').exists();print(f'OWNED_POSTGRES_ABSENT {pid}')
