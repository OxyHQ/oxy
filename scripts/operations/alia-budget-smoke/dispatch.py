#!/usr/bin/env python3
"""Root-only, one-shot dispatcher. Never imported/executed by preparation/tests.
No retry of RegisterTaskDefinition/RunTask; unknown ACK requires exact census.
"""
import argparse,base64,hashlib,json,os,re,signal,subprocess,time
from pathlib import Path
REGION='us-west-2';CLUSTER='oxy-cluster';ACCOUNT='237343248947'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def write(path,value):
 with open(path,'x')as f:os.chmod(path,0o600);json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
class AwsOperationFailure(RuntimeError):
 def __init__(self,action,category,code=None):
  self.diagnostic={'stage':'aws.'+action,'category':category,'code':code}
  super().__init__('AWS '+action+' '+category+((' '+code)if code else ''))
def aws(*args):
 env={**os.environ,'AWS_MAX_ATTEMPTS':'1'}
 try:r=subprocess.run(['aws',*args,'--region',REGION,'--output','json','--cli-connect-timeout','20','--cli-read-timeout','80'],env=env,capture_output=True,text=True,timeout=90)
 except subprocess.TimeoutExpired:raise AwsOperationFailure('.'.join(args[:2]),'timeout_outcome_unknown')from None
 if r.returncode:
  match=re.search(r'An error occurred \(([A-Za-z][A-Za-z0-9]{1,64})\)',r.stderr)
  raise AwsOperationFailure('.'.join(args[:2]),'service_error'if match else 'transport_or_cli_failure',match.group(1)if match else None)
 try:return json.loads(r.stdout)
 except (ValueError,TypeError):raise AwsOperationFailure('.'.join(args[:2]),'invalid_json')from None
def named(rows):
 need(isinstance(rows,list)and all(isinstance(r,dict)and isinstance(r.get('name'),str)for r in rows),'named_shape')
 need(len({r['name']for r in rows})==len(rows),'named_duplicates');return sorted(rows,key=lambda r:r['name'])
def validate_definition(actual,expected):
 for k in ['family','taskRoleArn','executionRoleArn','networkMode','cpu','memory','runtimePlatform']:
  need(actual.get(k)==expected.get(k),'registered_'+k)
 for k in ['volumes','placementConstraints','inferenceAccelerators']:need(not actual.get(k),'extra_'+k)
 for k in ['proxyConfiguration','ipcMode','pidMode','enableFaultInjection']:need(not actual.get(k),'extra_'+k)
 need(actual.get('requiresCompatibilities')==['FARGATE'],'compatibility')
 c=actual.get('containerDefinitions',[]);need(len(c)==1,'container_count');c=c[0];e=expected['containerDefinitions'][0]
 for k in ['name','image','essential','entryPoint','command','workingDirectory','logConfiguration']:need(c.get(k)==e[k],'registered_container_'+k)
 for k in ['environment','secrets']:need(named(c.get(k,[]))==named(e[k]),'registered_container_'+k)
 for k in ['mountPoints','volumesFrom','portMappings','environmentFiles','ulimits','systemControls','dependsOn','resourceRequirements','extraHosts','links']:need(not c.get(k),'extra_container_'+k)
 for k in ['privileged','linuxParameters','dockerSecurityOptions','user','healthCheck','firelensConfiguration','credentialSpecs','repositoryCredentials']:need(not c.get(k),'extra_container_'+k)
def decode(events,plan):
 results=[]
 for e in events:
  m=e.get('message','')
  if not m.startswith('OXY_ALIA_BUDGET '):continue
  p=json.loads(m.split(' ',1)[1]);need(p['nonce']==plan['nonce']and p['intent']==plan['intent'],'packet_binding')
  raw=base64.b64decode(p['data'],validate=True);need(len(raw)<50000 and sha(raw)==p['sha256'],'packet_hash')
  r=json.loads(raw);need(r['kind']in ['alia-budget-smoke-send','alia-budget-smoke-result-v1','alia-budget-smoke-failure','alia-budget-smoke-inventory','alia-budget-smoke-cost-observation'],'packet_kind')
  results.append(r)
 final=[r for r in results if r['kind']!='alia-budget-smoke-send'];need(len(final)==1,'final_result_missing_or_duplicate')
 sends=[r for r in results if r['kind']=='alia-budget-smoke-send'];need(len(sends)<=(1 if plan['mode']=='invoke'else 0),'send_count')
 return {'result':final[0],'send':sends[0]if sends else None}
