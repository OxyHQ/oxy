#!/usr/bin/env python3
"""Generate exact I09 definitions locally. Never invokes AWS or writes production."""
import argparse,base64,hashlib,json,os,re
from pathlib import Path
P=Path(__file__).resolve().parent
E=Path(os.environ.get('OXY_I09_PREPARED_INPUTS','/home/nate/Oxy/.agent-evidence/i04-i09-runtime-693-alia449-20261004'))
IMAGE_API='237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:b8d0d2f2325bf6d2a5a0df0f414185dfb940c48dc528cff794fa3820a3a2c534'
EXTRACT=Path('/home/nate/Oxy/.agent-evidence/i04-i03-live-canary-20261004/image-base-api')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,o):
 with open(p,'x') as f: os.chmod(p,0o600);json.dump(o,f,indent=2);f.write('\n')
def module(name):return 'data:text/javascript;base64,'+base64.b64encode((P/name).read_bytes()).decode()
def prepare(destination):
 out=Path(destination);out.mkdir(mode=0o700,parents=False,exist_ok=False)
 previous=json.loads((E/'canary-operation.prepared.json').read_text());intent=previous['clientRequestId'];live=json.loads((E/'readiness-plan.json').read_text())['live'];assert live['image']==IMAGE_API
 pins={p:sha((EXTRACT/p).read_bytes()) for p in ['dist/config/postgres.js','dist/config/kaanaDataPlane.js','dist/services/httpKaanaClient.js','dist/services/kaanaProviderCostFeed.service.js']}
 invocation="""import {createRequire} from 'node:module';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
const require=createRequire('/app/packages/api/package.json');
const pins=PINS;for(const[path,digest]of Object.entries(pins)){if(createHash('sha256').update(readFileSync('/app/packages/api/'+path)).digest('hex')!==digest)throw new Error('image_module_changed');}
const {readCanaryObservation}=await import(OBSERVER);const{attestExactDeployments}=await import(RECONCILER);
try{if(process.cwd()!=='/app/packages/api'||process.env.KAANA_BASE_URL!=='https://kaana.ai')throw new Error('context_changed');
const observation=await readCanaryObservation(process.env.DATABASE_URL,INTENT);if(observation.metered.length||observation.attempts.length)throw new Error('intent_exists');
const registry=await attestExactDeployments(require('/app/packages/api/dist/services/httpKaanaClient.js').createHttpKaanaCatalogueReader());
const result={kind:'i09-baseline-attestation-v1',intent:INTENT,observation,registry};const raw=JSON.stringify(result);if(Buffer.byteLength(raw)>100000)throw new Error('result_bound');
console.log('OXY_I09_RESULT '+JSON.stringify({kind:result.kind,intent:INTENT,sha256:createHash('sha256').update(raw).digest('hex'),data:Buffer.from(raw).toString('base64')}));
}catch{console.log('OXY_I09_FAILURE '+JSON.stringify({kind:'baseline',intent:INTENT,code:'baseline_or_signed_attestation_failed'}));process.exitCode=1;}
""".replace('PINS',json.dumps(pins)).replace('OBSERVER',json.dumps(module('read-canary-observation.mjs'))).replace('RECONCILER',json.dumps(module('canary-reconciliation.mjs'))).replace('INTENT',json.dumps(intent))
 definition={'family':'oxy-i09-exact-baseline','executionRoleArn':live['executionRoleArn'],'networkMode':'awsvpc','requiresCompatibilities':['FARGATE'],'cpu':live['cpu'],'memory':live['memory'],'runtimePlatform':live['runtimePlatform'],'volumes':[],'containerDefinitions':[{'name':'i09','image':IMAGE_API,'essential':True,'entryPoint':['/usr/local/bin/node'],'command':['--input-type=module','-e',invocation],'workingDirectory':'/app/packages/api','environment':[{'name':'NODE_ENV','value':'production'},{'name':'KAANA_BASE_URL','value':'https://kaana.ai'},{'name':'KAANA_EDGE_SIGNING_KEY_ID','value':'oxy-edge-2026-08-17'}],'secrets':[live['databaseSecret'],{'name':'KAANA_EDGE_SIGNING_PRIVATE_KEY','valueFrom':'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/KAANA_EDGE_SIGNING_PRIVATE_KEY'}],'portMappings':[],'mountPoints':[],'volumesFrom':[],'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-group':live['logGroup'],'awslogs-region':'us-west-2','awslogs-stream-prefix':live['logStreamPrefix']}}}]}
 write(out/'baseline-definition.json',definition)
 # Existing reviewed real caller is rebound to current exact source bytes; no execution.
 caller=json.loads((E/'canary-definition.prepared.json').read_text());command=caller['containerDefinitions'][0]['command'];script=command[-1];m=re.search(r"Buffer.from\('([A-Za-z0-9+/=]+)'",script);assert m
 packed=json.loads(base64.b64decode(m[1]));assert packed['sources']['pilot-canary.mjs']==(P/'pilot-canary.original.mjs').read_text();packed['sources']['pilot-canary.mjs']=(P/'pilot-canary.mjs').read_text()
 # The invocation's input contains source hashes keyed by source path.
 for name in packed:
  if isinstance(packed[name],dict) and name!='sources' and 'pilot-canary.mjs' in packed[name]: packed[name]['pilot-canary.mjs']=sha((P/'pilot-canary.mjs').read_bytes())
 command[-1]=script[:m.start(1)]+base64.b64encode(json.dumps(packed).encode()).decode()+script[m.end(1):]
 write(out/'caller-definition.json',caller)
 plan={'kind':'i09-prepared-baseline-and-caller-v1','intent':intent,'operatorOnly':True,'executionReady':False,'definitions':{name:sha((out/name).read_bytes()) for name in ['baseline-definition.json','caller-definition.json']},'sourcePins':pins,'inputs':{name:sha((P/name).read_bytes()) for name in ['pilot-canary.mjs','read-canary-observation.mjs','canary-reconciliation.mjs','stage-inference-credential.mjs','oxy-inference-credential.js']},'api':{'definition':'oxy-oxy-api:693','image':IMAGE_API,'network':live['network']},'alia':{'definition':'oxy-alia:449','image':previous['image'],'network':previous['network']},'prerequisites':['Root reviews definitions and current TD/runtime/config pins before registration.','Root executes baseline first; exact intent must be absent and all three signed tuples attest.','Root reviews the post-observation/feed-replay plan before the only inference operation.','Do not run caller after uncertain prior ACK: reconcile this exact intent first.'],'scope':{'baseline':'Read-only SQL and signed Kaana deployment query, no inference','caller':'Canonical workload mint, one real inference and same-key 409 probe','post':'Separate exact SQL/feed reconciliation, no second inference'}}
 write(out/'plan.json',plan);print(json.dumps({'prepared':True,'path':str(out),'planSha256':sha((out/'plan.json').read_bytes())}))
