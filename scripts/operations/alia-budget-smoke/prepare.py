#!/usr/bin/env python3
"""LOCAL-ONLY task-definition preparation. No AWS calls or inference.
Root supplies accepted current runtime bindings and a fresh read-only inventory.
The caller image is Oxy (published core4.3); only Alia's exact task role is armed.
"""
import argparse, base64, hashlib, json, os, re, secrets, time, zlib
from pathlib import Path
P=Path(__file__).resolve().parent
ACCOUNT='237343248947'
ROLE=f'arn:aws:iam::{ACCOUNT}:role/oxy-alia-task'
def sha(b):return hashlib.sha256(b).hexdigest()
def ensure(ok,message):
 if not ok:raise ValueError(message)
def private(path,value):
 with open(path,'x')as f:os.chmod(path,0o600);json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
def validate_binding(binding):
 ensure(binding['kind']=='alia-budget-smoke-accepted-runtime-v1','binding_kind')
 ensure(re.fullmatch(r'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:[1-9][0-9]*',binding['oxyDefinition']),'oxy_td')
 ensure(re.fullmatch(r'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-alia:[1-9][0-9]*',binding['aliaDefinition']),'alia_td')
 ensure(re.fullmatch(r'237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:[a-f0-9]{64}',binding['image']),'image')
 ensure(binding['taskRoleArn']==ROLE and binding['budgetSource']=='27ebf33872c4e3c6e72e97a728f157d42a8ffaf2','authority_or_budget_source')
 ensure(re.fullmatch(r'arn:aws:iam::237343248947:role/[A-Za-z0-9+=,.@_/-]+',binding['executionRoleArn']),'execution_role')
 ensure(binding['runtimePlatform']=={'cpuArchitecture':'ARM64','operatingSystemFamily':'LINUX'},'platform')
 ensure(binding['network']['awsvpcConfiguration']['assignPublicIp']=='DISABLED','private_network')
 ensure(binding['coreVersion']=='4.3.0' and binding['contractsVersion']=='4.9.1','sdk_versions')
 ensure(re.fullmatch(r'[a-f0-9]{64}',binding['sdkInferenceModuleSha256']),'sdk_module_hash')
 ensure(binding['logGroup']=='/oxy/ecs' and re.fullmatch(r'[A-Za-z0-9_-]{1,100}',binding['logStreamPrefix']),'logs')
 ensure(binding['cpu'] in ('256','512','1024','2048','4096') and re.fullmatch(r'[0-9]+',binding['memory']),'resources')
 return binding

