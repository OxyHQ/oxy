import hashlib,json,subprocess
from pathlib import Path
P=Path(__file__).parent
WT=Path('/home/nate/Oxy/oxy/.worktrees/1572-jev-legal-operation-20261004')
path='packages/api/src/services/inferenceCatalogue.service.ts'
file=WT/path
original=file.read_bytes()
old=subprocess.check_output(['git','show','28d90e4:'+path],cwd=WT)
harness=(P/'owned-pg.py').read_text()
a=harness.index("command = ['bun'");b=harness.index('\n        env = ',a)
harness=harness[:a]+"command = ['bun', '--no-env-file', 'run', 'test', '--runInBand', '--runTestsByPath', 'src/services/__tests__/privateCommissioning.test.ts', 'src/routes/__tests__/inferenceEdge.test.ts', '--testNamePattern', '^private source authority|^private commissioning HTTP.*reserves once']"+harness[b:]
(P/'owned-pg-baseline.py').write_text(harness)
try:
 file.write_bytes(old)
 with(P/'baseline-red.log').open('wb') as log:
  r=subprocess.run(['python3',str(P/'owned-pg-baseline.py')],stdout=log,stderr=subprocess.STDOUT)
finally:
 file.write_bytes(original)
 assert file.read_bytes()==original
 (P/'baseline-restored.json').write_text(json.dumps({'base':'28d90e4f2c9143253843725aa361975ec951c6cd','path':path,'baseSha256':hashlib.sha256(old).hexdigest(),'restoredSha256':hashlib.sha256(original).hexdigest(),'baselineExit':r.returncode,'restoredByteExact':True},indent=2)+'\n')
if r.returncode==0:raise SystemExit('Baseline unexpectedly passed')
