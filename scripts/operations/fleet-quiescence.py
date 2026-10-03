#!/usr/bin/env python3
"""External fleet cutover helper. Capture/observe are read-only; writes need --execute.

No SDK/database/IAM/publish/restore operation. Every scalar/count write has a
private fsynced intent before its one attempt. Unknown ACK blocks all advancement.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
ACCOUNT = '237343248947'
REGION = 'us-west-2'
CLUSTER = 'oxy-cluster'
CONSUMERS = ['crowdsource','move','mention','mention-mcp','alia-integrations','allo','tnp-api','relay',
    'clarity-api','noted','moovo','clarity-worker','homiio-worker','alia','relay-publisher','willo','peable',
    'syra','mercaria','website-api','nilo','goway','homiio']
API = 'oxy-api'
WORKER = 'oxy-asset-variant-worker'
AFFECTED = CONSUMERS + [API, WORKER]
EXCLUDED = ['gwj-mcp','allo-matrix','kaana','goway-routing','kaana-publisher','tnp-relay','gwj-backend','tnp-dns']
SERVICES = sorted(AFFECTED + EXCLUDED)
FLAGS = {'DynamicScalingInSuspended':True,'DynamicScalingOutSuspended':True,'ScheduledScalingSuspended':True}
SOURCE = 'scripts/operations/fleet-quiescence.py'
GUARD_PATHS = ['.github/scripts/guard-quiesced-deploy.mjs','.github/scripts/deploy-ecs-image.sh',
               '.github/scripts/deploy-quiesced-image.sh','.github/scripts/deploy-asset-variant-worker.sh','.github/workflows/deploy-aws.yml']
EXPECTED_GUARD_SHA = '83f0c0129e07cef65f433e2439a307ee683d447cb7533c2d0c2b0c51b760cc92'
EXPECTED_WORKFLOW_SHA = '0a1ca1132d65459be53a7e7d846a8dc19400d495173943474cd0f887e5556ca8'
SERVICE_CONFIG_FIELDS = ('networkConfiguration','deploymentConfiguration','loadBalancers','healthCheckGracePeriodSeconds',
    'placementConstraints','placementStrategy','capacityProviderStrategy','launchType','platformVersion',
    'enableExecuteCommand','enableECSManagedTags','propagateTags')
TASK_ARN = r'arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/[a-f0-9]{32}'
interrupted = False


def require(value, message):
    if not value: raise RuntimeError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def private_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as output:
        json.dump(value,output,indent=2);output.write('\n');output.flush();os.fsync(output.fileno())
    parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(parent)
    finally:os.close(parent)


def outside(path):
    p=Path(path).resolve();require(p!=ROOT and ROOT not in p.parents,'Private output must be outside checkout');return p


def handle_signal(_signum,_frame):
    global interrupted
    interrupted=True;raise InterruptedError('Interrupted; inspect private write intent')


def aws(*args):
    child=subprocess.Popen(['aws',*args,'--region',REGION,'--output','json','--no-cli-pager','--no-paginate'],
        text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    try:
        stdout,_=child.communicate(timeout=40)
        require(child.returncode==0,'AWS command failed; raw error withheld')
        require(len(stdout.encode())<=8*1024*1024,'AWS response exceeded bound')
        return json.loads(stdout)
    except BaseException:
        if child.poll() is None:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
        raise


def pages(args,key,token_key='nextToken',token_flag='--next-token',bound=2000):
    result=[];token=None;seen=set()
    for _ in range(32):
        response=aws(*args,*([token_flag,token]if token else []))
        require(isinstance(response.get(key),list),'Incomplete paged census')
        result.extend(response[key]);require(len(result)<=bound,'Census exceeded bound')
        token=response.get(token_key)
        if not token:return result
        require(isinstance(token,str) and token not in seen,'Pagination token repeated');seen.add(token)
    raise RuntimeError('Pagination exceeded bound')


def account():
    actor=aws('sts','get-caller-identity')
    require(actor.get('Account')==ACCOUNT and re.fullmatch(
        r'arn:aws:(?:iam|sts)::237343248947:(?:user/[A-Za-z0-9+=,.@_/-]+|assumed-role/[A-Za-z0-9+=,.@_-]+/[A-Za-z0-9+=,.@_-]+)',actor.get('Arn','')),
        'Wrong AWS operator/account')
    return actor['Arn']


def shape_hash(definition):
    # Same canonical shape as guard-quiesced-deploy.mjs. Environment VALUES are
    # hashed only in memory; no raw value or secret payload enters a snapshot.
    value=copy.deepcopy(definition)
    for field in ('taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy'):
        value.pop(field,None)
    return digest(value)


def definition(arn):
    require(re.fullmatch(r'arn:aws:ecs:us-west-2:237343248947:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*',arn),'Wrong task definition ARN')
    response=aws('ecs','describe-task-definition','--task-definition',arn)
    td=response.get('taskDefinition');require(isinstance(td,dict) and td.get('taskDefinitionArn')==arn,'Definition readback missing')
    safe={'arn':arn,'status':td['status'],'shapeSha256':shape_hash(td),
        'networkMode':td.get('networkMode'),'runtimePlatform':td.get('runtimePlatform'),
        'executionRoleArn':td.get('executionRoleArn'),'taskRoleArn':td.get('taskRoleArn'),
        'containers':[{'name':c['name'],'image':c['image'],
            'environmentNames':sorted(e['name']for e in c.get('environment',[])),
            'secretReferences':sorted(c.get('secrets',[]),key=lambda e:e['name']),
            'entrypointCommandSha256':digest({'entryPoint':c.get('entryPoint'),'command':c.get('command')}),
            'containerConfigSha256':digest(c)}for c in td['containerDefinitions']]}
    return safe


def tasks_for(service):
    arns=[]
    for desired in ('RUNNING','STOPPED'):
        arns+=pages(['ecs','list-tasks','--cluster',CLUSTER,'--service-name',service,'--desired-status',desired,'--max-results','100'],'taskArns')
    arns=sorted(set(arns));require(len(arns)<=500,'Service task census exceeded bound')
    return describe_tasks(arns,service)


def describe_tasks(arns,service=None):
    require(isinstance(arns,list) and len(arns)<=4000 and all(isinstance(arn,str) and re.fullmatch(TASK_ARN,arn)for arn in arns),'Task ids outside reviewed cluster')
    require(len(set(arns))==len(arns),'Duplicate task ids')
    rows=[]
    for index in range(0,len(arns),100):
        batch=arns[index:index+100];response=aws('ecs','describe-tasks','--cluster',CLUSTER,'--tasks',*batch)
        require(not response.get('failures') and len(response.get('tasks',[]))==len(batch),'Task readback missing/failures')
        require({task['taskArn']for task in response['tasks']}==set(batch),'Task census differs')
        for task in response['tasks']:
            if service:require(task.get('group')=='service:'+service,'Foreign task group')
            rows.append({'arn':task['taskArn'],'group':task.get('group'),'definition':task['taskDefinitionArn'],
                'lastStatus':task['lastStatus'],'desiredStatus':task['desiredStatus'],
                'containers':[{'name':c['name'],'image':c.get('image'),'digest':c.get('imageDigest'),'status':c.get('lastStatus')}
                              for c in task['containers']]})
    return sorted(rows,key=lambda row:row['arn'])


def scalers():
    rows=pages(['application-autoscaling','describe-scalable-targets','--service-namespace','ecs'],
        'ScalableTargets','NextToken',bound=500)
    selected=[row for row in rows if row['ResourceId'].startswith('service/'+CLUSTER+'/')]
    require(all(row.get('ServiceNamespace')=='ecs' and row.get('ScalableDimension')=='ecs:service:DesiredCount'for row in selected), 'Cluster scaler namespace/dimension differs')
    require(len({row['ResourceId']for row in selected})==len(selected),'Duplicate scaler')
    return {row['ResourceId'].rsplit('/',1)[1]:row for row in selected}


def schedules():
    scaling=pages(['application-autoscaling','describe-scheduled-actions','--service-namespace','ecs'],
        'ScheduledActions','NextToken',bound=500)
    scaling=[row for row in scaling if row['ResourceId'].startswith('service/'+CLUSTER+'/')]
    require(all(row.get('ServiceNamespace')=='ecs' and row.get('ScalableDimension')=='ecs:service:DesiredCount'for row in scaling), 'Cluster schedule namespace/dimension differs')
    scheduler=pages(['scheduler','list-schedules','--max-results','100'],'Schedules','NextToken',bound=500)
    rules=pages(['events','list-rules','--limit','100'],'Rules','NextToken',bound=500)
    event_rows=[]
    for row in rules:
        targets=pages(['events','list-targets-by-rule','--rule',row['Name'],'--limit','100'],'Targets','NextToken',bound=500)
        event_rows.append({'name':row['Name'],'state':row['State'],'schedule':row.get('ScheduleExpression'),
            'patternSha256':digest(row.get('EventPattern')),'targetsSha256':digest(targets),
            'targetArns':sorted(target['Arn']for target in targets)})
    return {'scaling':sorted(scaling,key=lambda row:row['ResourceId']),'scheduler':sorted(scheduler,key=lambda row:row['Arn']),
            'events':sorted(event_rows,key=lambda row:row['name'])}


def service_row(service,scaling=None):
    response=aws('ecs','describe-services','--cluster',CLUSTER,'--services',service)
    require(not response.get('failures') and len(response.get('services',[]))==1,'Service missing/ambiguous')
    row=response['services'][0]
    require(row.get('serviceName')==service and row.get('status')=='ACTIVE','Service identity/status differs')
    groups=sorted({entry['targetGroupArn']for entry in row.get('loadBalancers',[])})
    targets={group:aws('elbv2','describe-target-health','--target-group-arn',group).get('TargetHealthDescriptions') for group in groups}
    require(all(isinstance(v,list)for v in targets.values()),'Target health incomplete')
    return {'service':service,'definition':row['taskDefinition'],'desired':row['desiredCount'],'running':row['runningCount'],'pending':row['pendingCount'],
        'deployments':[{'id':d['id'],'status':d['status'],'rolloutState':d.get('rolloutState'),'definition':d['taskDefinition'],
                       'desired':d['desiredCount'],'running':d['runningCount'],'pending':d['pendingCount']}for d in row['deployments']],
        'network':row.get('networkConfiguration'),'deploymentConfiguration':row.get('deploymentConfiguration'),
        'loadBalancers':row.get('loadBalancers',[]),'healthCheckGracePeriodSeconds':row.get('healthCheckGracePeriodSeconds'),
        'placementConstraints':row.get('placementConstraints',[]),'placementStrategy':row.get('placementStrategy',[]),
        'capacityProviderStrategy':row.get('capacityProviderStrategy',[]),'launchType':row.get('launchType'),
        'platformVersion':row.get('platformVersion'),'serviceConfigSha256':digest({k:row.get(k)for k in SERVICE_CONFIG_FIELDS}),
        'serviceConfigExceptDeploymentSha256':digest({k:row.get(k)for k in SERVICE_CONFIG_FIELDS if k!='deploymentConfiguration'}),
        'tasks':tasks_for(service),'targetGroups':groups,'targets':targets,'scaler':(scaling if scaling is not None else scalers()).get(service)}


def cluster_active_tasks():
    arns=[]
    for desired in ('RUNNING','STOPPED'):
        arns+=pages(['ecs','list-tasks','--cluster',CLUSTER,'--desired-status',desired,'--max-results','100'],'taskArns',bound=4000)
    return [row for row in describe_tasks(sorted(set(arns)))if row['lastStatus']!='STOPPED']


def service_set():
    arns=pages(['ecs','list-services','--cluster',CLUSTER,'--max-results','100'],'serviceArns',bound=100)
    require(sorted(arn.rsplit('/',1)[1]for arn in arns)==SERVICES,'33-service set drifted')


def capture():
    actor=account();service_set()
    scaling=scalers();require(set(scaling)<=set(SERVICES),'Unknown cluster scaler')
    current={name:service_row(name,scaling)for name in SERVICES}
    definitions={arn:definition(arn)for arn in sorted({row['definition']for row in current.values()}|
        {task['definition']for row in current.values()for task in row['tasks']if task['lastStatus']!='STOPPED'})}
    active=cluster_active_tasks()
    require(all(row['group']in{'service:'+name for name in SERVICES}for row in active),'Standalone/foreign active task present')
    require({row['arn']for row in active}=={task['arn']for row in current.values()for task in row['tasks']if task['lastStatus']!='STOPPED'},
        'Service/cluster task census drifted')
    schedule=schedules()
    require(not schedule['scaling'] and not schedule['scheduler'] and not any(row['schedule']for row in schedule['events']),
        'Unreviewed scheduled startup/scaling present')
    return {'kind':'fleet-snapshot-v1','capturedAt':int(time.time()),'operatorArn':actor,'services':current,
            'definitions':definitions,'schedules':schedule,'clusterActiveTasks':active}


def baseline_stable(row):
    require(type(row['desired'])is int and 0<row['desired']<=100 and row['running']==row['desired'] and row['pending']==0,'Affected baseline not stable')
    require(len(row['deployments'])==1 and row['deployments'][0]['status']=='PRIMARY'
            and all(row['deployments'][0][key]==row[key]for key in ('desired','running','pending'))
            and row['deployments'][0]['rolloutState']=='COMPLETED','Affected deployment not completed')
    active=[task for task in row['tasks']if task['lastStatus']!='STOPPED']
    require(active and all(task['definition']==row['definition']for task in active),'Baseline live task definition mixed')
    for task in active:
        require(all(c['digest']and re.fullmatch(r'sha256:[a-f0-9]{64}',c['digest'])for c in task['containers']),'Runtime image digest missing')


def immutable_service(row):
    return {key:row[key]for key in ('service','definition','serviceConfigSha256','targetGroups')}


def assert_quiesced(row,previous):
    require(immutable_service(row)==immutable_service(previous),'Quiescence service config/TD changed')
    require(row['desired']==row['running']==row['pending']==0 and row['deployments']
            and all(d['desired']==d['running']==d['pending']==0 for d in row['deployments']),'Service/deployments not zero')
    require(not any(task['lastStatus']!='STOPPED'for task in row['tasks']),'RUNNING or desired STOPPED task still active')
    previous_ids=sorted(task['arn']for task in previous['tasks']if task['lastStatus']!='STOPPED')
    old=describe_tasks(previous_ids,previous['service'])
    require(all(task['lastStatus']=='STOPPED' and task['desiredStatus']=='STOPPED'for task in old),'Previous task not STOPPED')
    require(all(not targets for targets in row['targets'].values()),'Target group not drained')
    if previous['scaler']:
        expected={**previous['scaler'],'SuspendedState':FLAGS}
        require(row['scaler']==expected,'Scaler/min/max/role/flags drifted')
    else:require(row['scaler']is None,'New scaler appeared')
    return True


def deployment_pins(checkout,sha):
    checkout=Path(checkout).resolve()
    require(subprocess.check_output(['git','rev-parse','HEAD'],cwd=checkout,text=True).strip()==sha,'Deployment checkout SHA differs')
    require(not subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=checkout),'Deployment checkout must be clean')
    pins={path:hashlib.sha256((checkout/path).read_bytes()).hexdigest()for path in GUARD_PATHS}
    require(pins[GUARD_PATHS[0]]==EXPECTED_GUARD_SHA,'Reviewed final guard differs')
    require(pins['.github/workflows/deploy-aws.yml']==EXPECTED_WORKFLOW_SHA,'Reviewed rollout workflow differs')
    return pins


def validate_plan(plan,write=False):
    require(isinstance(plan,dict) and set(plan)=={'kind','schemaVersion','preparedAt','nonce','account','region','cluster',
        'consumers','affected','excluded','helperSha256','deploymentCheckout','deploymentSource','guardSha256','finalImage','snapshot','snapshotSha256'},'Unexpected fleet plan fields')
    require(type(plan['preparedAt'])is int and plan['preparedAt']>0 and isinstance(plan['snapshot'],dict),'Malformed plan time/snapshot')
    require(set(plan['snapshot'])=={'kind','capturedAt','operatorArn','services','definitions','schedules','clusterActiveTasks'}
            and plan['snapshot']['kind']=='fleet-snapshot-v1' and type(plan['snapshot']['capturedAt'])is int
            and 0<=plan['preparedAt']-plan['snapshot']['capturedAt']<=300,'Snapshot protocol/time differs')
    require(isinstance(plan['guardSha256'],dict) and set(plan['guardSha256'])==set(GUARD_PATHS)
        and all(isinstance(v,str) and re.fullmatch('[a-f0-9]{64}',v)for v in plan['guardSha256'].values()),'Guard pins malformed')
    require(plan.get('kind')=='fleet-quiescence-plan-v1' and plan.get('schemaVersion')==1,'Wrong fleet protocol')
    require(plan['account']==ACCOUNT and plan['region']==REGION and plan['cluster']==CLUSTER
            and plan['consumers']==CONSUMERS and plan['affected']==AFFECTED and plan['excluded']==EXCLUDED,'Fleet scope differs')
    require(isinstance(plan['nonce'],str) and isinstance(plan['deploymentSource'],str)
            and re.fullmatch('[a-f0-9]{32}',plan['nonce']) and re.fullmatch('[a-f0-9]{40}',plan['deploymentSource']), 'Plan pin malformed')
    require(hashlib.sha256((ROOT/SOURCE).read_bytes()).hexdigest()==plan['helperSha256'],'External helper changed')
    require(deployment_pins(plan['deploymentCheckout'],plan['deploymentSource'])==plan['guardSha256'],'Deployment guards changed')
    require(digest(plan['snapshot'])==plan['snapshotSha256'],'Snapshot changed')
    require(set(plan['snapshot']['services'])==set(SERVICES) and account()==plan['snapshot']['operatorArn'],'Snapshot/operator differs')
    require(re.fullmatch(r'237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com/oxy/oxy-api@sha256:[a-f0-9]{64}',plan['finalImage']), 'Final image not exact')
    if write:require(0<=time.time()-plan['preparedAt']<=1800,'Write plan expired')
    for name in AFFECTED:baseline_stable(plan['snapshot']['services'][name])


def validate_deploy_export(plan,deploy):
    # Import only the exact hash-bound pure guard; do not invoke its AWS CLI.
    module=(Path(plan['deploymentCheckout'])/GUARD_PATHS[0]).resolve().as_uri()
    script="import {validatePlan} from "+json.dumps(module)+";import {readFileSync} from 'node:fs';const p=JSON.parse(readFileSync(0,'utf8'));validatePlan(p,{region:p.region,cluster:p.cluster,service:p.service,container:p.container,sourceSha:p.sourceSha,image:p.finalImage});"
    result=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(deploy),text=True,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
    require(result.returncode==0,'Canonical deployment plan rejected; no export')


def api_deploy_plan(plan):
    snapshot=plan['snapshot'];row=snapshot['services'][API];td=snapshot['definitions'][row['definition']]
    container=[c for c in td['containers']if c['name']=='oxy-api'];require(len(container)==1,'API container ambiguous')
    require(container[0]['image']!=plan['finalImage'],'No final image change')
    return {'schemaVersion':1,'region':REGION,'cluster':CLUSTER,'service':API,'container':'oxy-api',
        'previousTaskDefinition':row['definition'],'previousImage':container[0]['image'],'previousShapeSha256':td['shapeSha256'],
        'finalImage':plan['finalImage'],'sourceSha':plan['deploymentSource'],'restoreCount':row['desired'],
        'previousTasks':sorted(t['arn']for t in row['tasks']if t['lastStatus']!='STOPPED'),
        'targetGroups':row['targetGroups'],'scaler':{'min':row['scaler']['MinCapacity'],'max':row['scaler']['MaxCapacity']}if row['scaler']else None}

WAITING = {'Service/deployments not zero','RUNNING or desired STOPPED task still active',
           'Previous task not STOPPED','Target group not drained'}


def fresh_before_writes(plan):
    now=capture();old=plan['snapshot']
    require(now['operatorArn']==old['operatorArn'] and now['schedules']==old['schedules'],'Operator/schedules drifted')
    require(now['definitions']==old['definitions'],'Task config drifted')
    for name in SERVICES:
        a,b=now['services'][name],old['services'][name]
        require(immutable_service(a)==immutable_service(b) and a['desired']==b['desired'] and a['scaler']==b['scaler'],'Fleet service/scaler drifted')
        require([t for t in a['tasks']if t['lastStatus']!='STOPPED']==[t for t in b['tasks']if t['lastStatus']!='STOPPED'],'Live task census drifted')
    return now


def write_once(directory,label,args,before,expected):
    require(not interrupted,'Interrupted before write')
    intent={'kind':'fleet-write-intent-v1','label':label,'recordedAt':int(time.time()),
            'before':before,'expected':expected,'awsArguments':args,'oneAttemptOnly':True}
    private_json(directory/(label+'-intent.json'),intent)
    try:
        aws(*args)
    except BaseException:
        private_json(directory/(label+'-ack-unknown.json'),{'acknowledgementUnknown':True,'noRetry':True,
            'requiresReadOnlyReconciliation':True,'intentCanonicalSha256':digest(intent)})
        raise RuntimeError('Write ACK unknown; no retry or advancement')
    private_json(directory/(label+'-ack.json'),{'acknowledged':True,'intentCanonicalSha256':digest(intent)})


def suspend_scaler(plan,name,directory):
    baseline=plan['snapshot']['services'][name]['scaler']
    current=scalers().get(name);require(current==baseline,'Scaler changed before suspension')
    if baseline is None:return
    desired={**baseline,'SuspendedState':FLAGS}
    if baseline.get('SuspendedState')!=FLAGS:
        args=['application-autoscaling','register-scalable-target','--service-namespace','ecs',
            '--resource-id',baseline['ResourceId'],'--scalable-dimension','ecs:service:DesiredCount',
            '--min-capacity',str(baseline['MinCapacity']),'--max-capacity',str(baseline['MaxCapacity']),
            '--role-arn',baseline['RoleARN'],'--suspended-state',json.dumps(FLAGS,separators=(',',':'))]
        write_once(directory,'suspend-'+name,args,baseline,desired)
    current=scalers().get(name);require(current==desired,'Scaler suspension readback differs')
    private_json(directory/('suspend-'+name+'-readback.json'),{'service':name,'scaler':current})


def count_zero(plan,name,directory):
    old=plan['snapshot']['services'][name];current=service_row(name)
    require(immutable_service(current)==immutable_service(old) and current['desired']==old['desired'],'Service changed before pause')
    expected={**old['scaler'],'SuspendedState':FLAGS}if old['scaler']else None
    require(current['scaler']==expected,'Scaler no longer suspended')
    require({t['arn']for t in current['tasks']if t['lastStatus']!='STOPPED'}==
            {t['arn']for t in old['tasks']if t['lastStatus']!='STOPPED'},'Task census changed before pause')
    write_once(directory,'pause-'+name,['ecs','update-service','--cluster',CLUSTER,'--service',name,'--desired-count','0'],
        {'definition':old['definition'],'desired':old['desired']},{'definition':old['definition'],'desired':0})
    current=service_row(name)
    require(immutable_service(current)==immutable_service(old) and current['desired']==0,'Count0 acknowledgement readback differs')
    private_json(directory/('pause-'+name+'-readback.json'),current)


def wait_quiesced(plan,names,directory):
    deadline=time.monotonic()+900;pending=list(names)
    while pending:
        for name in list(pending):
            current=service_row(name)
            try:assert_quiesced(current,plan['snapshot']['services'][name])
            except RuntimeError as error:
                if str(error)not in WAITING:raise
                continue
            private_json(directory/('stopped-'+name+'.json'),current);pending.remove(name)
        require(time.monotonic()<deadline,'Quiescence deadline exceeded; fleet remains paused')
        if pending:time.sleep(5)


def observe(plan):
    require(account()==plan['snapshot']['operatorArn'],'Operator differs')
    service_set()
    rows={name:service_row(name)for name in SERVICES}
    schedule=schedules();require(schedule==plan['snapshot']['schedules'],'Schedules changed during maintenance')
    active=cluster_active_tasks()
    require(all(t['group']in{'service:'+name for name in EXCLUDED}for t in active),'Affected/standalone active task remains')
    for name in AFFECTED:assert_quiesced(rows[name],plan['snapshot']['services'][name])
    for name in EXCLUDED:
        old=plan['snapshot']['services'][name];new=rows[name]
        require(immutable_service(new)==immutable_service(old) and new['desired']==old['desired'] and new['scaler']==old['scaler'],
            'Excluded service changed')
    return {'kind':'fleet-quiescence-readback-v1','capturedAt':int(time.time()),'services':rows,
            'clusterActiveTasks':active,'schedules':schedule,'all25Quiesced':True}


def execute_quiescence(plan,directory):
    validate_plan(plan,True);fresh_before_writes(plan)
    directory=outside(directory);directory.mkdir(parents=True,exist_ok=False);os.chmod(directory,0o700)
    private_json(directory/'plan.json',plan)
    completed=False;phase='suspend-scalers'
    try:
        for name in AFFECTED:suspend_scaler(plan,name,directory)
        phase='pause-consumers'
        for name in CONSUMERS:count_zero(plan,name,directory)
        wait_quiesced(plan,CONSUMERS,directory)
        phase='pause-api';count_zero(plan,API,directory);wait_quiesced(plan,[API],directory)
        phase='pause-worker';count_zero(plan,WORKER,directory);wait_quiesced(plan,[WORKER],directory)
        phase='final-readback';result=observe(plan);private_json(directory/'readback.json',result)
        deploy=api_deploy_plan(plan);validate_deploy_export(plan,deploy)
        private_json(directory/'quiesced-deploy-plan.json',deploy)
        private_json(directory/'receipt.json',{'kind':'fleet-quiescence-receipt-v1','planCanonicalSha256':digest(plan),
            'readbackCanonicalSha256':digest(result),'deployPlanCanonicalSha256':digest(deploy),
            'deployPlanFileSha256':hashlib.sha256((directory/'quiesced-deploy-plan.json').read_bytes()).hexdigest(),'all25Quiesced':True,
            'databaseMutation':False,'consumerRestore':False,'scalingRestore':False})
        completed=True
    finally:
        # Never restore counts/flags here. An unknown ACK needs observation and
        # deliberate reconciliation, not another mutation disguised as cleanup.
        private_json(directory/'completion.json',{'completed':completed,'lastPhase':phase,'operatorInterrupted':interrupted,
            'noAutomaticRetry':True,'noAutomaticRestore':True,'requiresReview':not completed})


def assert_hold_config(current,previous):
    require(current['targetGroups']==previous['targetGroups'] and
        current['serviceConfigExceptDeploymentSha256']==previous['serviceConfigExceptDeploymentSha256'], 'Hold configuration drifted')
    expected=copy.deepcopy(previous['deploymentConfiguration'])
    require(isinstance(expected,dict),'Baseline deployment configuration missing')
    circuit=expected.get('deploymentCircuitBreaker',{})
    require(isinstance(circuit,dict),'Baseline circuit breaker malformed')
    expected['deploymentCircuitBreaker']={**circuit,'enable':True,'rollback':False}
    expected.update({'minimumHealthyPercent':100,'maximumPercent':200})
    # The hash-pinned workflow fixes ROLLOUT_MAX_PERCENT=200. The canonical
    # script's minimum one-extra-task percentage is <=200 for counts >=1.
    require(current['deploymentConfiguration'] in (previous['deploymentConfiguration'],expected), 'Hold deployment configuration drifted')


def hold_api(plan,attempt,directory):
    validate_plan(plan)
    require(set(attempt)=={'newTaskDefinition','attemptedTasks'},'Unexpected hold attempt fields')
    arn=attempt['newTaskDefinition'];require(re.fullmatch(r'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:[1-9][0-9]*',arn) and arn!=plan['snapshot']['services'][API]['definition'],'Wrong final API TD')
    previous=plan['snapshot']['services'][API];deploy=api_deploy_plan(plan)
    raw=aws('ecs','describe-task-definition','--task-definition',arn)['taskDefinition']
    require(raw.get('taskDefinitionArn')==arn,'Final API TD readback differs')
    copy_td=copy.deepcopy(raw)
    containers=[c for c in copy_td['containerDefinitions']if c['name']=='oxy-api']
    require(len(containers)==1 and containers[0]['image']==plan['finalImage'],'Attempt image differs')
    containers[0]['image']=deploy['previousImage'];require(shape_hash(copy_td)==deploy['previousShapeSha256'],'Attempt changed API configuration')
    require(isinstance(attempt['attemptedTasks'],list) and len(attempt['attemptedTasks'])<=100
            and all(isinstance(t,str) and re.fullmatch(TASK_ARN,t)for t in attempt['attemptedTasks'])
            and len(set(attempt['attemptedTasks']))==len(attempt['attemptedTasks']),'Attempt task ids invalid')
    known=describe_tasks(attempt['attemptedTasks'],API)
    require(all(t['definition']in(arn,previous['definition'])for t in known),'Foreign attempted task TD')
    current=service_row(API)
    require(current['definition']in(arn,previous['definition']),'API hold target changed')
    assert_hold_config(current,previous)
    require(current['scaler']==({**previous['scaler'],'SuspendedState':FLAGS}if previous['scaler']else None),'Hold scaler not suspended')
    live=[t for t in current['tasks']if t['lastStatus']!='STOPPED']
    require(all(t['definition']in(arn,previous['definition'])for t in live),'Unknown API task definition')
    all_ids=sorted(set(attempt['attemptedTasks'])|{t['arn']for t in previous['tasks']if t['lastStatus']!='STOPPED'}|{t['arn']for t in live})
    directory=outside(directory);directory.mkdir(parents=True,exist_ok=False);os.chmod(directory,0o700)
    private_json(directory/'hold-intent.json',{'planCanonicalSha256':digest(plan),'attempt':attempt,'observedTaskIds':all_ids,
        'baselineDefinition':previous['definition'],'newDefinition':arn,'noRecoverySelected':True})
    complete=False
    try:
        if current['desired']!=0:
            write_once(directory,'hold-api',['ecs','update-service','--cluster',CLUSTER,'--service',API,'--desired-count','0'],
                {'definition':current['definition'],'desired':current['desired']},{'definition':current['definition'],'desired':0})
        deadline=time.monotonic()+900
        while True:
            current=service_row(API);require(current['definition']in(arn,previous['definition']),'API definition drifted during hold')
            additional=[t for t in current['tasks']if t['lastStatus']!='STOPPED' and t['arn']not in all_ids]
            if additional:
                require(all(t['definition']in(arn,previous['definition'])for t in additional),'Unrecognized hold task')
                private_json(directory/('hold-additional-'+str(len(all_ids))+'.json'),{'newObservedTasks':additional})
                all_ids=sorted(set(all_ids)|{t['arn']for t in additional})
            checked=describe_tasks(all_ids,API)
            zero=current['desired']==current['running']==current['pending']==0 and current['deployments'] and all(
                d['desired']==d['running']==d['pending']==0 for d in current['deployments'])
            stopped=all(t['lastStatus']=='STOPPED' and t['desiredStatus']=='STOPPED'for t in checked)
            if zero and stopped and not any(current['targets'].values()) and not any(t['lastStatus']!='STOPPED'for t in current['tasks']):break
            require(time.monotonic()<deadline,'API hold incomplete; no recovery admission');time.sleep(5)
        assert_hold_config(current,previous)
        require(current['scaler']==({**previous['scaler'],'SuspendedState':FLAGS}if previous['scaler']else None),'Hold suspension drifted')
        private_json(directory/'held-api.json',{'service':current,'taskReadbacks':checked,'allAttemptedTasksStopped':True,
            'baselineDefinition':previous['definition'],'newDefinition':arn,'recoveryLaunched':False})
        complete=True
    finally:
        private_json(directory/'completion.json',{'completed':complete,'noAutomaticRetry':True,'noAutomaticRestore':True,
            'apiHeldOnly':True,'otherServicesRequireIndependentQuiescence':True,'operatorInterrupted':interrupted})


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--plan',required=True);parser.add_argument('--execute',action='store_true');parser.add_argument('--observe',action='store_true')
    parser.add_argument('--hold-api',action='store_true');parser.add_argument('--attempt');parser.add_argument('--output')
    parser.add_argument('--deployment-checkout');parser.add_argument('--deployment-source');parser.add_argument('--final-image')
    args=parser.parse_args();outside(args.plan)
    require(sum(bool(flag)for flag in(args.execute,args.observe,args.hold_api))<=1,'Select one operation')
    if args.execute or args.observe or args.hold_api:
        require(args.output and not any((args.deployment_checkout,args.deployment_source,args.final_image)),'Operation uses exact existing plan/output')
        plan=json.loads(Path(args.plan).read_text());validate_plan(plan,args.execute)
        if args.execute:require(not args.attempt,'Unexpected attempt');execute_quiescence(plan,args.output)
        elif args.observe:
            require(not args.attempt,'Unexpected attempt');private_json(outside(args.output),observe(plan))
        else:require(args.attempt,'Hold needs exact attempted TD/tasks');hold_api(plan,json.loads(Path(args.attempt).read_text()),args.output)
        return
    require(args.deployment_checkout and args.deployment_source and args.final_image and not args.output and not args.attempt,'Capture needs final image/source/checkout')
    guard_pins=deployment_pins(args.deployment_checkout,args.deployment_source)
    snapshot=capture()
    for name in AFFECTED:baseline_stable(snapshot['services'][name])
    import secrets
    plan={'kind':'fleet-quiescence-plan-v1','schemaVersion':1,'preparedAt':int(time.time()),'nonce':secrets.token_hex(16),
        'account':ACCOUNT,'region':REGION,'cluster':CLUSTER,'consumers':CONSUMERS,'affected':AFFECTED,'excluded':EXCLUDED,
        'helperSha256':hashlib.sha256((ROOT/SOURCE).read_bytes()).hexdigest(),
        'deploymentCheckout':str(Path(args.deployment_checkout).resolve()),'deploymentSource':args.deployment_source,
        'guardSha256':guard_pins,'finalImage':args.final_image,'snapshot':snapshot,'snapshotSha256':digest(snapshot)}
    validate_plan(plan);deploy=api_deploy_plan(plan);validate_deploy_export(plan,deploy);private_json(args.plan,plan)
    print(json.dumps({'captured':True,'serviceCount':len(SERVICES),'affectedCount':len(AFFECTED),'planCanonicalSha256':digest(plan),'planFileSha256':hashlib.sha256(Path(args.plan).read_bytes()).hexdigest(),'executed':False}))


if __name__=='__main__':
    signal.signal(signal.SIGTERM,handle_signal);signal.signal(signal.SIGINT,handle_signal)
    try:main()
    except Exception:
        print('FLEET_OPERATION_FAILED_REVIEW_PRIVATE_INTENTS_NO_RETRY',file=sys.stderr);raise SystemExit(1)