def prepare_post(destination,operation,baseline_file,canary_file):
 op=Path(operation);plan=json.loads((op/'plan.json').read_text());baseline=json.loads(Path(baseline_file).read_text());canary=json.loads(Path(canary_file).read_text())
 assert baseline['kind']=='i09-baseline-attestation-v1' and baseline['intent']==plan['intent']==canary['clientRequestId'] and canary['ok'] is True
 assert all(sha((P/name).read_bytes())==digest for name,digest in plan['inputs'].items())
 out=Path(destination);out.mkdir(mode=0o700,parents=False,exist_ok=False)
 definition=json.loads((op/'baseline-definition.json').read_text());assert sha((op/'baseline-definition.json').read_bytes())==plan['definitions']['baseline-definition.json']
 definition['family']='oxy-i09-exact-feed-replay'
 invocation="""import{createRequire}from'node:module';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
const require=createRequire('/app/packages/api/package.json'),pins=PINS;
const input=INPUT;let connection;
try{if(process.cwd()!=='/app/packages/api'||process.env.KAANA_BASE_URL!=='https://kaana.ai')throw new Error('context_changed');for(const[path,digest]of Object.entries(pins)){if(createHash('sha256').update(readFileSync('/app/packages/api/'+path)).digest('hex')!==digest)throw new Error('image_module_changed');}
const{readCanaryObservation}=await import(OBSERVER);const{requireSettledOperation,readExactFeedEvents,replayConfirmedEvents}=await import(RECONCILER);
const read=()=>readCanaryObservation(process.env.DATABASE_URL,input.baseline.intent);const beforeReplay=await read();requireSettledOperation(input.baseline.observation,beforeReplay,input.canary);
const feedModule=require('/app/packages/api/dist/services/kaanaProviderCostFeed.service.js');const reader=feedModule.createHttpKaanaProviderCostFeedReader();const feed=await readExactFeedEvents(reader,input.canary.requestId,input.baseline.observation.cursor?.cursor??null);
connection=require('/app/packages/api/dist/config/postgres.js');await connection.connectPostgres();const replay=await replayConfirmedEvents({events:feed.events,observation:beforeReplay,feedModule,readAfter:read});
const result={kind:'i09-final-exact-reconciliation-v1',intent:input.baseline.intent,canary:input.canary,observation:beforeReplay,feed:{pages:feed.pages,caughtUp:feed.caughtUp,lastCursor:feed.lastCursor,eventsSha256:createHash('sha256').update(JSON.stringify(feed.events)).digest('hex'),eventCount:feed.events.length},replay};const raw=JSON.stringify(result);if(Buffer.byteLength(raw)>100000)throw new Error('result_bound');console.log('OXY_I09_RESULT '+JSON.stringify({kind:result.kind,intent:input.baseline.intent,sha256:createHash('sha256').update(raw).digest('hex'),data:Buffer.from(raw).toString('base64')}));
}catch{console.log('OXY_I09_FAILURE '+JSON.stringify({kind:'reconciliation',intent:input.baseline.intent,code:'exact_reconciliation_failed_no_inference_retry'}));process.exitCode=1;}finally{if(connection)await connection.closePostgres();}
""".replace('PINS',json.dumps(plan['sourcePins'])).replace('INPUT',json.dumps({'baseline':baseline,'canary':canary})).replace('OBSERVER',json.dumps(module('read-canary-observation.mjs'))).replace('RECONCILER',json.dumps(module('canary-reconciliation.mjs')))
 definition['containerDefinitions'][0]['command']=['--input-type=module','-e',invocation];write(out/'post-definition.json',definition)
 write(out/'post-plan.json',{'kind':'i09-exact-post-plan-v1','intent':plan['intent'],'definitionSha256':sha((out/'post-definition.json').read_bytes()),'baselineFileSha256':sha(Path(baseline_file).read_bytes()),'canaryFileSha256':sha(Path(canary_file).read_bytes()),'operationPlanSha256':sha((op/'plan.json').read_bytes()),'network':plan['api']['network'],'operatorOnly':True})
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--output',required=True);a.add_argument('--operation');a.add_argument('--baseline');a.add_argument('--canary');v=a.parse_args()
 if v.operation:
  assert v.baseline and v.canary;prepare_post(v.output,v.operation,v.baseline,v.canary)
 else:prepare(v.output)
