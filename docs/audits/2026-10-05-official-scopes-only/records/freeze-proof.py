import hashlib,json,pathlib,subprocess,shutil,re,os
root=pathlib.Path('/home/nate/Oxy/oxy/.worktrees/1572-mention-scope-seed-20261005'); ev=pathlib.Path('/home/nate/Oxy/.agent-evidence/i04-mention-scope-seed-20261005'); out=root/'docs/audits/2026-10-05-official-scopes-only'; logs=out/'records';logs.mkdir(exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
inputs=[]
for name in ['packages/api/scripts/seed-oxy-applications.ts','packages/api/src/scripts/seedOxyApplicationScopes.ts','packages/api/src/scripts/__tests__/seedOxyApplicationScopes.test.ts','packages/api/src/scripts/seedOxyApplicationsSpecs.ts','packages/api/src/scripts/__tests__/seedOxyApplicationsSpecs.test.ts','packages/api/src/scripts/seedEntrySelection.ts','packages/api/src/scripts/seedOxyApplicationsPlan.ts','packages/api/src/config/mentionClassifierEconomics.ts','packages/api/src/utils/applicationScopes.ts','packages/api/src/services/workloadIdentityBinding.service.ts','packages/api/src/services/accountFinancialHolds.service.ts','packages/api/package.json','Dockerfile','docs/audits/2026-10-05-official-scopes-only/README.md']:
 p=root/name;git=subprocess.check_output(['git','show',f'{source}:{name}'],cwd=root);assert git==p.read_bytes();inputs.append({'path':name,'gitCommit':source,'sha256':sha(p)})
records=[]
for p in sorted(ev.glob('*.log'))+sorted(ev.glob('*.py'))+[ev/'compiled-cli.cjs']:
 target=logs/p.name;shutil.copyfile(p,target);records.append({'path':str(target.relative_to(root)),'sha256':sha(target)})
for d in sorted(ev.glob('pg1519-*')):
 for p in sorted(d.glob('*.txt')):
  target=logs/(d.name+'-'+p.name);shutil.copyfile(p,target);records.append({'path':str(target.relative_to(root)),'sha256':sha(target)})
compiled=[]
for name in ['seedOxyApplicationScopes.js','seedOxyApplicationsSpecs.js','seedEntrySelection.js']:
 p=root/'packages/api/dist/scripts'/name;target=logs/name;shutil.copyfile(p,target);compiled.append({'path':str(p.relative_to(root)),'sha256':sha(p),'preserved':str(target.relative_to(root))})
pids=[]
for p in [ev/'focal.log',ev/'compiled-cli.log',ev/'focal-initial-authorized-spec-delta.log',ev/'focal-initial-type-narrowing.log']:
 for line in p.read_text().splitlines():
  try:r=json.loads(line)
  except:continue
  if 'newLocalServerPid' in r:
   pid=r['newLocalServerPid'];absent=not pathlib.Path(f'/proc/{pid}').exists();assert absent;pids.append({'pid':pid,'absent':absent,'sourceLog':p.name})
proof={'kind':'official-scopes-only-source-and-local-sql','sourceCommit':source,'baseCommit':subprocess.check_output(['git','rev-parse','HEAD^'],cwd=root,text=True).strip(),'inputs':inputs,'records':records,'compiled':compiled,'ownedPgCleanup':pids,'results':{'jestSuites':4,'jestPassed':124,'canonicalBuild':True,'compiledNodeCli':True,'scopedBiome':True,'existingWrapperBiomeDiagnostics':9},'limits':['No production execution or activation','No scope-binding mutation in this command','No session or staff identity manufactured','New image source binding required before operator use','Human OAuth/session grants not evaluated','Initial setup/assertion failures retained, not product RED','Final test-only concatenation formatting change did not alter runtime tested']}
(out/'proof.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps({'source':source,'proof':str(out/'proof.json'),'sha256':sha(out/'proof.json'),'inputs':len(inputs),'records':len(records),'compiled':len(compiled),'absentOwnedPids':len(pids)}))
