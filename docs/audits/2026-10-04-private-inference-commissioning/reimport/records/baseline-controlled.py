from pathlib import Path
import subprocess,json,hashlib
root=Path('/home/nate/Oxy/oxy/.worktrees/1572-jev-legal-operation-20261004')
out=Path('/home/nate/Oxy/.agent-evidence/integration-jev-scoped-reimport-20261004')
source=root/'packages/api/src/services/kaanaCatalogueSync.service.ts'
working=source.read_bytes()
base=subprocess.check_output(['git','show','9a7d8f569:packages/api/src/services/kaanaCatalogueSync.service.ts'],cwd=root)
try:
 source.write_bytes(base)
 result=subprocess.run(['python3',str(out/'owned-pg.py')])
finally:
 source.write_bytes(working)
 (out/'baseline-restored.json').write_text(json.dumps({'baseCommit':'9a7d8f569dd953e2ba8412a8ca3e2177be88a4a1','baselineSourceSha256':hashlib.sha256(base).hexdigest(),'workingRestoredSha256':hashlib.sha256(working).hexdigest(),'restoredByteExact':source.read_bytes()==working},indent=2)+'\n')
raise SystemExit(result.returncode)