def preflight(plan):
 need(aws('sts','get-caller-identity')['Account']==ACCOUNT,'aws_account')
 b=plan['binding']
 for name,td,container in [('oxy-api',b['oxyDefinition'],'oxy-api'),('alia',b['aliaDefinition'],'alia')]:
  r=aws('ecs','describe-services','--cluster',CLUSTER,'--services',name);need(not r.get('failures')and len(r['services'])==1,'service_missing');s=r['services'][0]
  need(s['taskDefinition']==td and s['desiredCount']==s['runningCount']>0 and s['pendingCount']==0,'service_not_stable')
  need(len(s['deployments'])==1 and s['deployments'][0]['rolloutState']=='COMPLETED'and s['deployments'][0]['status']=='PRIMARY','deployment_incomplete')
  d=aws('ecs','describe-task-definition','--task-definition',td)['taskDefinition']
  need(d['status']=='ACTIVE','definition_inactive')
  if name=='oxy-api':
   cs=[x for x in d['containerDefinitions']if x['name']==container];need(len(cs)==1 and cs[0]['image']==b['image'],'image_changed');need(s['networkConfiguration']==plan['network'],'network_changed')
  else:need(d['taskRoleArn']=='arn:aws:iam::237343248947:role/oxy-alia-task','alia_role_changed')
  for status in ['RUNNING','PENDING']:
   tasks=aws('ecs','list-tasks','--cluster',CLUSTER,'--family',plan['family'],'--desired-status',status)['taskArns'];need(not tasks,'smoke_peer_active')
