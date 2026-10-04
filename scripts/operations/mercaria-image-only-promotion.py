#!/usr/bin/env python3
"""Closed ROOT-operated Mercaria image-only rolling promotion from accepted TD61. Prepare reads only.

Reuses the reviewed consumer TD/image protocols. No DB/provider/SSM/IAM writes,
no image publishing, no old-image rollback, and no retry of AWS mutation ACKs.
"""
import argparse, copy, datetime, hashlib, importlib.util, json, os
from pathlib import Path
import re, subprocess, time, urllib.request
ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'scripts/operations/consumer-promotion.py'
BASE_SHA = '6498df2458bfa407c3905e0ebd824c766b7af1beecc3d1b1a0d5770be9dca83b'
assert hashlib.sha256(BASE.read_bytes()).hexdigest() == BASE_SHA
spec = importlib.util.spec_from_file_location('reviewed_promotion', BASE)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SERVICE = 'mercaria'; CLUSTER = 'oxy-cluster'
PREFIX = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-mercaria:'
OLD_TD = PREFIX + '61'
OLD_IMAGE = '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mercaria@sha256:36b6db86db15d8b25d726c467ed83dc9b4e19a425b5d5be724517e22f45a20fb'
COHORT = {'merchantId':'merch_bd106296a0fef49a861ee6b7','applicationId':'6a37d0cc5d4b5f15482a9340','environment':'production','platformAccountId':'acct_1TnXkUQWiCE02OnU','livemode':True,'storeIds':['6a39a7d5b5809e55ba556ad0','6a77367c30650db22f728092']}
COHORT_SHA = hashlib.sha256(json.dumps(COHORT,separators=(',',':')).encode()).hexdigest()
POSITIVE = {'msg':'Merchant billing cohort registered','cohortSha256':COHORT_SHA,'mode':'live','environment':'production','storeCount':2}
SSM = 'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/mercaria/'
ALIASES = {'PEABLE_APP_PUBLIC_KEY':'OXY_APPLICATION_KEY','PEABLE_APP_SECRET':'OXY_APPLICATION_SECRET'}
RECIPE = {'repository':'OxyHQ/Mercaria','ecrRepository':'oxy/mercaria','dockerfile':'Dockerfile','dockerfileSha256':'5f93c981c46906d9e5cf117566fa173058f15e08023dceea7a2c2fa9c8f6cac2','target':None}
SERVICE_FIELDS = ('serviceArn','serviceName','clusterArn','desiredCount','loadBalancers','serviceRegistries','networkConfiguration','deploymentConfiguration','capacityProviderStrategy','launchType','platformVersion','schedulingStrategy','enableECSManagedTags','propagateTags','enableExecuteCommand','healthCheckGracePeriodSeconds','placementConstraints','placementStrategy')
class UnknownAck(RuntimeError): pass

def need(v,label):
    if not v: raise ValueError(label)
def digest(v): return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,v): m.f.private_json(p,v)
def ref(p): return m.ref(p)
def load(v): return m.read_ref(v)
def aws(*args,write=False):
    for attempt in range(1 if write else 3):
        try:
            r=subprocess.run(['aws','--profile','oxy','--region','us-west-2','--cli-connect-timeout','10','--cli-read-timeout','90',*args,'--output','json'],capture_output=True,timeout=120,env=dict(os.environ,AWS_MAX_ATTEMPTS='1'))
            if r.returncode==0:return json.loads(r.stdout or '{}')
        except subprocess.TimeoutExpired: pass
        if write: raise UnknownAck('AWS mutation acknowledgment unknown; reconcile durable intent')
        if attempt==2:raise ValueError('aws_read_failed')
        time.sleep(2)
m.f.aws = aws

def service():
    r=aws('ecs','describe-services','--cluster',CLUSTER,'--services',SERVICE)
    need(not r.get('failures') and len(r.get('services',[]))==1,'service_census');return r['services'][0]
