from pathlib import Path
import json,hashlib,shutil,subprocess
w=Path('/home/nate/Oxy/oxy/.worktrees/1519-consumer-rollout-preflight-20261003');e=Path('/home/nate/Oxy/.agent-evidence/i04-final-registry-native-types-20261004');b=Path('/home/nate/Oxy/.agent-evidence/i04-final-registry-fixtures');sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();frozen=[]
for lane in ['mention','allo']:
 f=b/lane
 for p in sorted((w/'scripts/adoption/registry-fixtures/native').rglob('*')):
  if p.is_file():
   rel=p.relative_to(w/'scripts/adoption/registry-fixtures/native');q=f/rel;assert p.read_bytes()==q.read_bytes(),str(q);frozen.append({'path':str(q),'sha256':sha(q)})
 for name in ['bun.lock','expo-env.d.ts','nativewind-env.d.ts']:
  q=f/name;frozen.append({'path':str(q),'sha256':sha(q)})
 resolver=f/'metro-resolved.jsonl';records=[json.loads(line)for line in resolver.read_text().splitlines()];unique={r['resolved']for r in records};assert all(str(Path(p).resolve()).startswith(str(f/'node_modules')+'/')for p in unique)
 (e/(lane+'-live-resolver-summary.json')).write_text(json.dumps({'fixture':str(f),'records':len(records),'uniqueFiles':len(unique),'files':[{'path':p,'sha256':sha(Path(p))}for p in sorted(unique)]},indent=2)+'\n');shutil.copyfile(resolver,e/(lane+'-resolver-frozen.jsonl'))
(e/'frozen-inputs.json').write_text(json.dumps(frozen,indent=2)+'\n')
d=w/'docs/audits/2026-10-04-final-registry-native-build';d.mkdir();(d/'records').mkdir();sources=[{'path':str(p.relative_to(w)),'sha256':sha(p)}for p in sorted((w/'scripts/adoption/registry-fixtures/native').rglob('*'))if p.is_file()];sources += [{'path':'scripts/adoption/test-registry-fixtures.py','sha256':sha(w/'scripts/adoption/test-registry-fixtures.py')}];rs=[];private=[]
for p in sorted(e.iterdir()):
 if not p.is_file():continue
 if p.suffix in ['.apk','.bundle','.jsonl']:
  private.append({'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size});continue
 if p.suffix in ['.json','.log','.txt','.py']:
  q=d/'records'/p.name;shutil.copyfile(p,q);rs.append({'path':str(q.relative_to(w)),'sha256':sha(q),'bytes':q.stat().st_size})
for lane in ['mention','allo']:
 for name in ['intent.json','started.json']:
  p=e/(lane+'-launch')/name;q=d/'records'/(lane+'-launch-'+name);shutil.copyfile(p,q);rs.append({'path':str(q.relative_to(w)),'sha256':sha(q),'bytes':q.stat().st_size})
v={'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,text=True).strip(),'sources':sources,'records':rs,'privateArtifacts':private,'validation':{'templateTests':6,'nativeTypes':'both passed','androidExports':'both passed','gradleDebug':'both passed x86_64','registryMemberVerification':'both passed all targeted importer members','liveBundles':'both HTTP200 frozen','certificateSha256':'0114ce567a3be9b87dcbb0ef1083bba5f6e38ebf6733b29df93be1acfd7fbb55'},'limits':['No device install or runtime acceptance yet. Root alone may install-r same package and fixture certificate on owned AVD5580; no clear/uninstall/identity mutation.','Old APK native graph is incomplete for standalone dependencies; fresh APKs eliminate that reuse claim.','Initial TS/CSS/missing-peer/virtual-module setup failures are preserved. Virtual resolver exception is only Expo canonical in-memory assets registry; real paths still confined.','Historic Metros17967/17968, API17960, PG and browser RPs remain untouched. New Metros17977/17978 own only standalone fixtures.','One final-types recording attempt found an existing evidence filename; prior log was not overwritten, and both final typechecks reran into distinct latest logs. Expo/NativeWind generated type includes were preserved before source freeze.']};(d/'proof.json').write_text(json.dumps(v,indent=2)+'\n');(d/'README.md').write_text('# Final public-registry native fixture build\n\nBoth standalone siblings resolve published Oxy packages and Bloom6.2.1 without workspace aliases. Canonical type references, explicit native UI peers, the preserved LightningCSS pin and narrow Expo virtual-module handling complete the consumer installation.\n\nBoth typechecks, Android exports, x86_64 Gradle builds and public registry/member checks pass. Fresh APKs use the existing fixture certificate. Live Metro bundles are frozen on17977/17978. Sources, commands, retained failures, APK/byte hashes and resolver records are in [proof.json](proof.json).\n\nRoot still owns AVD5580 install-r and runtime replay. No physical device, key, identity store or existing authority/listener was modified.\n');print(v['source'],len(sources),len(rs),len(private),sha(d/'proof.json'))
