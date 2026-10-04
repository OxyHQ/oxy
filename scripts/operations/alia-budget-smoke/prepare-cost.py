#!/usr/bin/env python3
"""Prepare one read-only observation of the ORIGINAL smoke, never a new caller."""
import argparse,base64,hashlib,importlib.util,json,os,re
from pathlib import Path
P=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prepare',P/'prepare.py');prepare=importlib.util.module_from_spec(spec);spec.loader.exec_module(prepare)
def build(original_plan,output):
 original=Path(original_plan);caller=json.loads(original.read_text())
 prepare.ensure(caller['kind']=='alia-budget-smoke-plan-v1'and caller['mode']=='invoke'and caller['maxPostCount']==1,'original_caller_required')
 prepare.ensure(re.fullmatch(r'oxy1579-alia-[0-9]{13}-[a-f0-9]{16}',caller['intent']),'exact_intent_required')
 # Materialize only non-secret binding metadata from the reviewed original plan.
 out=Path(output);prepare.ensure(not out.exists(),'new_directory_required')
 binding_file=out.with_name(out.name+'-binding.json');prepare.private(binding_file,caller['binding'])
 prepare.prepare(binding_file,None,out,'inventory')
 plan=json.loads((out/'plan.json').read_text());definition=json.loads((out/'definition.json').read_text())
 source=(P/'read-cost-observation.mjs').read_text();reader='data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
 invocation="import{createHash}from'node:crypto';const nonce="+json.dumps(plan['nonce'])+",intent="+json.dumps(caller['intent'])+";try{const{readCanaryObservation}=await import("+json.dumps(reader)+");const observation=await readCanaryObservation(process.env.DATABASE_URL,intent);const raw=JSON.stringify({kind:'alia-budget-smoke-cost-observation',ok:true,observation});if(Buffer.byteLength(raw)>49000)throw new Error('observation_bound');console.log('OXY_ALIA_BUDGET '+JSON.stringify({nonce,intent,sha256:createHash('sha256').update(raw).digest('hex'),data:Buffer.from(raw).toString('base64')}));}catch{console.log('OXY_ALIA_COST_READER_FAILED');process.exitCode=1}"
 definition['containerDefinitions'][0]['command']=['--input-type=module','-e',invocation]
 prepare.ensure(len(json.dumps(definition,separators=(',',':')).encode())<60000,'ecs_payload_bound')
 (out/'definition.json').write_text(json.dumps(definition,indent=2)+'\n')
 plan.update(intent=caller['intent'],definitionSha256=prepare.sha((out/'definition.json').read_bytes()),originalCallerPlanSha256=prepare.sha(original.read_bytes()),sources={'read-cost-observation.mjs':prepare.sha(source.encode()),'prepare-cost.py':prepare.sha(Path(__file__).read_bytes())},purpose='Read-only original intent usage/provider attempts and nullable cost metadata; no inference/feed replay.')
 (out/'plan.json').write_text(json.dumps(plan,indent=2)+'\n');os.chmod(out/'plan.json',0o600)
 print(json.dumps({'preparedCostObservation':True,'intent':plan['intent'],'plan':str(out/'plan.json'),'definitionSha256':plan['definitionSha256'],'originalCallerPlanSha256':plan['originalCallerPlanSha256']}))
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--original-plan',required=True);a.add_argument('--output',required=True);v=a.parse_args();build(v.original_plan,v.output)