def prepare(binding_path,inventory_path,output,mode='invoke',original_plan=None):
 binding=validate_binding(json.loads(Path(binding_path).read_text()))
 inventory=json.loads(Path(inventory_path).read_text()) if inventory_path else {'kind':'inference-pilot-readiness','profile':'oxy','readOnly':True,'isolation':'repeatable read','observedAt':None,'tables':{k:{}for k in ('inference_deployments','price_versions','price_version_unit_prices')}}
 ensure(inventory.get('kind')=='inference-pilot-readiness' and inventory.get('profile')=='oxy' and inventory.get('readOnly')is True,'inventory_kind')
 # Compact projection only; preserve original receipt/hash outside the task.
 names=('inference_deployments','price_versions','price_version_unit_prices')
 compact={k:inventory[k]for k in ('kind','profile','readOnly','isolation','observedAt')}
 compact['tables']={k:inventory['tables'][k]for k in names}
 ensure(mode in ('inventory','invoke','reconcile','diagnostic'),'mode')
 if mode=='reconcile':
  ensure(original_plan is not None,'original_plan_required');old=json.loads(Path(original_plan).read_text())
  ensure(old['kind']=='alia-budget-smoke-plan-v1' and old['mode']=='invoke','original_plan_kind');intent=old['intent'];compact=old['inventory']
 else:
  ensure(original_plan is None,'new_intent_only');intent=f'oxy1579-alia-{int(time.time()*1000)}-{secrets.token_hex(8)}'
 nonce=secrets.token_hex(16)
 sources={name:(P/name).read_text()for name in ('smoke.mjs','wire-fixture.mjs','verify-credential.mjs','stage-inference-credential.mjs','oxy-inference-credential.js')}
 packed={'sources':sources,'hashes':{k:sha(v.encode())for k,v in sources.items()},'inventory':compact,'intent':intent,'nonce':nonce,'mode':mode,'binding':binding}
 compressed=base64.b64encode(zlib.compress(json.dumps(packed,separators=(',',':')).encode(),9)).decode()
 invocation='''import{inflateSync}from'node:zlib';import{createHash}from'node:crypto';import{createRequire}from'node:module';import{readFileSync}from'node:fs';import{dirname,join}from'node:path';
const packed=JSON.parse(inflateSync(Buffer.from('PAYLOAD','base64'),{maxOutputLength:150000}).toString());
const hash=b=>createHash('sha256').update(b).digest('hex');const demand=(x,c)=>{if(!x)throw new Error(c)};
const emit=result=>{const raw=JSON.stringify(result);demand(Buffer.byteLength(raw)<50000,'result_bound');console.log('OXY_ALIA_BUDGET '+JSON.stringify({nonce:packed.nonce,intent:packed.intent,sha256:hash(raw),data:Buffer.from(raw).toString('base64')}));};
let staged,stage='bootstrap',emitIntentSent=false;const checkpoint=s=>{stage=s};const watchdog=setTimeout(()=>{emit({kind:'alia-budget-smoke-failure',code:'process_deadline',stage,emitIntentSent,inspectOriginalIntent:true});process.exit(1)},225000);
try{
 checkpoint('context');demand(process.cwd()==='/app/packages/api'&&process.env.OXY_API_URL==='https://api.oxy.so','wrong_context');
 demand(!process.env.DATABASE_URL&&!process.env.KAANA_EDGE_SIGNING_PRIVATE_KEY&&!process.env.OXY_SERVICE_API_KEY&&!process.env.OXY_SERVICE_API_SECRET,'unexpected_authority');
 checkpoint('source_hashes');for(const[n,s]of Object.entries(packed.sources))demand(hash(s)===packed.hashes[n],'source_changed');
 checkpoint('sdk_module');const require=createRequire('/app/packages/api/package.json');
 const entry=require.resolve('@oxy.so/core/inference');
 const coreModule=join(dirname(entry),'OxyInferenceClient.js');demand(hash(readFileSync(coreModule))===packed.binding.sdkInferenceModuleSha256,'sdk_module_changed');
 const version=(entry,name)=>{let d=dirname(entry);for(let n=0;n<9;n++,d=dirname(d)){try{const p=JSON.parse(readFileSync(join(d,'package.json'),'utf8'));if(p.name===name)return p.version}catch{}}throw new Error('package_missing')};
 checkpoint('sdk_versions');demand(version(entry,'@oxy.so/core')==='4.3.0'&&version(require.resolve('@oxy.so/contracts'),'@oxy.so/contracts')==='4.9.1','sdk_version_changed');
 const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
 const verifier=data(packed.sources['verify-credential.mjs']);const smoke=data(packed.sources['smoke.mjs'].replace("'./verify-credential.mjs'",JSON.stringify(verifier)).replace("'./wire-fixture.mjs'",JSON.stringify(data(packed.sources['wire-fixture.mjs']))));
 checkpoint('factory_stage');const stage=await import(data(packed.sources['stage-inference-credential.mjs']));
 staged=stage.stageInferenceCredential({apiPackage:'/app/packages/api/package.json',source:Buffer.from(packed.sources['oxy-inference-credential.js'])});
 checkpoint('factory_import');const factory=require(staged.helperPath);const{OxyInferenceClient}=require('@oxy.so/core/inference');
 const{runSmoke,validatePilot}=await import(smoke);checkpoint('policy');validatePilot(require('/app/packages/api/dist/config/inferenceEconomicPolicy.js'));const result=await runSmoke({credential:factory.createOxyInferenceCredential(process.env),OxyInferenceClient,inventory:packed.inventory,intent:packed.intent,mode:packed.mode,checkpoint,emitIntent:value=>{emitIntentSent=true;emit(value)}});
 emit(result);process.exitCode=result.ok?0:1;
}catch(error){const allowed=new Set(['wrong_context','unexpected_authority','source_changed','sdk_module_changed','package_missing','sdk_version_changed','policy_version_changed','relationship_ambiguous','policy_bounds_changed','allowed_route_set_changed','missing-credential','malformed-token','noncanonical-jwt','invalid-jwt-header','jwks-http-error','invalid-jwks','nonunique-key','invalid-public-key','signature-rejected','wrong-alia-authority','missing-required-scope','missing-response-body','response-too-large','stale_inventory']);const code=allowed.has(error?.message)?error.message:'validation_or_operation_failed';emit({kind:'alia-budget-smoke-failure',code,stage,emitIntentSent,inspectOriginalIntent:true});process.exitCode=1;}finally{clearTimeout(watchdog);if(staged)staged.cleanup();}
'''.replace('PAYLOAD',compressed)
 definition={'family':'oxy-alia-production-budget-smoke','taskRoleArn':ROLE,'executionRoleArn':binding['executionRoleArn'],'networkMode':'awsvpc','requiresCompatibilities':['FARGATE'],'runtimePlatform':binding['runtimePlatform'],'cpu':binding['cpu'],'memory':binding['memory'],'volumes':[], 'containerDefinitions':[{'name':'smoke','image':binding['image'],'essential':True,'workingDirectory':'/app/packages/api','entryPoint':['/usr/local/bin/node'],'command':['--input-type=module','-e',invocation],'environment':[{'name':'NODE_ENV','value':'production'},{'name':'OXY_API_URL','value':'https://api.oxy.so'}],'secrets':[],'portMappings':[],'mountPoints':[],'volumesFrom':[],'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-group':binding['logGroup'],'awslogs-region':'us-west-2','awslogs-stream-prefix':binding['logStreamPrefix']}}}]}
 if mode=='inventory':
  source=(P/'read-internal-pilot-readiness.mjs').read_text();reader='data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
  command="import{createHash}from'node:crypto';const nonce="+json.dumps(nonce)+",intent="+json.dumps(intent)+";try{const {readInventory}=await import("+json.dumps(reader)+");const inventory=await readInventory('oxy',process.env.DATABASE_URL);const raw=JSON.stringify({kind:'alia-budget-smoke-inventory',ok:true,inventory});console.log('OXY_ALIA_BUDGET '+JSON.stringify({nonce,intent,sha256:createHash('sha256').update(raw).digest('hex'),data:Buffer.from(raw).toString('base64')}));}catch{console.log('OXY_ALIA_PRICE_READER_FAILED');process.exitCode=1}"
  definition['family']='oxy-alia-budget-smoke-readonly';definition.pop('taskRoleArn');c=definition['containerDefinitions'][0];c['command']=['--input-type=module','-e',command];c['environment']=[{'name':'NODE_ENV','value':'production'}];c['secrets']=[{'name':'DATABASE_URL','valueFrom':'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL'}]
  packed['hashes']={'read-internal-pilot-readiness.mjs':sha(source.encode())}
 ensure(len(json.dumps(definition,separators=(',',':')).encode())<60000,'ecs_payload_bound')
 out=Path(output);out.mkdir(parents=False,mode=0o700,exist_ok=False)
 private(out/'definition.json',definition)
 plan={'kind':'alia-budget-smoke-plan-v1','preparedAt':int(time.time()),'intent':intent,'nonce':nonce,'mode':mode,'binding':binding,'network':binding['network'],'bindingFileSha256':sha(Path(binding_path).read_bytes()),'inventoryFileSha256':sha(Path(inventory_path).read_bytes()) if inventory_path else None,'definitionSha256':sha((out/'definition.json').read_bytes()),'sources':packed['hashes'],'inventory':compact,'startedBy':'alia-smoke-'+nonce[:16],'clientToken':'alia-smoke-'+nonce,'family':definition['family'],'maxPostCount':1 if mode=='invoke'else 0,'prepareSha256':sha(Path(__file__).read_bytes()),'dispatchSha256':sha((P/'dispatch.py').read_bytes()),'executeByRootOnly':True,'executionReady':False,'remaining':'Root reviews exact accepted image/TD/current price snapshot and dispatch transport before any execution.'}
 private(out/'plan.json',plan)
 print(json.dumps({'prepared':True,'plan':str(out/'plan.json'),'bytes':len(json.dumps(definition).encode()),'intent':intent}))
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--binding',required=True);a.add_argument('--inventory');a.add_argument('--output',required=True);a.add_argument('--mode',choices=['inventory','invoke','reconcile','diagnostic'],default='invoke');a.add_argument('--original-plan');v=a.parse_args();prepare(v.binding,v.inventory,v.output,v.mode,v.original_plan)
