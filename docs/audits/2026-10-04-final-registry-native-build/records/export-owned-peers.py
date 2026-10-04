from pathlib import Path
import json,subprocess,os
b=Path('/home/nate/Oxy/.agent-evidence');e=b/'i04-final-registry-native-types-20261004';m=json.loads(Path('/home/nate/Oxy/oxy/.worktrees/1519-real-oauth-browser-20261003/.integration-evidence/oauth1519-1n8d1xvu/manifest.json').read_text());rows=[]
for lane,key in [('mention','nativeFirst'),('allo','nativeSecond')]:
 env={k:v for k,v in os.environ.items()if k in ['PATH','HOME','LANG','LC_ALL','TMPDIR']};env.update(CI='1',EXPO_NO_DOTENV='1',EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE='1',EXPO_PUBLIC_OXY_NATIVE_SIBLING=lane,EXPO_PUBLIC_OXY_CLIENT_ID=m['clients'][key]['clientId']);argv=['bun','--no-env-file','run','export:android','--clear'];
 with(e/f'{lane}-android-export-peers.log').open('x')as f:r=subprocess.run(argv,cwd=b/'i04-final-registry-fixtures'/lane,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=900)
 rows.append({'fixture':lane,'exitCode':r.returncode,'command':argv,'publicClientId':env['EXPO_PUBLIC_OXY_CLIENT_ID']});(e/'exports-peers.json').write_text(json.dumps(rows,indent=2)+'\n');assert r.returncode==0,lane
print('Android exports passed')