def execute(plan_path,output):
 plan_path=Path(plan_path);plan=json.loads(plan_path.read_text());definition_path=plan_path.with_name('definition.json')
 need(plan['dispatchSha256']==sha(Path(__file__).read_bytes()),'dispatch_source_changed')
 need(plan['kind']=='alia-budget-smoke-plan-v1' and 0<=time.time()-plan['preparedAt']<=300,'stale_or_wrong_plan')
 need(sha(definition_path.read_bytes())==plan['definitionSha256'],'definition_changed')
 definition=json.loads(definition_path.read_text());validate_definition(definition,definition)
 need(definition['containerDefinitions'][0]['image']==plan['binding']['image'],'image_changed')
 if plan['mode']=='inventory':
  need(definition['family']=='oxy-alia-budget-smoke-readonly' and not definition.get('taskRoleArn'),'inventory_authority')
  need(definition['containerDefinitions'][0]['secrets']==[{'name':'DATABASE_URL','valueFrom':'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL'}],'inventory_secret')
 else:
  need(plan['mode']in ['invoke','reconcile'] and definition['family']=='oxy-alia-production-budget-smoke' and definition['taskRoleArn']=='arn:aws:iam::237343248947:role/oxy-alia-task' and definition['containerDefinitions'][0]['secrets']==[],'caller_authority')
 preflight(plan);write(plan_path.with_name('dispatch-once.json'),{'planSha256':sha(plan_path.read_bytes()),'intent':plan['intent'],'mode':plan['mode']});out=Path(output);out.mkdir(mode=0o700,parents=False,exist_ok=False)
 write(out/'plan.json',plan);write(out/'register-intent.json',definition)
 registered=None;task=None;register_unknown=False;dispatch_unknown=False;failures=[]
 try:
  register_unknown=True;r=aws('ecs','register-task-definition','--cli-input-json','file://'+str((out/'register-intent.json').resolve()));registered=r['taskDefinition']['taskDefinitionArn'];register_unknown=False;write(out/'register-ack.json',r)
  td=aws('ecs','describe-task-definition','--task-definition',registered)['taskDefinition'];validate_definition(td,definition);write(out/'registered-readback.json',td)
  request={'cluster':CLUSTER,'taskDefinition':registered,'count':1,'launchType':'FARGATE','networkConfiguration':plan['network'],'startedBy':plan['startedBy'],'clientToken':plan['clientToken']}
  write(out/'run-intent.json',request);dispatch_unknown=True;r=aws('ecs','run-task','--cli-input-json','file://'+str((out/'run-intent.json').resolve()));write(out/'run-ack.json',r)
  tasks=r.get('tasks',[]);need(not r.get('failures')and len(tasks)==1,'run_task_ambiguous');task=tasks[0]['taskArn'];dispatch_unknown=False
  deadline=time.monotonic()+600
  while time.monotonic()<deadline:
   read=aws('ecs','describe-tasks','--cluster',CLUSTER,'--tasks',task);need(not read.get('failures')and len(read['tasks'])==1,'task_missing');t=read['tasks'][0]
   need(t['taskDefinitionArn']==registered and t.get('startedBy')==plan['startedBy'],'task_binding')
   if t['lastStatus']=='STOPPED':break
   time.sleep(5)
  need(t['lastStatus']=='STOPPED','task_timeout');write(out/'task-stopped.json',read)
  stream=plan['binding']['logStreamPrefix']+'/smoke/'+task.rsplit('/',1)[1]
  log=aws('logs','get-log-events','--log-group-name','/oxy/ecs','--log-stream-name',stream,'--start-from-head');write(out/'logs.private.json',log)
  decoded=decode(log['events'],plan);write(out/'result.private.json',decoded)
  need(t['containers'][0].get('exitCode')==0 and decoded['result'].get('ok')is True,'smoke_not_accepted')
 except BaseException as error:
  diagnostic=error.diagnostic if isinstance(error,AwsOperationFailure)else {'stage':'operation_validation','category':'interrupted'if isinstance(error,KeyboardInterrupt)else 'validation_or_decode_failure','code':str(error)if isinstance(error,RuntimeError)and re.fullmatch('[A-Za-z_]{1,100}',str(error))else None}
  write(out/'failure.json',diagnostic)
  raise
 finally:
  if task:
   try:
    read=aws('ecs','describe-tasks','--cluster',CLUSTER,'--tasks',task);t=read['tasks'][0];need(t['taskDefinitionArn']==registered and t.get('startedBy')==plan['startedBy'],'cleanup_binding')
    if t['lastStatus']!='STOPPED':aws('ecs','stop-task','--cluster',CLUSTER,'--task',task,'--reason','Owned bounded Alia smoke cleanup')
    limit=time.monotonic()+120
    while t['lastStatus']!='STOPPED'and time.monotonic()<limit:
     time.sleep(5);t=aws('ecs','describe-tasks','--cluster',CLUSTER,'--tasks',task)['tasks'][0]
    need(t['lastStatus']=='STOPPED','stop_unconfirmed')
   except BaseException:failures.append('task_cleanup_unconfirmed')
  inactive=False
  if registered:
   try:
    aws('ecs','deregister-task-definition','--task-definition',registered);inactive=aws('ecs','describe-task-definition','--task-definition',registered)['taskDefinition']['status']=='INACTIVE';need(inactive,'definition_cleanup_unconfirmed')
   except BaseException:failures.append('definition_cleanup_unconfirmed')
  write(out/'cleanup.json',{'taskArn':task,'taskDefinitionArn':registered,'taskStopped':bool(task)and'task_cleanup_unconfirmed'not in failures,'definitionInactive':inactive,'registrationOutcomeUnknown':register_unknown,'dispatchOutcomeUnknown':dispatch_unknown,'failures':failures})
  need(not failures and not register_unknown and not dispatch_unknown,'cleanup_or_dispatch_unknown_requires_exact_reconciliation')
if __name__=='__main__':
 def interrupted(*_):
  signal.signal(signal.SIGTERM,signal.SIG_IGN);raise KeyboardInterrupt()
 signal.signal(signal.SIGTERM,interrupted)
 a=argparse.ArgumentParser();a.add_argument('--plan',required=True);a.add_argument('--output',required=True);v=a.parse_args()
 try:execute(v.plan,v.output)
 except BaseException as error:
  diagnostic=error.diagnostic if isinstance(error,AwsOperationFailure)else {'stage':'prepare_or_operation','category':'failed','code':None}
  print(json.dumps({'failed':True,'diagnostic':diagnostic,'instruction':'Inspect original intent and cleanup; never retry inference.'}),file=os.sys.stderr);raise SystemExit(1)