def td(arn):
    need(re.fullmatch(re.escape(PREFIX)+r'[1-9][0-9]*',arn),'foreign_td')
    r=aws('ecs','describe-task-definition','--task-definition',arn,'--include','TAGS')
    need(r['taskDefinition']['taskDefinitionArn']==arn,'td_identity');return r

def tags(r):
    rows=r.get('tags',[]);need(len({x['key'] for x in rows})==len(rows),'duplicate_tags')
    return sorted((x for x in rows if not x['key'].lower().startswith('aws:')),key=lambda x:x['key'])
def service_equal(a,b,zero=False):
    fields=[x for x in SERVICE_FIELDS if not (zero and x=='desiredCount')]
    need({k:a.get(k) for k in fields}=={k:b.get(k) for k in fields},'service_config_drift')
def steady(s):
    need(s['taskDefinition']==OLD_TD and 1<=s['desiredCount']<=4 and s['runningCount']==s['desiredCount'] and s['pendingCount']==0 and len(s['deployments'])==1 and s['deployments'][0]['rolloutState']=='COMPLETED','baseline_not_steady')
    need(s['deploymentConfiguration']['minimumHealthyPercent']==100 and s['deploymentConfiguration']['maximumPercent']==200,'rolling_availability_configuration')
    need(s['deploymentConfiguration']['deploymentCircuitBreaker']['enable'] is True and s['deploymentConfiguration']['deploymentCircuitBreaker']['rollback'] is False,'rollback_must_remain_disabled')
def render(raw,image):
    need(re.fullmatch(r'237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com/oxy/mercaria@sha256:[0-9a-f]{64}',image) is not None,'foreign_new_image')
    body=m.td_semantic(raw); selected=[c for c in body['containerDefinitions'] if c['name']==SERVICE]
    need(len(selected)==1 and selected[0]['image']==OLD_IMAGE and image!=OLD_IMAGE,'selected_image')
    c=selected[0]; env={x['name']:x['value'] for x in c.get('environment',[])}; secrets={x['name']:x['valueFrom'] for x in c.get('secrets',[])}
    need(not(set(env)&set(secrets)),'ambiguous_environment_secret')
    need(all(env.get(k,'false')=='false' and k not in secrets for k in ['STRIPE_ENABLED','MERCHANT_BILLING_ENABLED']),'mutable_rails_enabled')
    need('MERCHANT_BILLING_PEABLE_COHORT' not in secrets,'cohort_secret_forbidden')
    need(json.loads(env.get('MERCHANT_BILLING_PEABLE_COHORT','null'))==COHORT,'accepted_cohort_changed')
    need(secrets.get('STRIPE_SECRET_KEY')==SSM+'STRIPE_SECRET_KEY','existing_stripe_reference')
    for target,source in ALIASES.items():
        need(target not in env and secrets.get(source)==SSM+source and secrets.get(target)==secrets[source],'accepted_application_alias_changed')
    # Do not reconstruct the cohort value, aliases, flags, sidecars or roles.
    # This is the only changed field of the semantically normalized definition.
    c['image']=image
    return m.td_semantic(body)
def tasks(status):
    r=aws('ecs','list-tasks','--cluster',CLUSTER,'--service-name',SERVICE,'--desired-status',status)
    need(not r.get('nextToken') and len(r['taskArns'])<=100,'task_page_bound');return r['taskArns']
def describe(ids):
    if not ids:return []
    r=aws('ecs','describe-tasks','--cluster',CLUSTER,'--tasks',*sorted(ids))
    need(not r.get('failures') and {t['taskArn'] for t in r['tasks']}==set(ids),'task_census');return r['tasks']
