import json,hashlib,subprocess,shutil,datetime,os
from pathlib import Path
R=Path('/home/nate/Oxy/oxy/.worktrees/1519-forge-recovery-contract-20261004'); E=Path('/home/nate/Oxy/.agent-evidence/coverage-final-forge-recovery-freeze-20261004'); D=R/'docs/security/forge-independent/2026-10-03-final-input'; A=R/'docs/audits/2026-10-04-final-forge-recovery-freeze'; A.mkdir(parents=True,exist_ok=True)
def h(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def git(*a):return subprocess.check_output(['git','-C',str(R),*a],text=True).strip()
def write(p,x):p.write_text(json.dumps(x,indent=2)+'\n')
head=git('rev-parse','HEAD'); base='82bca73efa870b013d7817aac7b7f9d63799963b'; now=datetime.datetime.now(datetime.timezone.utc).isoformat()
p=json.loads((D/'proof.json').read_text()); oldhead=p['candidateCommit']; hist=D/'historical-freeze-841';hist.mkdir(exist_ok=True)
for n in ['proof.json','framework-inputs.json','expo-14-final.log','oxy-34.log','oxy-db-build.log','migrate-fresh.txt','migrate-repeat.txt']:
 shutil.copyfile(D/n,hist/n)
(hist/'README.md').write_text('Historical machine evidence before the final Forge recovery and quiesced guard fixes. These files retain their original hashes and source identity.\n')
for row in p['records']:assert h(D/row['file'])==row['sha256'],row['file']
fresh={'expo-14-final.log':E/'expo14.log','oxy-34.log':Path('/home/nate/Oxy/.tmp/forge-recovery-refreeze/oxy-forge-final-evidence-lqqsrqa_/consumer-input/oxy-34.log'),'oxy-db-build.log':E/'api-build.log'}
for row in p['records']:
 if row['file'] in fresh:
  shutil.copyfile(fresh[row['file']],D/row['file']);row.update(sha256=h(D/row['file']),completedFileMtimeUTC=now,reusedHistorical=False,exitCode=0)
  if row['file']=='oxy-34.log':row['command']='External owned-PG harness: canonical142 fresh/repeat and Oxy34; PG1109686 stopped'
 else:row['reusedHistorical']=True
p.update(candidateCommit=head,recordedAtUTC=now,stage='final-forge-recovery-and-quiesced-final-guards')
p['historicalCryptoEvidence']['reusedRecords']=[r['file'] for r in p['records'] if r['reusedHistorical']];assert len(p['historicalCryptoEvidence']['reusedRecords'])==14
p['historicalCryptoEvidence']['scope']='Exact Forge patch, upstream source and pinned toolchain remain unchanged. Fourteen historical raw crypto/install/control records remain byte-identical; Oxy34, canonical142 fresh/repeat, API build and Expo14 ran on this source. Six SDK shipping Git trees equal runtime main85; no SDK publication or runtime deployment is claimed. Authenticated ARM and policy gates require this freeze independently.'
for path,sha in p['inputs'].items():assert h(R/path)==sha,path
forge=R/'node_modules/.bun/node-forge@1.4.0/node_modules/node-forge'
for path,sha in p['files']['installed'].items():assert h(forge/path)==sha,path
p['retainedPaths']={'historicalCryptoPaths':p['retainedPaths'],'currentOxyWorktree':str(R),'currentInstalledForge':str(forge),'currentHarness':str(E/'owned-oxy34-final.py'),'currentEvidenceRoot':str(E)}
p['oxyTests'].update(ownedPostgresPid=1109686,ownedPostgresDataDirectory='/home/nate/Oxy/.tmp/forge-recovery-refreeze/oxy-forge-final-pg-3m9uvu4y/data',database='oxy_rehearsal_1519_d2613fb15f8e2bc6')
assert not Path('/proc/1109686').exists();assert not Path(p['oxyTests']['ownedPostgresDataDirectory'],'postmaster.pid').exists()
p['inputTrees']={path:git('rev-parse',head+':'+path) for path in p['inputTrees']}
f=json.loads((D/'framework-inputs.json').read_text());f.update(sourceHead=head,base=base)
for row in f['changes']:
 path=row['file'];row.pop('sameAsMain85',None);row.update(sha256=h(R/path),gitObject=git('rev-parse',head+':'+path),sameAsMain82=git('rev-parse',base+':'+path)==git('rev-parse',head+':'+path))
write(D/'framework-inputs.json',f)
for row in p['supplementalRecords']:row['reusedHistorical']=True
new=[('framework-inputs.json',D/'framework-inputs.json',0),('migrate-fresh.txt',Path('/home/nate/Oxy/.tmp/forge-recovery-refreeze/oxy-forge-final-evidence-lqqsrqa_/consumer-input/migrate-fresh.txt'),0),('migrate-repeat.txt',Path('/home/nate/Oxy/.tmp/forge-recovery-refreeze/oxy-forge-final-evidence-lqqsrqa_/consumer-input/migrate-repeat.txt'),0)]
for name in ['topology-exact-GREEN.log','topology-lint-final.log','binding.log','collector.log','proposal.log','policy.log','dag-exact-green.log','oxy34-harness.log','install-current.log']:
 new.append(('recovery-'+name,E/name,0))
new.append(('recovery-topology-exact-RED.log',E/'topology-exact-RED.log',1))
for name,src,code in new:
 previous=next((r for r in p['supplementalRecords'] if r['file']==name),None)
 if previous and name!='framework-inputs.json':
  shutil.copyfile(D/name,hist/name)
 p['supplementalRecords']=[r for r in p['supplementalRecords'] if r['file']!=name]
 if src!=D/name:shutil.copyfile(src,D/name)
 p['supplementalRecords'].append({'file':name,'sha256':h(D/name),'exitCode':code,'reusedHistorical':False})
p['historicalSupplementalRecords'].append({'sourceHead':oldhead,'proof':str(hist.relative_to(R)/'proof.json'),'proofSha256':h(hist/'proof.json')})
write(D/'proof.json',p)
shipping=[]
for pkg in ['contracts','core','services','protocol','mcp','db']:
 path='packages/'+pkg; cur=git('rev-parse',head+':'+path); runtime=git('rev-parse','85dad68e5685413740a4a3fd52afee5bd724bed1:'+path);assert cur==runtime,path;shipping.append({'path':path,'currentGitTree':cur,'runtimeMain85GitTree':runtime,'equal':True})
write(A/'shipping-source-equality.json',{'sourceHead':head,'runtimeSource':'85dad68e5685413740a4a3fd52afee5bd724bed1','trees':shipping,'publicationOrDeployment':False})
refs=[]
for row in p['records']+p['supplementalRecords']:
 path=D/row['file'];assert h(path)==row['sha256'];refs.append({'file':str(path.relative_to(R)),'sha256':h(path)})
for path in [D/'proof.json',A/'shipping-source-equality.json']:
 refs.append({'file':str(path.relative_to(R)),'sha256':h(path)})
for n in ['owned-oxy34-final.py','update-proof.py']:
 shutil.copyfile(E/n,A/n);refs.append({'file':str((A/n).relative_to(R)),'sha256':h(A/n)})
write(A/'proof.json',{'schemaVersion':1,'sourceHead':head,'baseHead':base,'machineProof':str((D/'proof.json').relative_to(R)),'machineProofSha256':h(D/'proof.json'),'records':refs,'frameworkInputs':len(f['changes']),'historicalCryptoRecords':14,'freshRecords':3,'ownedPostgresPidAbsent':True,'ownedPostmasterAbsent':True,'status':'INACTIVE_FREEZE_READY_FOR_INDEPENDENT_ARM_GATE','expiresAtUnchanged':'2026-10-09T22:00:00Z','scope':'Forge source availability/per-attempt provenance and quiesced final hold/latest steady guards; ops-only configuration scripts. No new SDK or Oxy runtime deployment.'})
(A/'README.md').write_text('Final composite source '+head+' binds the frozen base to authenticated main82 and adds only its exact candidate branch to the ARM workflow. Fresh Oxy34 (three suites), canonical142 fresh/repeat, API build and Expo14 passed. Fourteen unchanged historical Forge records are explicitly reused. Source trees of six shipping packages equal runtime main85. The final ARM workflow blob changed and requires its own authenticated PR merge SHA; prior e315 producer pins are not reused. The source decision remains INACTIVE pending root gate; expiry stays 2026-10-09T22:00:00Z.\n')
print(json.dumps({'sourceHead':head,'machineProofSha256':h(D/'proof.json'),'auditProofSha256':h(A/'proof.json'),'records':len(refs),'framework':len(f['changes'])}))
