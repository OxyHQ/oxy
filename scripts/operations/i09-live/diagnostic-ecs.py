#!/usr/bin/env python3
"""Closed exact-intent SQL/feed diagnostic; no inference or ingestion path."""
import argparse,base64,hashlib,importlib.util,json,os,pathlib,re,sys,time
HERE=pathlib.Path(__file__).resolve().parent
BASE=pathlib.Path('/home/nate/Oxy/.agent-evidence/i04-i09-runtime-693-alia449-20261004')
SOURCE_SHA='af1a79f1f2504717e74e2d1943ded3b379917ccb72274dd71eef6295dfa6be70'
KIND='i09-exact-readonly-diagnostic-v1'
FAMILY='oxy-i09-exact-readonly-diagnostic'
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def load_operation():
 p=HERE/'operation-ecs.py';assert sha(p)==SOURCE_SHA
 spec=importlib.util.spec_from_file_location('closed_i09_operation',p);op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op);op.PROFILES['post']['family']=FAMILY;op.decode=decode;return op

def decode(events,nonce):
 packets=[json.loads(e['message'].split(' ',1)[1])for e in events if e['message'].startswith('OXY_I09_RESULT ')]
 assert len(packets)==1 and not any(e['message'].startswith('OXY_I09_FAILURE ')for e in events)
 p=packets[0];assert set(p)=={'kind','intent','sha256','data'} and p['kind']==KIND and p['intent']=='oxy1519-i09-1791093169991-608bdb4f0ed0e8b0'
 assert isinstance(p['data'],str) and len(p['data'])<=140000
 raw=base64.b64decode(p['data'],validate=True);assert len(raw)<=100000 and hashlib.sha256(raw).hexdigest()==p['sha256'];r=json.loads(raw)
 assert set(r)=={'kind','intent','requestId','readOnly','writerCalls','inferenceCalls','chronology','baselineCounts','sql','settledGuard','feed'}
 assert r['kind']==KIND and r['intent']==p['intent'] and r['requestId']=='6c937204-26ae-4309-bba8-ef0ffdb9c07b' and r['readOnly'] is True and r['writerCalls']==0 and r['inferenceCalls']==0
 assert isinstance(r['chronology'],list) and 1<=len(r['chronology'])<=4 and all(x['stage']in['sql_observation','settled_guard','signed_feed_read','feed_sql_facts']for x in r['chronology'])
 if r['sql'] is not None:
  s=r['sql'];assert s['readOnly'] is True and s['isolation']=='repeatable read' and 0<=s['meteredCount']<=1 and 0<=s['attemptCount']<=64 and len(s['metered'])==s['meteredCount'] and len(s['attempts'])==s['attemptCount']
  assert set(s['money'])=={'account_balances','billing_ledger_entries','usage_reservations','usage_receipts'}
  for x in s['money'].values():
   assert isinstance(x['unchanged'],bool)
   for side in ['before','after']:assert set(x[side])=={'count','sha256'} and re.fullmatch('[0-9]+',x[side]['count']) and re.fullmatch('[a-f0-9]{64}',x[side]['sha256'])
 if r['feed'] is not None and r['feed']['passed']:
  f=r['feed'];assert 1<=f['eventCount']<=64 and len(f['events'])==f['eventCount'] and 1<=f['pages']<=20 and f['caughtUp'] is True
  assert all(e['requestId']==r['requestId'] and isinstance(e['sqlRowExists'],bool) and isinstance(e['digestMatches'],bool)for e in f['events'])
 return r