def inputs_checked(config):
    need(set(config)=={'imageVerification','migrationVerification','acceptedPrerequisites'},'config_fields')
    identity=m.image_identity({'service':SERVICE,'imageVerification':config['imageVerification']},RECIPE)
    migration=load(config['migrationVerification'])
    need(set(migration)=={'kind','service','sourceSha','imageUri','mode','evidence'} and migration['kind']=='root-consumer-migration-verification-v1' and migration['service']==SERVICE and migration['sourceSha']==identity['sourceSha'] and migration['imageUri']==identity['imageUri'] and migration['mode']=='not-required','migration_binding')
    need(isinstance(migration['evidence'],list) and migration['evidence'],'migration_proof_absent')
    for r in migration['evidence']:load(r)
    p=load(config['acceptedPrerequisites'])
    need(set(p)=={'kind','cohort','merchantPortalAccepted','storesAccepted','peableCohortAccepted','canonical135Unchanged','shippingSdkVerified','evidence'} and p['kind']=='root-mercaria-cohort-prerequisites-v1' and p['cohort']==COHORT and all(p[k] is True for k in ['merchantPortalAccepted','storesAccepted','peableCohortAccepted','canonical135Unchanged','shippingSdkVerified']),'root_prerequisites')
    need(isinstance(p['evidence'],list) and p['evidence'],'prerequisite_proofs_absent')
    for r in p['evidence']:load(r)
    return identity

def prepare(config):
    identity=inputs_checked(config); s=service();steady(s); old=td(OLD_TD)
    body=render(old['taskDefinition'],identity['imageUri']); t=tags(old)
    if t:body['tags']=t
    rows=describe(set(tasks('RUNNING'))|set(tasks('STOPPED')))
    live=[x for x in rows if x['lastStatus']!='STOPPED'];need(len(live)==s['desiredCount'] and all(x['taskDefinitionArn']==OLD_TD and x['lastStatus']=='RUNNING' for x in live),'baseline_tasks')
    return {'kind':'mercaria-image-only-rolling-plan-v1','preparedAt':int(time.time()),'operatorArn':m.f.account(),'operatorSha256':sha(__file__),'consumerHelperSha256':BASE_SHA,'fleetHelperSha256':sha(ROOT/'scripts/operations/fleet-quiescence.py'),'config':config,'identity':identity,'baselineService':s,'baselineTd':old,'baselineTasks':[t['taskArn'] for t in live],'baselineTaskRows':live,'registration':body,'expectedRegistration':POSITIVE}
def validate(plan):
    need(set(plan)=={'kind','preparedAt','operatorArn','operatorSha256','consumerHelperSha256','fleetHelperSha256','config','identity','baselineService','baselineTd','baselineTasks','baselineTaskRows','registration','expectedRegistration'},'plan_fields')
    need(plan['kind']=='mercaria-image-only-rolling-plan-v1' and 0<=time.time()-plan['preparedAt']<=900,'plan_expired')
    need(plan['operatorSha256']==sha(__file__) and plan['consumerHelperSha256']==BASE_SHA and plan['fleetHelperSha256']==sha(ROOT/'scripts/operations/fleet-quiescence.py') and plan['operatorArn']==m.f.account(),'operator_or_source_changed')
    need({t['taskArn'] for t in plan['baselineTaskRows']}==set(plan['baselineTasks']),'baseline_task_binding')
    need(inputs_checked(plan['config'])==plan['identity'] and plan['expectedRegistration']==POSITIVE,'evidence_changed')
    expected=render(plan['baselineTd']['taskDefinition'],plan['identity']['imageUri']);t=tags(plan['baselineTd'])
    if t:expected['tags']=t
    need(expected==plan['registration'],'registration_delta')
    s=service();steady(s);service_equal(s,plan['baselineService']);need(s['deployments'][0]['id']==plan['baselineService']['deployments'][0]['id'],'deployment_changed')
    old=td(OLD_TD);need(m.td_semantic(old['taskDefinition'])==m.td_semantic(plan['baselineTd']['taskDefinition']) and tags(old)==t,'baseline_td_changed')

