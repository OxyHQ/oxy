#!/usr/bin/env python3
"""Offline AWS protocol fixtures. No AWS dispatch, database, Docker or credentials."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]/'fleet-quiescence.py'
spec=importlib.util.spec_from_file_location('fleet',SOURCE)
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
FINAL_GUARD='8c8163755abddd1046ebea65b290634676759112'
TASK='arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/'
TD='arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:692'
NEW=TD.rsplit(':',1)[0]+':999'
IMAGE='237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:'
TG='arn:aws:elasticloadbalancing:us-west-2:237343248947:targetgroup/oxy-oxy-api/ee38332c8f767d58'
ACTOR='arn:aws:iam::237343248947:user/offline-fixture'


def task(index=1,status='RUNNING',desired='RUNNING',definition=TD,service=f.API):
    return {'arn':TASK+f'{index:032x}','group':'service:'+service,'definition':definition,
            'lastStatus':status,'desiredStatus':desired,
            'containers':[{'name':'oxy-api','image':IMAGE+'a'*64,'digest':'sha256:'+'a'*64,'status':status}]}


def scaler(name=f.API):
    return {'ResourceId':'service/oxy-cluster/'+name,'ServiceNamespace':'ecs',
            'ScalableDimension':'ecs:service:DesiredCount','MinCapacity':2,'MaxCapacity':6,
            'RoleARN':'arn:aws:iam::237343248947:role/fixture-scaling',
            'SuspendedState':{k:False for k in f.FLAGS}}


def row(name=f.API):
    return {'service':name,'definition':TD,'desired':2,'running':2,'pending':0,
            'serviceConfigSha256':'b'*64,'serviceConfigExceptDeploymentSha256':'f'*64,
            'deploymentConfiguration':{'deploymentCircuitBreaker':{'enable':True,'rollback':True,'resetOnHealthyTask':True,
                'thresholdConfiguration':{'type':'BOUNDED_PERCENT','value':50}},'minimumHealthyPercent':100,'maximumPercent':200,
                'strategy':'ROLLING','bakeTimeInMinutes':0},'targetGroups':[TG],'targets':{TG:[]},
            'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED','desired':2,'running':2,'pending':0}],
            'scaler':scaler(name),'tasks':[task(service=name)]}


def zero(old):
    new=copy.deepcopy(old)
    for key in ('desired','running','pending'):new[key]=0
    for key in ('desired','running','pending'):new['deployments'][0][key]=0
    new['scaler']={**old['scaler'],'SuspendedState':f.FLAGS}if old['scaler']else None
    new['tasks']=[{**t,'lastStatus':'STOPPED','desiredStatus':'STOPPED'}for t in old['tasks']]
    return new


def plan():
    snapshot={'kind':'fleet-snapshot-v1','capturedAt':int(time.time()),'operatorArn':ACTOR,
        'services':{name:row(name)for name in f.SERVICES},'definitions':{TD:{'containers':[{'name':'oxy-api','image':IMAGE+'a'*64}],
        'shapeSha256':'c'*64}},'schedules':{'scaling':[],'scheduler':[],'events':[]},'clusterActiveTasks':[]}
    return {'kind':'fleet-quiescence-plan-v1','schemaVersion':1,'preparedAt':int(time.time()),'nonce':'d'*32,
        'account':f.ACCOUNT,'region':f.REGION,'cluster':f.CLUSTER,'consumers':f.CONSUMERS,'affected':f.AFFECTED,'excluded':f.EXCLUDED,
        'helperSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'deploymentCheckout':'/offline/clean',
        'deploymentSource':FINAL_GUARD,'guardSha256':{p:f.EXPECTED_GUARD_SHA for p in f.GUARD_PATHS},
        'finalImage':IMAGE+'e'*64,'snapshot':snapshot,'snapshotSha256':f.digest(snapshot)}


class FleetTests(unittest.TestCase):
    def tearDown(self):f.interrupted=False

    def test_both_desired_censuses_paginated_and_stoppping_retained(self):
        calls=[]
        def aws(*args):
            calls.append(args)
            if args[1]=='list-tasks':
                desired=args[args.index('--desired-status')+1]
                if desired=='RUNNING':return {'taskArns':[TASK+'1'*32],'nextToken':'page2'}if '--next-token'not in args else {'taskArns':[]}
                return {'taskArns':[TASK+'2'*32]}
            return {'failures':[],'tasks':[{'taskArn':arn,'group':'service:oxy-api','taskDefinitionArn':TD,
                'lastStatus':'STOPPING'if arn==TASK+'2'*32 else 'RUNNING','desiredStatus':'STOPPED'if arn==TASK+'2'*32 else 'RUNNING',
                'containers':[]}for arn in args[args.index('--tasks')+1:]]}
        with patch.object(f,'aws',side_effect=aws):found=f.tasks_for(f.API)
        self.assertEqual(len(found),2);self.assertEqual(found[1]['lastStatus'],'STOPPING')
        self.assertEqual([c[c.index('--desired-status')+1]for c in calls if c[1]=='list-tasks'],['RUNNING','RUNNING','STOPPED'])

    def test_missing_task_readback_is_not_absence(self):
        with patch.object(f,'aws',return_value={'tasks':[],'failures':[]}):
            with self.assertRaisesRegex(RuntimeError,'readback'):f.describe_tasks([TASK+'1'*32],f.API)

    def test_task_namespace_and_duplicates_rejected_before_aws(self):
        with patch.object(f,'aws')as aws:
            for ids in ([TASK+'1'*32]*2,['arn:aws:ecs:eu-west-1:237343248947:task/x/'+'1'*32]):
                with self.assertRaises(RuntimeError):f.describe_tasks(ids)
            aws.assert_not_called()

    def test_zero_counts_do_not_hide_old_stopping_desired_stopped(self):
        old=row();new=zero(old)
        with patch.object(f,'describe_tasks',return_value=[task(status='STOPPING',desired='STOPPED')]):
            with self.assertRaisesRegex(RuntimeError,'Previous task'):f.assert_quiesced(new,old)

    def test_unknown_stopping_census_is_not_ignored(self):
        old=row();new=zero(old);new['tasks'].append(task(2,'STOPPING','STOPPED'))
        with patch.object(f,'describe_tasks')as describe:
            with self.assertRaisesRegex(RuntimeError,'still active'):f.assert_quiesced(new,old)
            describe.assert_not_called()

    def test_drained_full_readback_passes_failed_zero_deployments(self):
        old=row();new=zero(old);new['deployments'][0]['rolloutState']='FAILED'
        new['deployments'].append({'desired':0,'running':0,'pending':0})
        with patch.object(f,'describe_tasks',return_value=[task(status='STOPPED',desired='STOPPED')]):
            self.assertTrue(f.assert_quiesced(new,old))

    def test_scaler_and_targets_must_be_exact(self):
        old=row()
        with patch.object(f,'describe_tasks',return_value=[task(status='STOPPED',desired='STOPPED')]):
            for mutation in ('capacity','role','suspension','target'):
                new=zero(old)
                if mutation=='capacity':new['scaler']['MaxCapacity']=7
                elif mutation=='role':new['scaler']['RoleARN']='other'
                elif mutation=='suspension':new['scaler']['SuspendedState']={}
                else:new['targets'][TG]=[{'Target':{'Id':'192.0.2.1'}}]
                with self.assertRaises(RuntimeError):f.assert_quiesced(new,old)

    def test_empty_scaler_map_does_not_reread(self):
        service={'serviceName':f.API,'status':'ACTIVE','taskDefinition':TD,'desiredCount':0,'runningCount':0,'pendingCount':0,'deployments':[]}
        with patch.object(f,'aws',return_value={'services':[service],'failures':[]}),patch.object(f,'tasks_for',return_value=[]),patch.object(f,'scalers')as scalers:
            self.assertIsNone(f.service_row(f.API,{})['scaler']);scalers.assert_not_called()

    def test_repeated_pagination_token_fails(self):
        with patch.object(f,'aws',return_value={'rows':[],'nextToken':'same'}):
            with self.assertRaisesRegex(RuntimeError,'repeated'):f.pages(['fake'],'rows')

    def test_strict_plan_and_age_fail_before_writes(self):
        p=plan()
        with patch.object(f,'account',return_value=ACTOR),patch.object(f,'deployment_pins',return_value=p['guardSha256']):
            f.validate_plan(p,True)
            for key,value in [('extra',True),('preparedAt',0),('consumers',[]),('finalImage','mutable:latest')]:
                invalid=copy.deepcopy(p);invalid[key]=value
                with self.assertRaises(RuntimeError):f.validate_plan(invalid,True)
            expired=copy.deepcopy(p);expired['preparedAt']-=1801;expired['snapshot']['capturedAt']-=1801;expired['snapshotSha256']=f.digest(expired['snapshot'])
            with self.assertRaisesRegex(RuntimeError,'expired'):f.validate_plan(expired,True)

    def test_write_intent_durable_before_one_ambiguous_attempt(self):
        with tempfile.TemporaryDirectory()as directory:
            d=Path(directory);calls=[]
            def fail(*args):
                calls.append(args);intent=d/'pause-intent.json'
                self.assertTrue(intent.is_file());self.assertEqual(intent.stat().st_mode&0o777,0o600)
                self.assertEqual(json.loads(intent.read_text())['expected'],{'desired':0})
                raise TimeoutError('fixture ACK lost')
            with patch.object(f,'aws',side_effect=fail):
                with self.assertRaisesRegex(RuntimeError,'ACK unknown'):f.write_once(d,'pause',['ecs','update-service'],{}, {'desired':0})
            self.assertEqual(len(calls),1);self.assertTrue((d/'pause-ack-unknown.json').is_file());self.assertFalse((d/'pause-ack.json').exists())

    def test_suspension_preserves_limits_role_and_all_flags(self):
        p=plan();before=p['snapshot']['services'][f.API]['scaler'];after={**before,'SuspendedState':f.FLAGS}
        with tempfile.TemporaryDirectory()as directory,patch.object(f,'scalers',side_effect=[{f.API:before},{f.API:after}]),patch.object(f,'write_once')as write:
            f.suspend_scaler(p,f.API,Path(directory));args=write.call_args.args[2]
            self.assertEqual(args[args.index('--role-arn')+1],before['RoleARN']);self.assertEqual(args[args.index('--min-capacity')+1],'2')
            self.assertEqual(args[args.index('--max-capacity')+1],'6');self.assertEqual(json.loads(args[-1]),f.FLAGS)

    def test_no_scaler_does_not_create_one(self):
        p=plan();p['snapshot']['services'][f.API]['scaler']=None
        with tempfile.TemporaryDirectory()as directory,patch.object(f,'scalers',return_value={}),patch.object(f,'write_once')as write:
            f.suspend_scaler(p,f.API,Path(directory));write.assert_not_called()

    def test_phases_consumers_then_api_then_worker(self):
        p=plan();events=[]
        with tempfile.TemporaryDirectory()as base,patch.object(f,'validate_plan'),patch.object(f,'fresh_before_writes'),patch.object(f,'validate_deploy_export'),\
            patch.object(f,'suspend_scaler',side_effect=lambda _p,n,_d:events.append(('suspend',n))),\
            patch.object(f,'count_zero',side_effect=lambda _p,n,_d:events.append(('pause',n))),\
            patch.object(f,'wait_quiesced',side_effect=lambda _p,ns,_d:events.append(('wait',tuple(ns)))),patch.object(f,'observe',return_value={'all25Quiesced':True}):
            d=Path(base)/'operation';f.execute_quiescence(p,d)
            self.assertEqual(events[:25],[('suspend',n)for n in f.AFFECTED])
            self.assertEqual(events[25:48],[('pause',n)for n in f.CONSUMERS])
            self.assertEqual(events[48:],[('wait',tuple(f.CONSUMERS)),('pause',f.API),('wait',(f.API,)),('pause',f.WORKER),('wait',(f.WORKER,))])
            self.assertTrue(json.loads((d/'completion.json').read_text())['completed'])
            receipt=json.loads((d/'receipt.json').read_text())
            self.assertEqual(receipt['deployPlanFileSha256'],hashlib.sha256((d/'quiesced-deploy-plan.json').read_bytes()).hexdigest())
            self.assertNotEqual(receipt['deployPlanFileSha256'],receipt['deployPlanCanonicalSha256'])

    def test_failed_consumer_write_never_advances_or_restores(self):
        p=plan();calls=[]
        def pause(_p,n,_d):calls.append(n);raise RuntimeError('ACK unknown')
        with tempfile.TemporaryDirectory()as base,patch.object(f,'validate_plan'),patch.object(f,'fresh_before_writes'),patch.object(f,'suspend_scaler'),patch.object(f,'count_zero',side_effect=pause):
            d=Path(base)/'operation'
            with self.assertRaisesRegex(RuntimeError,'ACK unknown'):f.execute_quiescence(p,d)
            result=json.loads((d/'completion.json').read_text());self.assertFalse(result['completed']);self.assertTrue(result['noAutomaticRestore'])
            self.assertEqual(calls,[f.CONSUMERS[0]])

    def test_cluster_census_blocks_standalone_or_affected_active(self):
        p=plan();rows={n:zero(p['snapshot']['services'][n])for n in f.SERVICES}
        with patch.object(f,'account',return_value=ACTOR),patch.object(f,'service_set'),patch.object(f,'service_row',side_effect=lambda n:rows[n]),patch.object(f,'schedules',return_value=p['snapshot']['schedules']),patch.object(f,'cluster_active_tasks',return_value=[{**task(),'group':'standalone'}]):
            with self.assertRaisesRegex(RuntimeError,'standalone'):f.observe(p)

    def test_export_uses_exact_final_guard_and_js_shape(self):
        guard=subprocess.check_output(['git','show',FINAL_GUARD+':'+f.GUARD_PATHS[0]],cwd=f.ROOT)
        self.assertEqual(hashlib.sha256(guard).hexdigest(),f.EXPECTED_GUARD_SHA)
        with tempfile.TemporaryDirectory()as directory:
            d=Path(directory);target=d/f.GUARD_PATHS[0];target.parent.mkdir(parents=True);target.write_bytes(guard)
            p=plan();p['deploymentCheckout']=str(d);export=f.api_deploy_plan(p);f.validate_deploy_export(p,export)
            invalid={**export,'previousTasks':[TASK+'1'*32,TASK+'1'*32]}
            with self.assertRaisesRegex(RuntimeError,'rejected'):f.validate_deploy_export(p,invalid)
            raw={'taskDefinitionArn':TD,'revision':692,'status':'ACTIVE','family':'oxy-oxy-api','cpu':'1024',
                 'containerDefinitions':[{'name':'oxy-api','image':IMAGE+'a'*64,'environment':[{'name':'MODE','value':'value withheld in real snapshots'}]}]}
            script='import {shapeHash} from '+json.dumps(target.as_uri())+';console.log(shapeHash('+json.dumps(raw)+'));'
            actual=subprocess.check_output(['node','--input-type=module','-e',script],text=True).strip()
            self.assertEqual(f.shape_hash(raw),actual)

    def test_hold_stopping_attempt_rejects_deadline_no_recovery(self):
        p=plan();current=zero(row());current['definition']=NEW;current['tasks']=[task(2,'STOPPING','STOPPED',NEW)]
        raw={'taskDefinitionArn':NEW,'containerDefinitions':[{'name':'oxy-api','image':p['finalImage']}]}
        with tempfile.TemporaryDirectory()as base,patch.object(f,'validate_plan'),patch.object(f,'aws',return_value={'taskDefinition':raw}),patch.object(f,'shape_hash',return_value='c'*64),\
            patch.object(f,'service_row',return_value=current),patch.object(f,'describe_tasks',return_value=current['tasks']),patch.object(f.time,'monotonic',side_effect=[0,901]):
            d=Path(base)/'held'
            with self.assertRaisesRegex(RuntimeError,'hold incomplete'):f.hold_api(p,{'newTaskDefinition':NEW,'attemptedTasks':[TASK+f'{2:032x}']},d)
            self.assertFalse((d/'held-api.json').exists());self.assertFalse(json.loads((d/'completion.json').read_text())['completed'])

    def test_hold_completed_with_failed_zero_deployments_is_bounded(self):
        p=plan();current=zero(row());current['definition']=NEW
        current['deploymentConfiguration']['deploymentCircuitBreaker']['rollback']=False;current['serviceConfigSha256']='1'*64
        current['deployments'][0]['rolloutState']='FAILED';current['deployments'].append({'desired':0,'running':0,'pending':0})
        current['tasks'].append(task(2,'STOPPED','STOPPED',NEW))
        raw={'taskDefinitionArn':NEW,'containerDefinitions':[{'name':'oxy-api','image':p['finalImage']}]}
        with tempfile.TemporaryDirectory()as base,patch.object(f,'validate_plan'),patch.object(f,'aws',return_value={'taskDefinition':raw}),patch.object(f,'shape_hash',return_value='c'*64),\
            patch.object(f,'service_row',return_value=current),patch.object(f,'describe_tasks',return_value=current['tasks']),patch.object(f,'write_once')as write:
            d=Path(base)/'held';f.hold_api(p,{'newTaskDefinition':NEW,'attemptedTasks':[TASK+f'{2:032x}']},d)
            write.assert_not_called();receipt=json.loads((d/'held-api.json').read_text())
            self.assertTrue(receipt['allAttemptedTasksStopped']);self.assertFalse(receipt['recoveryLaunched'])

    def test_count_drift_blocks_pause_before_write(self):
        p=plan();current=row();current['scaler']={**current['scaler'],'SuspendedState':f.FLAGS};current['tasks'].append(task(2))
        with tempfile.TemporaryDirectory()as base,patch.object(f,'service_row',return_value=current),patch.object(f,'write_once')as write:
            with self.assertRaisesRegex(RuntimeError,'census changed'):f.count_zero(p,f.API,Path(base))
            write.assert_not_called()

    def test_33_service_capture_rejects_missing_or_extra(self):
        for names in (f.SERVICES[:-1],f.SERVICES+['unreviewed']):
            with patch.object(f,'pages',return_value=['arn:aws:ecs:us-west-2:237343248947:service/oxy-cluster/'+n for n in names]):
                with self.assertRaisesRegex(RuntimeError,'set drifted'):f.service_set()

    def test_interrupted_does_not_emit_new_write_intent(self):
        f.interrupted=True
        with tempfile.TemporaryDirectory()as base,patch.object(f,'aws')as aws:
            with self.assertRaisesRegex(RuntimeError,'Interrupted'):f.write_once(Path(base),'late',['ecs','update-service'],{}, {})
            self.assertEqual(list(Path(base).iterdir()),[]);aws.assert_not_called()

    def test_hold_accepts_only_exact_canonical_deployment_delta(self):
        old=row();current=zero(old)
        current['deploymentConfiguration']['deploymentCircuitBreaker']['rollback']=False
        f.assert_hold_config(current,old)
        for mode in ('remainder','threshold','reset','max','unknown'):
            invalid=copy.deepcopy(current)
            if mode=='remainder':invalid['serviceConfigExceptDeploymentSha256']='0'*64
            elif mode=='threshold':invalid['deploymentConfiguration']['deploymentCircuitBreaker']['thresholdConfiguration']['value']=51
            elif mode=='reset':invalid['deploymentConfiguration']['deploymentCircuitBreaker']['resetOnHealthyTask']=False
            elif mode=='max':invalid['deploymentConfiguration']['maximumPercent']=150
            else:invalid['deploymentConfiguration']['unreviewed']=True
            with self.assertRaisesRegex(RuntimeError,'configuration drifted'):f.assert_hold_config(invalid,old)

    def test_hold_missing_attempt_is_not_stopped(self):
        p=plan();raw={'taskDefinitionArn':NEW,'containerDefinitions':[{'name':'oxy-api','image':p['finalImage']}]}
        with tempfile.TemporaryDirectory()as base,patch.object(f,'validate_plan'),patch.object(f,'shape_hash',return_value='c'*64),patch.object(f,'aws',side_effect=[{'taskDefinition':raw},{'failures':[{'reason':'MISSING'}],'tasks':[]}]):
            with self.assertRaisesRegex(RuntimeError,'readback'):f.hold_api(p,{'newTaskDefinition':NEW,'attemptedTasks':[TASK+'2'*32]},Path(base)/'held')
            self.assertFalse((Path(base)/'held').exists())


if __name__=='__main__':unittest.main(verbosity=2)