def module(source):return 'data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
def prepare(op,directory):
 out=pathlib.Path(directory);out.mkdir(mode=0o700,exist_ok=False)
 old=BASE/'operation-v3/plan.json';oldplan=json.loads(old.read_text());baseline=BASE/'baseline-run/result.private.json';canary=BASE/'caller-run/result.private.json'
 pins=oldplan['sourcePins'];assert all(sha(HERE/name)==digest for name,digest in oldplan['inputs'].items())
 definition=json.loads((BASE/'post-v1/post-definition.json').read_text());definition['family']=FAMILY
 diagnostic=(HERE/'diagnose-exact-operation.mjs').read_text();assert diagnostic.count("'./canary-reconciliation.mjs'")==1
 diagnostic=diagnostic.replace("'./canary-reconciliation.mjs'",json.dumps(module((HERE/'canary-reconciliation.mjs').read_text())))
 invocation="""import{createRequire}from'node:module';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
const require=createRequire('/app/packages/api/package.json'),pins=PINS,input=INPUT;
try{if(process.cwd()!=='/app/packages/api'||process.env.KAANA_BASE_URL!=='https://kaana.ai')throw new Error('context_changed');for(const[path,digest]of Object.entries(pins)){if(createHash('sha256').update(readFileSync('/app/packages/api/'+path)).digest('hex')!==digest)throw new Error('image_module_changed');}
const{readCanaryObservation}=await import(OBSERVER);const{diagnoseExactOperation}=await import(DIAGNOSTIC);const feedModule=require('/app/packages/api/dist/services/kaanaProviderCostFeed.service.js');
const result=await diagnoseExactOperation({baseline:input.baseline,canary:input.canary,read:()=>readCanaryObservation(process.env.DATABASE_URL,input.baseline.intent),feedModule});const raw=JSON.stringify(result);if(Buffer.byteLength(raw)>100000)throw new Error('result_bound');console.log('OXY_I09_RESULT '+JSON.stringify({kind:result.kind,intent:result.intent,sha256:createHash('sha256').update(raw).digest('hex'),data:Buffer.from(raw).toString('base64')}));
}catch{console.log('OXY_I09_FAILURE '+JSON.stringify({kind:'readonly_diagnostic',code:'diagnostic_bootstrap_failed'}));process.exitCode=1;}
""".replace('PINS',json.dumps(pins)).replace('INPUT',json.dumps({'baseline':json.loads(baseline.read_text()),'canary':json.loads(canary.read_text())})).replace('OBSERVER',json.dumps(module((HERE/'read-canary-observation.mjs').read_text()))).replace('DIAGNOSTIC',json.dumps(module(diagnostic)))
 definition['containerDefinitions'][0]['command']=['--input-type=module','-e',invocation];assert len(json.dumps(definition,separators=(',',':')).encode())<=60000
 op.private_json(out/'post-definition.json',definition)
 op.private_json(out/'post-plan.json',{'kind':'i09-exact-post-plan-v1','diagnosticOnly':True,'intent':oldplan['intent'],'definitionSha256':sha(out/'post-definition.json'),'baselineFileSha256':sha(baseline),'canaryFileSha256':sha(canary),'operationPlanSha256':sha(old)})
 sys.argv=[str(HERE/'operation-ecs.py'),'post','--post-plan',str(out/'post-plan.json'),'--plan',str(out/'dispatch-plan.json')];op.main()
 plan=json.loads((out/'dispatch-plan.json').read_text());binding={'wrapperSha256':sha(__file__),'diagnosticSha256':sha(HERE/'diagnose-exact-operation.mjs'),'planSha256':sha(out/'dispatch-plan.json'),'definitionSha256':sha(out/'post-definition.json'),'readonly':True,'noInference':True,'noIngestion':True}
 op.private_json(out/'diagnostic-binding.json',binding)

def main():
 p=argparse.ArgumentParser();p.add_argument('--prepare');p.add_argument('--directory');p.add_argument('--execute',action='store_true');p.add_argument('--output');a=p.parse_args();op=load_operation()
 if a.prepare:assert not a.execute;prepare(op,a.prepare);return
 assert a.execute and a.directory and a.output;d=pathlib.Path(a.directory);b=json.loads((d/'diagnostic-binding.json').read_text());assert b['wrapperSha256']==sha(__file__) and b['diagnosticSha256']==sha(HERE/'diagnose-exact-operation.mjs') and b['planSha256']==sha(d/'dispatch-plan.json') and b['definitionSha256']==sha(d/'post-definition.json')
 plan=json.loads((d/'dispatch-plan.json').read_text());assert plan['profile']=='post' and op.build_definition(plan)['family']==FAMILY
 op.execute(plan,a.output)
if __name__=='__main__':
 import signal
 def interrupted(signum,frame):signal.signal(signal.SIGTERM,signal.SIG_IGN);raise KeyboardInterrupt('operator interrupted')
 signal.signal(signal.SIGTERM,interrupted)
 try:main()
 except BaseException:print('I09 readonly diagnostic failed; inspect bounded evidence; no inference retry',file=sys.stderr);raise SystemExit(1)