def log_matches(events):
    positive=False
    for e in events:
        for line in e.get('message','').splitlines():
            try:v=json.loads(line)
            except json.JSONDecodeError:continue
            if not isinstance(v,dict):continue
            need(v.get('msg')!='Merchant billing registration failed','registration_failed')
            if v.get('msg')==POSITIVE['msg']:
                need(all(v.get(k)==x for k,x in POSITIVE.items()),'registration_attestation_mismatch');positive=True
    return positive

def own_logs(task,body,out):
    c=next(c for c in body['containerDefinitions'] if c['name']==SERVICE); options=c['logConfiguration']['options']
    need(c['logConfiguration']['logDriver']=='awslogs' and options['awslogs-region']=='us-west-2','log_binding')
    token=None;events=[]; pages=0
    while pages<30:
        args=['logs','get-log-events','--log-group-name',options['awslogs-group'],'--log-stream-name',options['awslogs-stream-prefix']+'/'+SERVICE+'/'+task['taskArn'].rsplit('/',1)[1],'--start-time',str(int(datetime.datetime.fromisoformat(task['createdAt'].replace('Z','+00:00')).timestamp()*1000)),'--start-from-head']
        if token:args+=['--next-token',token]
        try:r=aws(*args)
        except ValueError:return False
        events+=r['events'];need(len(json.dumps(events).encode())<=4*1024*1024,'log_size_bound');pages+=1
        nxt=r.get('nextForwardToken');
        if not nxt or nxt==token:break
        token=nxt
    else:raise ValueError('log_page_bound')
    p=out/('logs-'+task['taskArn'].rsplit('/',1)[1]+'-'+str(time.time_ns())+'.private.json');save(p,{'events':events})
    return log_matches(events)

def public_smoke():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*_):raise ValueError('public_redirect')
    evidence=[]
    for path in ['/health','/health/ready']:
        req=urllib.request.Request('https://api.mercaria.co'+path,headers={'User-Agent':'OxyHQ-Mercaria1519ReadonlyVerifier/1.0'})
        with urllib.request.build_opener(NoRedirect).open(req,timeout=30) as r:
            raw=r.read(100001);need(r.status==200 and len(raw)<=100000 and not r.headers.get_all('Set-Cookie'),'public_smoke');evidence.append({'path':path,'status':r.status,'bodySha256':hashlib.sha256(raw).hexdigest()})
    return evidence

def task_ips(rows):
    ips=set()
    for t in rows:
        ip=[x['value'] for a in t['attachments'] if a['type']=='ElasticNetworkInterface' for x in a['details'] if x['name']=='privateIPv4Address']
        need(len(ip)==1,'task_ip');ips.add(ip[0])
    need(len(ips)==len(rows),'duplicate_task_ip')
    return ips

def target_ready(targets,ips,old_ips,port):
    expected={(ip,port) for ip in ips}; retired={(ip,port) for ip in old_ips}-expected
    actual={(x['Target']['Id'],x['Target']['Port']) for x in targets}
    need(len(actual)==len(targets),'duplicate_targets')
    need(actual<=expected|retired and all((x['Target']['Id'],x['Target']['Port'])not in retired or x['TargetHealth']['State']=='draining' for x in targets),'foreign_targets')
    return actual==expected and all(x['TargetHealth']['State']=='healthy' for x in targets)

