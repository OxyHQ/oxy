import json,hashlib,subprocess,shutil,datetime
from pathlib import Path
R=Path('/home/nate/Oxy/oxy/.worktrees/1573-unicode-forge-evidence-20261004');E=Path('/home/nate/Oxy/.agent-evidence/coverage-unicode-forge-20261004');D=R/'docs/security/forge-independent/2026-10-03-final-input';A=R/'docs/audits/2026-10-04-unicode-forge-evidence';A.mkdir(parents=True,exist_ok=True)
def h(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def git(*a):return subprocess.check_output(['git','-C',str(R),*a],text=True).strip()
def write(p,x):p.write_text(json.dumps(x,indent=2)+'\n')
head=git('rev-parse','HEAD');base='eab1b6dd42b518500b49c03e692738081099d9cc';now=datetime.datetime.now(datetime.timezone.utc).isoformat()
p=json.loads((D/'proof.json').read_text());oldhead=p['candidateCommit'];hist=D/'historical-freeze-924';hist.mkdir(exist_ok=True)
for n in ['proof.json','framework-inputs.json','expo-14-final.log','oxy-34.log','oxy-db-build.log','migrate-fresh.txt','migrate-repeat.txt']:shutil.copyfile(D/n,hist/n)
(hist/'README.md').write_text('Historical exact machine inputs before Unicode source. No new-source test attribution.\n')
for row in p['records']:assert h(D/row['file'])==row['sha256']
consumer=Path('/home/nate/Oxy/.tmp/forge-recovery-refreeze/oxy-unicode-forge-evidence-6un501xa/consumer-input')
fresh={'expo-14-final.log':E/'expo14-corrected.log','oxy-34.log':consumer/'oxy-34.log','oxy-db-build.log':E/'api-build.log'}
for row in p['records']:
 if row['file'] in fresh:
  shutil.copyfile(fresh[row['file']],D/row['file']);row.update(sha256=h(D/row['file']),completedFileMtimeUTC=now,reusedHistorical=False,exitCode=0)
  if row['file']=='oxy-34.log':row['command']='External owned-PG17 harness: canonical142 fresh/repeat +Oxy34; source5d2a7c1f8; PID1300484 stopped'
 else:row['reusedHistorical']=True
assert '14' in (E/'expo14-corrected.log').read_text() and '34 passed' in (consumer/'oxy-34.log').read_text()
local=json.loads((E/'installed321-full-local.json').read_text());assert len(local['copies'])==1 and local['regressions'][0]['count']==321
p.update(candidateCommit=head,recordedAtUTC=now,stage='unicode-source-fresh-forge-consumer-revalidation')
p['historicalCryptoEvidence']['reusedRecords']=[r['file'] for r in p['records'] if r['reusedHistorical']];assert len(p['historicalCryptoEvidence']['reusedRecords'])==14
p['historicalCryptoEvidence']['scope']='Fourteen exact historical stock/patch/upstream/install/control records are retained because Forge patch, upstream source, five bytes and six hash inputs are unchanged. Fresh Expo14, Oxy34/normal142 fresh-repeat, API and six shipping package builds and localinstalled321 ran on Unicode source. contracts tree changed: no all-shipping-equal or publication/runtime claim. Actual authenticated ARM candidate/policy gates still required for this freeze.'
for path,sha in p['inputs'].items():assert h(R/path)==sha,path
forge=R/'node_modules/.bun/node-forge@1.4.0/node_modules/node-forge'
for path,sha in p['files']['installed'].items():assert h(forge/path)==sha,path
p['retainedPaths']={'historicalCryptoPaths':p['retainedPaths'],'currentOxyWorktree':str(R),'currentInstalledForge':str(forge),'currentHarness':str(E/'owned-oxy34-unicode.py'),'currentEvidenceRoot':str(E)}
p['oxyTests'].update(ownedPostgresPid=1300484,ownedPostgresDataDirectory='/home/nate/Oxy/.tmp/forge-recovery-refreeze/oxy-unicode-forge-pg-qcde1kag/data',database='oxy_rehearsal_1519_f314113e7a80e32c')
assert not Path('/proc/1300484').exists() and not Path(p['oxyTests']['ownedPostgresDataDirectory'],'postmaster.pid').exists()
p['inputTrees']={path:git('rev-parse',head+':'+path) for path in p['inputTrees']}
f=json.loads((D/'framework-inputs.json').read_text());f.update(sourceHead=head,base=base)
newfiles=git('diff','--name-only','3a8c5e0cb0138662d6e05d2d5a4de9c732348cc2^','3a8c5e0cb0138662d6e05d2d5a4de9c732348cc2').splitlines()
for path in newfiles:
 assert git('rev-parse',head+':'+path)==git('rev-parse','3a8c5e0cb0138662d6e05d2d5a4de9c732348cc2:'+path)
 if not any(r['file']==path for r in f['changes']):f['changes'].append({'file':path})
for row in f['changes']:
 path=row['file'];row.pop('sameAsMain82',None);row.update(sha256=h(R/path),gitObject=git('rev-parse',head+':'+path),sameAsMainEab=git('rev-parse',base+':'+path)==git('rev-parse',head+':'+path))
write(D/'framework-inputs.json',f)
for row in p['supplementalRecords']:row['reusedHistorical']=True
sources={'framework-inputs.json':D/'framework-inputs.json','migrate-fresh.txt':consumer/'migrate-fresh.txt','migrate-repeat.txt':consumer/'migrate-repeat.txt'}
for name in ['install.log','topology-red.log','topology-green.log','expo14.log','installed321.log','installed321-full-local.json','local-candidate-hashes.json','core-build.log','core-build-corrected.log','db-build.log','contracts-build.log','protocol-build.log','services-build.log','proposal.log','policy.log','binding.log','collector.log','dag.log','lint.log','lint-corrected-pinned.log','oxy34-harness.log']:sources['unicode-'+name]=E/name
for name,src in sources.items():
 if (D/name).exists() and name!='framework-inputs.json':shutil.copyfile(D/name,hist/name)
 p['supplementalRecords']=[r for r in p['supplementalRecords'] if r['file']!=name]
 if src!=D/name:shutil.copyfile(src,D/name)
 failed=name in ['unicode-topology-red.log','unicode-expo14.log','unicode-installed321.log','unicode-core-build.log','unicode-lint.log']
 p['supplementalRecords'].append({'file':name,'sha256':h(D/name),'exitCode':1 if failed else 0,'reusedHistorical':False})
p['historicalSupplementalRecords'].append({'sourceHead':oldhead,'proof':str(hist.relative_to(R)/'proof.json'),'proofSha256':h(hist/'proof.json')})
write(D/'proof.json',p)
shipping=[]
for pkg in ['contracts','core','services','protocol','mcp','db']:
 path='packages/'+pkg;cur=git('rev-parse',head+':'+path);prior=git('rev-parse',base+':'+path);shipping.append({'path':path,'currentGitTree':cur,'acceptedMainEabGitTree':prior,'equal':cur==prior})
assert [r['path'] for r in shipping if not r['equal']]==['packages/contracts']
write(A/'shipping-source-comparison.json',{'sourceHead':head,'priorSource':base,'trees':shipping,'allTreesEqual':False,'changedContractsIntentionalUnicodeFix':True,'publicationOrDeployment':False})
refs=[]
for row in p['records']+p['supplementalRecords']:
 path=D/row['file'];assert h(path)==row['sha256'];refs.append({'file':str(path.relative_to(R)),'sha256':h(path)})
for path in [D/'proof.json',A/'shipping-source-comparison.json',R/'docs/audits/2026-10-04-decisions-unicode/proof.json']:refs.append({'file':str(path.relative_to(R)),'sha256':h(path)})
for n in ['owned-oxy34-unicode.py','update-proof.py']:
 shutil.copyfile(E/n,A/n);refs.append({'file':str((A/n).relative_to(R)),'sha256':h(A/n)})
write(A/'proof.json',{'schemaVersion':1,'sourceHead':head,'baseHead':base,'machineProof':str((D/'proof.json').relative_to(R)),'machineProofSha256':h(D/'proof.json'),'records':refs,'frameworkInputs':len(f['changes']),'historicalCryptoRecords':14,'freshMachineRecords':3,'freshLocalInstalledRegressions':321,'ownedPostgresPidAbsent':True,'ownedPostmasterAbsent':True,'status':'INACTIVE_FREEZE_READY_FOR_INDEPENDENT_ARM_GATE','expiresAtUnchanged':'2026-10-09T22:00:00.000Z','scope':'Unicode contract/API tests are byte-identical to reviewed3a8 source. New branch-only ARM admission and frozen baseeab; no runtime operation, new SDK publication, active security approval or same-contracts-shipping-tree claim.'})
(A/'README.md').write_text('Unicode source '+head+' preserves reviewed3a8/28a7 source and logs. Fresh Expo14/Oxy34/normal142 fresh-repeat/API and six shipping builds/localinstalled321 passed. Fourteen exact historical crypto records are explicitly reused. contracts Git tree intentionally differs from accepted maineab; other five shipping trees equal. No ARM claim until actual branch-bound run provides six files, authenticated workflow mergeSHA and image provenance. Status INACTIVE; expiry fixed2026-10-09T22:00:00.000Z. Initial CLI/builder-order/ARM-manifest-on-local/pinned-linter mistakes remain preserved with corrected passes.\n')
print(json.dumps({'head':head,'machineProof':h(D/'proof.json'),'auditProof':h(A/'proof.json'),'refs':len(refs),'framework':len(f['changes'])}))
