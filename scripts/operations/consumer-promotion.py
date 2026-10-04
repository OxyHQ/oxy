#!/usr/bin/env python3
"""Root-operated consumer promotion only. Default preparation performs reads.

Input evidence and image inspection are external, hash-bound and reviewed by
root. This helper never builds/pushes images, guesses migrations or restores an
old image. No live operation is part of its offline tests.
"""
import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fleet',ROOT/'scripts/operations/fleet-quiescence.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
SOURCE='scripts/operations/consumer-promotion.py'
ALLOWED={'alia','alia-integrations','mention','mention-mcp','mercaria','clarity-api','clarity-worker','allo',
 'noted','homiio','homiio-worker','website-api','peable','tnp-api','willo','goway','moovo','nilo','crowdsource','syra'}
TD_WRITABLE={'family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints',
 'requiresCompatibilities','cpu','memory','pidMode','ipcMode','proxyConfiguration','inferenceAccelerators','ephemeralStorage',
 'runtimePlatform','enableFaultInjection'}
TD_READONLY={'taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt'}
HEX=r'[a-f0-9]{64}'


def ref(path):
    p=f.outside(path);return {'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}


def read_ref(value):
    f.require(isinstance(value,dict) and set(value)=={'path','sha256'} and re.fullmatch(HEX,value['sha256']), 'Malformed evidence reference')
    p=f.outside(value['path']);raw=p.read_bytes();f.require(len(raw)<=8*1024*1024 and hashlib.sha256(raw).hexdigest()==value['sha256'],'Evidence bytes changed')
    return json.loads(raw)


def td_semantic(raw):
    f.require(isinstance(raw,dict) and set(raw)<=TD_WRITABLE|TD_READONLY,'Unreviewed task-definition fields')
    result={k:copy.deepcopy(v)for k,v in raw.items()if k in TD_WRITABLE}
    f.require(isinstance(result.get('containerDefinitions'),list) and result['containerDefinitions'],'Container definitions missing')
    names=[c['name']for c in result['containerDefinitions']];f.require(len(set(names))==len(names),'Duplicate container names')
    for container in result['containerDefinitions']:
        for key in ('environment','secrets'):
            if key not in container:continue
            entries=container[key];f.require(isinstance(entries,list) and len({e['name']for e in entries})==len(entries),'Duplicate environment/secret name')
            container[key]=sorted(entries,key=lambda e:e['name'])
    return result


def task_definition(arn):
    f.require(re.fullmatch(r'arn:aws:ecs:us-west-2:237343248947:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*',arn),'TD outside account/region')
    response=f.aws('ecs','describe-task-definition','--task-definition',arn,'--include','TAGS')
    td=response.get('taskDefinition');f.require(isinstance(td,dict) and td.get('taskDefinitionArn')==arn,'TD readback differs')
    tags=response.get('tags',[]);f.require(isinstance(tags,list) and len({t['key']for t in tags})==len(tags),'Tags missing/duplicate')
    # AWS-generated reserved tags are readonly metadata, not registration input.
    return td,sorted((t for t in tags if not t['key'].lower().startswith('aws:')),key=lambda t:t['key'])


def render(raw,tags,container,image):
    body=td_semantic(raw);chosen=[c for c in body['containerDefinitions']if c['name']==container]
    f.require(len(chosen)==1 and chosen[0]['image']!=image,'Selected container ambiguous or unchanged')
    chosen[0]['image']=image
    if tags:body['tags']=copy.deepcopy(tags)
    return body


def registered_matches(raw,tags,body):
    expected={k:v for k,v in body.items()if k!='tags'}
    f.require(td_semantic(raw)==expected and tags==body.get('tags',[]),'Registered TD changed configuration/tags')


def gh_json(path):
    result=subprocess.run(['gh','api',path],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=40)
    f.require(result.returncode==0 and len(result.stdout.encode())<=4*1024*1024,'Authenticated GitHub read failed')
    return json.loads(result.stdout)


def image_identity(config,recipe):
    receipt=read_ref(config['imageVerification'])
    fields={'kind','service','repository','sourceSha','sourceTreeSha','imageUri','manifestSha256','configSha256',
            'platform','dockerfileSha256','target','evidence'}
    f.require(set(receipt)==fields and receipt['kind']=='root-consumer-image-verification-v1','Wrong external image verification protocol')
    f.require(receipt['service']==config['service'] and receipt['repository']==recipe['repository']
        and receipt['dockerfileSha256']==recipe['dockerfileSha256'] and receipt['target']==recipe['target']
        and receipt['platform']=='linux/arm64','Image/recipe binding differs')
    f.require(re.fullmatch(r'[a-f0-9]{40}',receipt['sourceSha']) and re.fullmatch(r'[a-f0-9]{40}',receipt['sourceTreeSha'])
        and re.fullmatch(HEX,receipt['manifestSha256']) and re.fullmatch(HEX,receipt['configSha256']), 'Image identity malformed')
    expected='237343248947.dkr.ecr.us-west-2.amazonaws.com/'+recipe['ecrRepository']+'@sha256:'+receipt['manifestSha256']
    f.require(receipt['imageUri']==expected,'Image URI not bound to manifest')
    f.require(isinstance(receipt['evidence'],list) and 1<=len(receipt['evidence'])<=20,'External inspection/security records required')
    for evidence in receipt['evidence']:read_ref(evidence)
    commit=gh_json('repos/'+receipt['repository']+'/git/commits/'+receipt['sourceSha'])
    f.require(commit.get('sha')==receipt['sourceSha'] and commit.get('tree',{}).get('sha')==receipt['sourceTreeSha'],'GitHub source/tree differs')
    contents=gh_json('repos/'+receipt['repository']+'/contents/'+recipe['dockerfile']+'?ref='+receipt['sourceSha'])
    f.require(contents.get('type')=='file' and contents.get('encoding')=='base64','Dockerfile source unavailable')
    raw=base64.b64decode(contents['content'],validate=False)
    f.require(hashlib.sha256(raw).hexdigest()==recipe['dockerfileSha256'],'Dockerfile bytes differ')
    result=f.aws('ecr','batch-get-image','--repository-name',recipe['ecrRepository'],'--image-ids','imageDigest=sha256:'+receipt['manifestSha256'],
        '--accepted-media-types','application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json')
    f.require(not result.get('failures') and len(result.get('images',[]))==1,'ECR image readback absent/ambiguous')
    image=result['images'][0]
    f.require(image.get('imageId',{}).get('imageDigest')=='sha256:'+receipt['manifestSha256'],'ECR digest differs')
    manifest_bytes=image['imageManifest'].encode();manifest=json.loads(manifest_bytes)
    f.require(hashlib.sha256(manifest_bytes).hexdigest()==receipt['manifestSha256'] and manifest.get('schemaVersion')==2
        and manifest.get('config',{}).get('digest')=='sha256:'+receipt['configSha256'],'ECR manifest/config differs')
    return receipt


def recipe_for(lots,service):
    matches=[]
    for consumer in lots.get('consumers',[]):
        for recipe in consumer.get('imageRecipes',[]):
            if recipe.get('service')==service:matches.append({**recipe,'repository':consumer['repository']})
    f.require(service in ALLOWED and len(matches)==1,'Service not one of 20 affected image recipes')
    return matches[0]


def smoke_config(value):
    f.require(isinstance(value,dict) and set(value)=={'script','sha256','interpreter','arguments','timeoutSeconds'},'Smoke protocol differs')
    path=f.outside(value['script']);f.require(hashlib.sha256(path.read_bytes()).hexdigest()==value['sha256'],'Smoke script changed')
    f.require(value['interpreter'] in ('python3','node','bash') and isinstance(value['arguments'],list)
        and len(value['arguments'])<=30 and all(isinstance(a,str) and len(a)<=500 and '\n'not in a
            and not re.search(r'(?i)Bearer\s|sk_(?:test|live)_|^eyJ[A-Za-z0-9_-]+\.',a) for a in value['arguments'])
        and type(value['timeoutSeconds'])is int and 1<=value['timeoutSeconds']<=300,'Smoke command/bounds invalid')
    # Root reviews all arguments as public handles; bearer/secret belongs only in
    # the reviewed script's memory, never in this plan or subprocess arguments.
    return value


def migration_policy(value,identity,service):
    f.require(isinstance(value,dict) and set(value)=={'mode','verification'},'Explicit migration policy required')
    f.require(value['mode']in ('required','not-required','bootstrap-managed'),'Migration decision missing')
    f.require(value['mode']!='bootstrap-managed' or service in ('tnp-api','website-api'),'Bootstrap-managed service not reviewed')
    receipt=read_ref(value['verification'])
    f.require(set(receipt)=={'kind','service','sourceSha','imageUri','mode','evidence'} and
        receipt['kind']=='root-consumer-migration-verification-v1' and receipt['service']==service and receipt['mode']==value['mode']
        and receipt['sourceSha']==identity['sourceSha'] and receipt['imageUri']==identity['imageUri'],'Migration evidence binding differs')
    f.require(isinstance(receipt['evidence'],list) and 1<=len(receipt['evidence'])<=20,'Migration proof/reason required')
    for evidence in receipt['evidence']:read_ref(evidence)
    return receipt


def quiescence_inputs(config):
    fleet_plan=read_ref(config['fleetPlan']);f.validate_plan(fleet_plan)
    receipt=read_ref(config['quiescenceReceipt']);readback=read_ref(config['quiescenceReadback'])
    f.require(receipt.get('kind')=='fleet-quiescence-receipt-v1' and receipt.get('all25Quiesced')is True
        and receipt.get('planCanonicalSha256')==f.digest(fleet_plan)
        and receipt.get('readbackCanonicalSha256')==f.digest(readback),'Quiescence receipt binding differs')
    f.require(readback.get('kind')=='fleet-quiescence-readback-v1' and readback.get('all25Quiesced')is True,'Wrong quiescence readback')
    old=fleet_plan['snapshot']['services'][config['service']];stopped=readback['services'][config['service']]
    f.require(f.immutable_service(old)==f.immutable_service(stopped) and stopped['desired']==stopped['running']==stopped['pending']==0
        and all(t['lastStatus']=='STOPPED' for t in stopped['tasks']),'Prior quiescence is not confirmed')
    return old


def assert_zero(current,old):
    # The completed root receipt already proved original task IDs stopped. An
    # ECS task ARN cannot restart; tombstoned historical tasks are not queried
    # again here. Fresh both-census tasks still all require actual STOPPED.
    f.assert_quiesced(current,{**old,'tasks':[]})


def expected_config(old):
    value=copy.deepcopy(old['deploymentConfiguration'])
    f.require(isinstance(value,dict) and isinstance(value.get('deploymentCircuitBreaker',{}),dict),'Deployment configuration malformed')
    value['deploymentCircuitBreaker']={**value.get('deploymentCircuitBreaker',{}),'enable':True,'rollback':False}
    return value


def prepare(config):
    fields={'service','lots','fleetPlan','quiescenceReceipt','quiescenceReadback','imageVerification','container','migration','smoke'}
    f.require(isinstance(config,dict) and set(config)==fields and config['service']in ALLOWED,'Wrong promotion configuration')
    f.require(isinstance(config['container'],str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}',config['container']),'Selected container must be explicit')
    lots=read_ref(config['lots']);recipe=recipe_for(lots,config['service']);identity=image_identity(config,recipe)
    smoke_config(config['smoke']);migration_policy(config['migration'],identity,config['service'])
    old=quiescence_inputs(config);current=f.service_row(config['service']);assert_zero(current,old)
    raw,tags=task_definition(old['definition']);body=render(raw,tags,config['container'],identity['imageUri'])
    fleet_plan=read_ref(config['fleetPlan']);baseline_td=fleet_plan['snapshot']['definitions'][old['definition']]
    f.require(f.shape_hash(raw)==baseline_td['shapeSha256'],'Baseline TD shape changed')
    return {'kind':'consumer-promotion-plan-v1','schemaVersion':1,'preparedAt':int(time.time()),
        'operatorArn':f.account(),'config':config,'recipe':recipe,'baseline':old,'identity':identity,
        'registrationCanonicalSha256':f.digest(body),'tagsSha256':f.digest(tags),
        'helperSha256':hashlib.sha256((ROOT/SOURCE).read_bytes()).hexdigest(),
        'fleetHelperSha256':hashlib.sha256((ROOT/f.SOURCE).read_bytes()).hexdigest()}


def validate(plan,write=False,image_reads=True):
    f.require(isinstance(plan,dict) and set(plan)=={'kind','schemaVersion','preparedAt','operatorArn','config','recipe','baseline','identity',
        'registrationCanonicalSha256','tagsSha256','helperSha256','fleetHelperSha256'},'Unexpected promotion plan fields')
    f.require(plan['kind']=='consumer-promotion-plan-v1' and plan['schemaVersion']==1 and type(plan['preparedAt'])is int,'Wrong promotion protocol')
    f.require(f.account()==plan['operatorArn'],'Operator differs')
    for field,path in [('helperSha256',SOURCE),('fleetHelperSha256',f.SOURCE)]:
        f.require(hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==plan[field],'Operational helper changed')
    if write:f.require(0<=time.time()-plan['preparedAt']<=1800,'Promotion plan expired')
    config=plan['config']
    f.require(set(config)=={'service','lots','fleetPlan','quiescenceReceipt','quiescenceReadback','imageVerification','container','migration','smoke'}
        and config['service']in ALLOWED,'Promotion configuration changed')
    recipe=recipe_for(read_ref(config['lots']),config['service'])
    f.require(recipe==plan['recipe'] and (image_identity(config,recipe)if image_reads else read_ref(config['imageVerification']))==plan['identity'],'Image/source recipe changed')
    f.require(quiescence_inputs(config)==plan['baseline'],'Quiescence inputs changed')
    smoke_config(config['smoke']);migration_policy(config['migration'],plan['identity'],config['service'])


def aws_register(body):
    # AWS CLI 2.36 rejects this /dev/stdin transport during local JSON parsing. Keep
    # exact JSON in a private RAM-backed file; no TD values enter argv/logs.
    with tempfile.TemporaryDirectory(prefix='oxy-consumer-registration-',dir='/dev/shm') as temporary:
        request=Path(temporary)/'request.json'
        fd=os.open(request,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as output:
            json.dump(body,output);output.flush();os.fsync(output.fileno())
        child=subprocess.Popen(['aws','ecs','register-task-definition','--cli-input-json','file://'+str(request),
            '--region',f.REGION,'--output','json','--no-cli-pager'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            text=True,start_new_session=True)
        try:
            stdout,_=child.communicate(timeout=40)
            f.require(child.returncode==0 and len(stdout.encode())<=8*1024*1024,'TD registration failed; raw error withheld')
            return json.loads(stdout)
        except BaseException:
            if child.poll()is None:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
            raise


def register(plan,directory):
    raw,tags=task_definition(plan['baseline']['definition']);body=render(raw,tags,plan['config']['container'],plan['identity']['imageUri'])
    f.require(f.digest(body)==plan['registrationCanonicalSha256'] and f.digest(tags)==plan['tagsSha256'],'Registration input drifted')
    f.require(not f.interrupted,'Interrupted before registration')
    f.private_json(directory/'register-intent.json',{'requestCanonicalSha256':f.digest(body),'family':body['family'],
        'selectedContainer':plan['config']['container'],'imageUri':plan['identity']['imageUri'],'oneAttemptOnly':True})
    try:response=aws_register(body)
    except BaseException:
        f.private_json(directory/'register-ack-unknown.json',{'acknowledgementUnknown':True,'noRetry':True,'requiresReadOnlyReconciliation':True})
        raise RuntimeError('Registration ACK unknown; no retry')
    arn=response.get('taskDefinition',{}).get('taskDefinitionArn')
    f.require(isinstance(arn,str) and arn!=plan['baseline']['definition'] and
        re.fullmatch(r'arn:aws:ecs:us-west-2:237343248947:task-definition/'+re.escape(body['family'])+r':[1-9][0-9]*',arn), 'New TD acknowledgement missing or wrong family')
    f.private_json(directory/'register-ack.json',{'taskDefinition':arn,'requiresIndependentReadback':True})
    new,tags=task_definition(arn);registered_matches(new,tags,body)
    f.private_json(directory/'registered.json',{'taskDefinition':arn,'semanticSha256':f.digest(td_semantic(new)),
        'tagsSha256':f.digest(tags),'registrationCanonicalSha256':f.digest(body),'planCanonicalSha256':f.digest(plan)})
    return arn


def assert_service_config(row,plan,new_arn):
    old=plan['baseline']
    f.require(row['definition']==new_arn and row['targetGroups']==old['targetGroups']
        and row['serviceConfigExceptDeploymentSha256']==old['serviceConfigExceptDeploymentSha256']
        and row['deploymentConfiguration']==expected_config(old),'Promoted service configuration drifted')
    expected={**old['scaler'],'SuspendedState':f.FLAGS}if old['scaler']else None
    f.require(row['scaler']==expected,'Promotion scaler changed')


def remember_tasks(row,plan,new_arn,directory,remembered):
    for task in row['tasks']:
        f.require(task['definition']in (plan['baseline']['definition'],new_arn) or task['lastStatus']=='STOPPED','Unexpected live consumer TD')
        if task['definition']not in (plan['baseline']['definition'],new_arn):continue
        if task['arn']not in remembered:
            f.private_json(directory/('task-'+task['arn'].rsplit('/',1)[1]+'.json'),task);remembered.add(task['arn'])
        if task['lastStatus']==task['desiredStatus']=='STOPPED':
            key=task['arn'].rsplit('/',1)[1];record=directory/('task-stopped-'+key+'.json')
            if not record.exists():
                f.private_json(record,{'planCanonicalSha256':f.digest(plan),'service':row['service'],'task':task})
                f.private_json(directory/('task-stopped-ref-'+key+'.json'),ref(record))


def checked_attempts(plan,arn,directory,remembered,current):
    f.require(len(remembered)<=4000 and all(isinstance(value,str) and re.fullmatch(f.TASK_ARN,value)for value in remembered),'Attempted task IDs outside bound/cluster')
    rows={t['arn']:t for t in current['tasks']};absent=sorted(remembered-set(rows))
    for index in range(0,len(absent),100):
        batch=absent[index:index+100];response=f.aws('ecs','describe-tasks','--cluster',f.CLUSTER,'--tasks',*batch)
        values=response.get('tasks',[]);failures=response.get('failures',[])
        f.require(isinstance(values,list) and isinstance(failures,list),'Attempted task read incomplete')
        actual=[t.get('taskArn')for t in values];missing=[t.get('arn')for t in failures]
        f.require(len(set(actual+missing))==len(batch) and set(actual+missing)==set(batch),'Attempted task census differs')
        for value in values:
            f.require(value.get('group')=='service:'+plan['config']['service'] and value.get('taskDefinitionArn')in (plan['baseline']['definition'],arn),'Attempted task identity differs')
            rows[value['taskArn']]={'arn':value['taskArn'],'group':value['group'],'definition':value['taskDefinitionArn'],
                'lastStatus':value['lastStatus'],'desiredStatus':value['desiredStatus'],'containers':[]}
        for failure in failures:
            f.require(set(failure)<= {'arn','reason','detail'} and failure.get('reason')=='MISSING','Attempted task read failed; no tombstone permission')
            # Exact plan remains unmodified; proof checks the two allowed TDs.
            key=failure['arn'].rsplit('/',1)[1];reference=directory/('task-stopped-ref-'+key+'.json')
            f.require(reference.is_file(),'Missing task lacks prior durable STOPPED proof')
            binding=json.loads(reference.read_text())
            f.require(binding.get('path')==str((directory/('task-stopped-'+key+'.json')).resolve()),'Stopped proof path differs')
            record=read_ref(binding);task=record.get('task',{})
            f.require(record.get('planCanonicalSha256')==f.digest(plan) and record.get('service')==plan['config']['service']
                and task.get('arn')==failure['arn'] and task.get('group')=='service:'+plan['config']['service']
                and task.get('definition')in (plan['baseline']['definition'],arn)
                and task.get('lastStatus')==task.get('desiredStatus')=='STOPPED','Stopped proof identity/state differs')
            rows[failure['arn']]=task
    return [rows[key]for key in sorted(remembered)]


def zero_retired(plan,arn,directory,remembered,deployment_id=None):
    deadline=time.monotonic()+900
    while True:
        row=f.service_row(plan['config']['service']);assert_service_config(row,plan,arn);remember_tasks(row,plan,arn,directory,remembered)
        f.require(row['desired']==0,'Zero-stage admission changed')
        f.require(row['deployments'] and all(d['definition']in (plan['baseline']['definition'],arn) and d['rolloutState']!='FAILED'for d in row['deployments']),'Zero-stage foreign/failed deployment')
        checked=checked_attempts(plan,arn,directory,remembered,row)
        ready=len(row['deployments'])==1 and row['deployments'][0]['definition']==arn and row['deployments'][0]['status']=='PRIMARY' and row['deployments'][0]['rolloutState']=='COMPLETED'
        if ready:
            dep=row['deployments'][0];f.require(isinstance(dep.get('id'),str) and dep['id'],'Final deployment ID missing')
            if deployment_id is not None:f.require(dep['id']==deployment_id,'Final deployment changed before restore')
            ready=row['running']==row['pending']==0 and dep['desired']==dep['running']==dep['pending']==0 and not any(row['targets'].values())
            ready=ready and all(t['lastStatus']==t['desiredStatus']=='STOPPED'for t in checked) and all(t['lastStatus']==t['desiredStatus']=='STOPPED'for t in row['tasks'])
        if ready:
            f.private_json(directory/('retired-'+str(time.monotonic_ns())+'.json'),{'planCanonicalSha256':f.digest(plan),'service':row,'allAttemptedTasks':checked,'deploymentId':dep['id'],'allStopped':True})
            return dep['id']
        f.require(time.monotonic()<deadline,'Zero-stage retirement incomplete; no admission');time.sleep(5)


def monitor(plan,arn,directory,remembered,deployment_id=None):
    deadline=time.monotonic()+900;service=plan['config']['service'];count=plan['baseline']['desired']
    while True:
        row=f.service_row(service);assert_service_config(row,plan,arn);remember_tasks(row,plan,arn,directory,remembered)
        primary=row['deployments']
        f.require(len(primary)==1 and primary[0]['status']=='PRIMARY' and primary[0]['definition']==arn and primary[0]['rolloutState']!='FAILED','Consumer sole final deployment changed/failed')
        if deployment_id is not None:f.require(primary[0].get('id')==deployment_id,'Consumer deployment ID changed')
        f.require(row['desired']==count,'Captured restore count changed')
        f.require(all(t['definition']==arn or t['lastStatus']==t['desiredStatus']=='STOPPED'for t in row['tasks']),'Retired consumer task alive after restore')
        checked=checked_attempts(plan,arn,directory,remembered,row)
        f.require(all(t['definition']==arn or t['lastStatus']==t['desiredStatus']=='STOPPED'for t in checked),'Retired attempted task alive after restore')
        f.require(all(t['lastStatus']=='STOPPED' or t['arn']in {v['arn']for v in row['tasks']}for t in checked),'Attempted live task omitted from fresh census')
        if row['running']==count and row['pending']==0 and primary[0]['rolloutState']=='COMPLETED':
            active=[t for t in row['tasks']if t['lastStatus']!='STOPPED']
            f.require(len(active)==count and all(t['definition']==arn and t['lastStatus']==t['desiredStatus']=='RUNNING' for t in active),'Rollout task census incomplete')
            for task in active:
                containers=[c for c in task['containers']if c['name']==plan['config']['container']]
                f.require(len(containers)==1 and containers[0]['digest']=='sha256:'+plan['identity']['manifestSha256'],'Running image digest differs')
            for targets in row['targets'].values():
                f.require(len(targets)==count and all(t.get('TargetHealth',{}).get('State')=='healthy'for t in targets),'Target smoke prerequisite unhealthy')
            return row
        f.require(time.monotonic()<deadline,'Consumer rollout timeout');time.sleep(5)


def run_smoke(plan,directory):
    value=smoke_config(plan['config']['smoke']);args=[value['interpreter']]
    if value['interpreter']=='python3':args+=['-B']
    args+=[value['script'],*value['arguments']]
    f.private_json(directory/'smoke-intent.json',{'scriptSha256':value['sha256'],'oneAttemptOnly':True})
    env={k:os.environ[k]for k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')if k in os.environ}
    child=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env,start_new_session=True)
    try:output,_=child.communicate(timeout=value['timeoutSeconds'])
    except BaseException:
        if child.poll()is None:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
        raise
    f.require(len(output)<=2*1024*1024,'Smoke output exceeded bound')
    f.private_json(directory/'smoke-result.json',{'exitCode':child.returncode,'outputSha256':hashlib.sha256(output).hexdigest(),
        'outputBytes':len(output),'rawOutputWithheld':True,'scriptSha256':value['sha256']})
    f.require(child.returncode==0,'Required consumer smoke failed')


def assert_hold_service_config(row,plan,arn):
    old=plan['baseline']
    f.require(row['definition']in (old['definition'],arn) and row['targetGroups']==old['targetGroups']
        and row['serviceConfigExceptDeploymentSha256']==old['serviceConfigExceptDeploymentSha256']
        and row['deploymentConfiguration']in (old['deploymentConfiguration'],expected_config(old)), 'Hold consumer configuration drifted')
    f.require(row['scaler']==({**old['scaler'],'SuspendedState':f.FLAGS}if old['scaler']else None), 'Hold scaler changed')


def hold_failed(plan,arn,directory,remembered):
    # Recovery itself remains blocked after unknown ACK. Attempt a bounded stop
    # only after exact current TD/config/role checks; never substitute old TD.
    row=f.service_row(plan['config']['service']);assert_hold_service_config(row,plan,arn);remember_tasks(row,plan,arn,directory,remembered)
    f.private_json(directory/'hold-intent.json',{'taskDefinition':arn,'rememberedTasks':sorted(remembered),'noOldImageRollback':True})
    if row['desired']!=0:
        f.write_once(directory,'hold-count0',['ecs','update-service','--cluster',f.CLUSTER,'--service',row['service'],'--desired-count','0'],
            {'definition':arn,'desired':row['desired']},{'definition':arn,'desired':0})
    deadline=time.monotonic()+900
    while True:
        row=f.service_row(plan['config']['service']);assert_hold_service_config(row,plan,arn);remember_tasks(row,plan,arn,directory,remembered)
        checked=checked_attempts(plan,arn,directory,remembered,row)
        if row['desired']==row['running']==row['pending']==0 and row['deployments'] and all(
            d['desired']==d['running']==d['pending']==0 for d in row['deployments']) and not any(row['targets'].values()) and all(
            t['lastStatus']=='STOPPED' and t['desiredStatus']=='STOPPED'for t in checked) and all(t['lastStatus']=='STOPPED'for t in row['tasks']):
            f.private_json(directory/'held.json',{'taskReadbacks':checked,'service':row,'heldCount0':True,'scalerRestored':False});return
        f.require(time.monotonic()<deadline,'Hold incomplete; no recovery admission');time.sleep(5)


def promote(plan,directory):
    validate(plan,True);old=plan['baseline'];assert_zero(f.service_row(plan['config']['service']),old)
    directory=f.outside(directory);directory.mkdir(parents=True,exist_ok=False);os.chmod(directory,0o700);f.private_json(directory/'plan.json',plan)
    arn=None;remembered=set();success=False;updated=False;failure=None
    try:
        arn=register(plan,directory)
        # Recheck every prerequisite after registration and immediately before
        # enabling any business tasks. Registration itself never starts them.
        validate(plan,True);assert_zero(f.service_row(plan['config']['service']),old)
        args=['ecs','update-service','--cluster',f.CLUSTER,'--service',old['service'],'--task-definition',arn,
              '--desired-count','0','--deployment-configuration',json.dumps(expected_config(old),separators=(',',':'))]
        f.write_once(directory,'install-zero',args,{'definition':old['definition'],'desired':0},{'definition':arn,'desired':0})
        updated=True
        deployment_id=zero_retired(plan,arn,directory,remembered)
        validate(plan,True)
        zero_retired(plan,arn,directory,remembered,deployment_id)
        # ECS can start the old active deployment when new TD and positive
        # count are combined. The old deployment must retire at zero first.
        args=['ecs','update-service','--cluster',f.CLUSTER,'--service',old['service'],'--desired-count',str(old['desired'])]
        f.write_once(directory,'promote',args,{'definition':arn,'desired':0},{'definition':arn,'desired':old['desired']})
        monitor(plan,arn,directory,remembered,deployment_id);run_smoke(plan,directory)
        row=monitor(plan,arn,directory,remembered,deployment_id)
        f.private_json(directory/'promoted.json',{'kind':'consumer-promotion-receipt-v1','planCanonicalSha256':f.digest(plan),
            'newTaskDefinition':arn,'service':row,'smokeResult':ref(directory/'smoke-result.json'),
            'allAttemptedTasks':sorted(remembered),'ownSmokePassed':True,'scalerRestored':False})
        success=True
    except BaseException as error:
        failure=type(error).__name__
        # An ACK ambiguity is not permission to issue another mutation. Root
        # first reconciles the exact durable intent, then performs a fresh hold.
        if arn and updated and not f.interrupted and not any(directory.glob('*ack-unknown.json')):
            try:hold_failed(plan,arn,directory,remembered)
            except BaseException:f.private_json(directory/'hold-not-confirmed.json',{'requiresReview':True,'noOldImageRollback':True})
        raise
    finally:
        f.private_json(directory/'completion.json',{'completed':success,'failureType':failure,'taskDefinition':arn,
            'noAutomaticRetry':True,'noOldImageRollback':True,'scalerRestored':False,'requiresReview':not success,
            'registrationMayExist':(directory/'register-intent.json').exists(),
            'registrationReadbackConfirmed':(directory/'registered.json').exists(),
            'updateAcknowledgementUnknown':any(directory.glob('*ack-unknown.json'))})


def hold_reviewed(plan,registered,directory):
    # After root reconciles an ambiguous update ACK, a separate explicit hold
    # may stop the exact baseline/new revision. Fresh GH/ECR is not needed to
    # stop a verified service; local hash-bound image/source evidence stays fixed.
    validate(plan,image_reads=False);record=read_ref(registered)
    f.require(set(record)=={'taskDefinition','semanticSha256','tagsSha256','registrationCanonicalSha256','planCanonicalSha256'}
        and record['planCanonicalSha256']==f.digest(plan) and record['registrationCanonicalSha256']==plan['registrationCanonicalSha256'], 'Registered hold receipt differs')
    old,tags=task_definition(plan['baseline']['definition'])
    body=render(old,tags,plan['config']['container'],plan['identity']['imageUri'])
    f.require(f.digest(body)==plan['registrationCanonicalSha256'],'Hold baseline TD drifted')
    arn=record['taskDefinition'];new,new_tags=task_definition(arn);registered_matches(new,new_tags,body)
    f.require(f.digest(td_semantic(new))==record['semanticSha256'] and f.digest(new_tags)==record['tagsSha256'],'Hold registered readback differs')
    directory=f.outside(directory);directory.mkdir(parents=True,exist_ok=False);os.chmod(directory,0o700)
    complete=False
    try:hold_failed(plan,arn,directory,set());complete=True
    finally:f.private_json(directory/'completion.json',{'held':complete,'noOldImageRollback':True,'scalerRestored':False,'requiresReview':not complete})


def restore_scaler(plan,promotion,directory):
    validate(plan);receipt=read_ref(promotion)
    f.require(set(receipt)=={'kind','planCanonicalSha256','newTaskDefinition','service','smokeResult','allAttemptedTasks','ownSmokePassed','scalerRestored'}
        and receipt['kind']=='consumer-promotion-receipt-v1' and receipt['planCanonicalSha256']==f.digest(plan)
        and receipt['ownSmokePassed']is True and receipt['scalerRestored']is False,'Wrong own promotion receipt')
    smoke=read_ref(receipt['smokeResult']);f.require(smoke['exitCode']==0 and smoke['scriptSha256']==plan['config']['smoke']['sha256'],'Own smoke not confirmed')
    arn=receipt['newTaskDefinition'];current=f.service_row(plan['config']['service']);assert_service_config(current,plan,arn)
    f.require(current['desired']==current['running']==plan['baseline']['desired'] and current['pending']==0
        and len(current['deployments'])==1 and current['deployments'][0]['rolloutState']=='COMPLETED','Service not stable before scaler restore')
    directory=f.outside(directory);directory.mkdir(parents=True,exist_ok=False);os.chmod(directory,0o700)
    f.require(current['deployments'][0].get('id')==receipt['service']['deployments'][0].get('id'),'Own promoted deployment changed before scaler restore')
    monitor(plan,arn,directory,set(),receipt['service']['deployments'][0]['id'])
    old=plan['baseline']['scaler']
    if old:
        f.write_once(directory,'restore-scaler',['application-autoscaling','register-scalable-target','--service-namespace','ecs',
            '--resource-id',old['ResourceId'],'--scalable-dimension','ecs:service:DesiredCount','--min-capacity',str(old['MinCapacity']),
            '--max-capacity',str(old['MaxCapacity']),'--role-arn',old['RoleARN'],'--suspended-state',json.dumps(old['SuspendedState'],separators=(',',':'))],current['scaler'],old)
        f.require(f.scalers().get(plan['config']['service'])==old,'Scaler restore readback differs')
    f.private_json(directory/'restored.json',{'service':plan['config']['service'],'originalScalerRestored':True,'promotionReceipt':promotion})


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config');parser.add_argument('--plan',required=True);parser.add_argument('--output');parser.add_argument('--plan-file-sha256')
    parser.add_argument('--promote',action='store_true');parser.add_argument('--restore-scalers',action='store_true');parser.add_argument('--promotion-receipt')
    parser.add_argument('--hold',action='store_true');parser.add_argument('--registered-receipt')
    args=parser.parse_args();f.outside(args.plan)
    f.require(sum(bool(v)for v in (args.promote,args.restore_scalers,args.hold))<=1,'Choose one operation')
    if args.promote or args.restore_scalers or args.hold:
        f.require(args.output and not args.config,'Operation uses existing reviewed plan')
        raw=Path(args.plan).read_bytes()
        f.require(args.plan_file_sha256 and re.fullmatch(HEX,args.plan_file_sha256)
            and len(raw)<=8*1024*1024 and hashlib.sha256(raw).hexdigest()==args.plan_file_sha256,'Reviewed plan byte hash missing or different')
        plan=json.loads(raw)
        if args.promote:
            f.require(not args.promotion_receipt and not args.registered_receipt,'Unexpected receipt');promote(plan,args.output)
        elif args.hold:
            f.require(args.registered_receipt and not args.promotion_receipt,'Hold requires reviewed registered receipt');hold_reviewed(plan,ref(args.registered_receipt),args.output)
        else:
            f.require(args.promotion_receipt and not args.registered_receipt,'Own smoke receipt required');restore_scaler(plan,ref(args.promotion_receipt),args.output)
    else:
        f.require(args.config and not args.output and not args.promotion_receipt and not args.registered_receipt and not args.plan_file_sha256,'Default readonly preparation needs exact configuration')
        result=prepare(json.loads(Path(args.config).read_text()));f.private_json(args.plan,result)
        print(json.dumps({'prepared':True,'service':result['config']['service'],'planFileSha256':hashlib.sha256(Path(args.plan).read_bytes()).hexdigest(),'executed':False}))


if __name__=='__main__':
    signal.signal(signal.SIGTERM,f.handle_signal);signal.signal(signal.SIGINT,f.handle_signal)
    try:main()
    except Exception:print('CONSUMER_OPERATION_FAILED_REVIEW_PRIVATE_INTENTS_NO_RETRY',file=sys.stderr);raise SystemExit(1)