def monitor(plan,arn,out):
    deadline=time.monotonic()+1800; body=plan['registration'];old_ips=task_ips(plan['baselineTaskRows'])
    while time.monotonic()<deadline:
        s=service();service_equal(s,plan['baselineService']);need(s['taskDefinition']==arn and not any(d.get('rolloutState')=='FAILED' for d in s['deployments']),'rollout_failed_or_foreign')
        ids=set(tasks('RUNNING'))|set(tasks('STOPPED'));rows=describe(ids);live=[t for t in rows if t['lastStatus']!='STOPPED']
        ready=s['desiredCount']==s['runningCount'] and s['pendingCount']==0 and len(s['deployments'])==1 and s['deployments'][0]['rolloutState']=='COMPLETED'
        if ready:
            need(len(live)==s['desiredCount'],'steady_task_census');ips=task_ips(live)
            for t in live:
                need(t['taskDefinitionArn']==arn and t['lastStatus']=='RUNNING','runtime_td')
                c=[c for c in t['containers'] if c['name']==SERVICE];need(len(c)==1 and c[0]['lastStatus']=='RUNNING' and c[0]['imageDigest']==plan['identity']['imageUri'].split('@')[1],'runtime_image')
            healthy=True
            for lb in s['loadBalancers']:
                h=aws('elbv2','describe-target-health','--target-group-arn',lb['targetGroupArn']); targets=h['TargetHealthDescriptions']
                healthy&=target_ready(targets,ips,old_ips,lb['containerPort'])
            positive=all([own_logs(t,body,out) for t in live])
            if healthy and positive:
                smoke=public_smoke(); save(out/'accepted.json',{'kind':'mercaria-image-only-serving-acceptance-v1','accepted':True,'taskDefinition':arn,'image':plan['identity']['imageUri'],'tasks':live,'service':s,'expectedRegistration':POSITIVE,'everyTaskRegistrationPositive':True,'allTargetsHealthy':True,'publicSmoke':smoke,'providerOrFinancialMutations':False});return
        time.sleep(10)
    raise ValueError('serving_acceptance_timeout')

def execute(plan,out):
    validate(plan);out=m.f.outside(out);out.mkdir(mode=0o700);arn=None
    save(out/'review.json',{'planCanonicalSha256':digest(plan),'operatorSha256':sha(__file__),'rollingUpdateOnly':True,'automaticRollback':False})
    try:
        body=plan['registration'];save(out/'registration-intent.json',body)
        # Private file transport avoids AWS CLI argument-size limits; never retry registration.
        r=aws('ecs','register-task-definition','--cli-input-json','file://'+str(out/'registration-intent.json'),write=True);save(out/'registration-ack.json',r);arn=r['taskDefinition']['taskDefinitionArn'];read=td(arn)
        need(m.td_semantic(read['taskDefinition'])==m.td_semantic({k:v for k,v in body.items() if k!='tags'}) and tags(read)==body.get('tags',[]),'registered_td_drift');save(out/'registration-readback.json',read)
        validate(plan);save(out/'update-intent.json',{'service':SERVICE,'taskDefinition':arn,'baselineDefinition':OLD_TD})
        ack=aws('ecs','update-service','--cluster',CLUSTER,'--service',SERVICE,'--task-definition',arn,write=True);save(out/'update-ack.json',ack)
        monitor(plan,arn,out)
    except BaseException as error:
        save(out/'failure.json',{'errorType':type(error).__name__,'label':str(error) if isinstance(error,ValueError) else 'unknown_ack_or_transport_failure',
          'automaticMutationRetry':False,'automaticScaleZero':False,'automaticOldImageRollback':False,'rootReconciliationRequired':True,
          'baselineDefinition':OLD_TD,'intendedNewDefinition':arn,'preservedDesiredCount':plan['baselineService']['desiredCount'],
          'baselineImage':OLD_IMAGE,'recovery':'Root first reconciles task/deployment ACK and baseline health; explicit TD-only rollback to exact baseline61 may follow reviewed fresh readback. No count/scaler change.'})
        raise

def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='operation',required=True)
    a=sub.add_parser('prepare');a.add_argument('--config',required=True);a.add_argument('--output',required=True)
    a=sub.add_parser('execute');a.add_argument('--plan',required=True);a.add_argument('--sha256',required=True);a.add_argument('--output',required=True);a.add_argument('--execute',action='store_true',required=True)
    args=p.parse_args();os.umask(0o077)
    if args.operation=='prepare': save(m.f.outside(args.output),prepare(json.loads(Path(args.config).read_bytes())))
    else:need(sha(args.plan)==args.sha256,'plan_file_changed');execute(json.loads(Path(args.plan).read_bytes()),args.output)
if __name__=='__main__':main()
