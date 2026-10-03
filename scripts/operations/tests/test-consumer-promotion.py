#!/usr/bin/env python3
"""Synthetic external evidence/AWS fixtures. No live task or provider effects."""
import base64
import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path=Path(__file__).resolve().parents[1]/'consumer-promotion.py'
spec=importlib.util.spec_from_file_location('consumer',path)
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
f=c.f
TD='arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-homiio:9'
NEW=TD.rsplit(':',1)[0]+':10'
IMAGE='237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/homiio@sha256:'
TASK='arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/'


def raw():
    return {'taskDefinitionArn':TD,'revision':9,'status':'ACTIVE','registeredAt':'fixture','registeredBy':'fixture',
        'requiresAttributes':[],'compatibilities':['FARGATE'],'family':'oxy-homiio','cpu':'512','memory':'1024','networkMode':'awsvpc',
        'runtimePlatform':{'cpuArchitecture':'ARM64','operatingSystemFamily':'LINUX'},'containerDefinitions':[
        {'name':'actual-backend','image':IMAGE+'a'*64,'command':['node','dist/index.js'],'essential':True,
         'environment':[{'name':'Z','value':'fixture-only'},{'name':'A','value':'same'}],
         'secrets':[{'name':'Z_SECRET','valueFrom':'arn:parameter:metadata-z'},{'name':'DATABASE_URL','valueFrom':'arn:parameter:metadata-db'}]},
        {'name':'searxng','image':'searxng@sha256:'+'b'*64,'essential':False,'command':['sidecar']}],
        'executionRoleArn':'arn:aws:iam::237343248947:role/fixture-execution','taskRoleArn':'arn:aws:iam::237343248947:role/fixture-task'}


def task(index=1,status='RUNNING',desired='RUNNING',definition=NEW):
    return {'arn':TASK+f'{index:032x}','group':'service:homiio','definition':definition,'lastStatus':status,'desiredStatus':desired,
        'containers':[{'name':'actual-backend','digest':'sha256:'+'c'*64}]}


def baseline():
    return {'service':'homiio','definition':TD,'desired':1,'running':1,'pending':0,'tasks':[task(definition=TD)],
        'serviceConfigSha256':'0'*64,'serviceConfigExceptDeploymentSha256':'1'*64,'targetGroups':[],'targets':{},
        'deploymentConfiguration':{'deploymentCircuitBreaker':{'enable':True,'rollback':True,'resetOnHealthyTask':True,
            'thresholdConfiguration':{'type':'BOUNDED_PERCENT','value':50}},'maximumPercent':200,'minimumHealthyPercent':100,'bakeTimeInMinutes':0},
        'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED','definition':TD,'desired':1,'running':1,'pending':0}],
        'scaler':{'ResourceId':'service/oxy-cluster/homiio','MinCapacity':1,'MaxCapacity':3,'RoleARN':'fixture-role',
            'SuspendedState':{k:False for k in f.FLAGS}}}


def plan():
    r=raw();body=c.render(r,[],'actual-backend',IMAGE+'c'*64)
    return {'config':{'service':'homiio','container':'actual-backend'},'baseline':baseline(),
            'identity':{'imageUri':IMAGE+'c'*64,'manifestSha256':'c'*64},'registrationCanonicalSha256':f.digest(body),'tagsSha256':f.digest([])}


def active(p):
    row=copy.deepcopy(p['baseline']);row['definition']=NEW;row['tasks']=[task()];row['deployments'][0]['definition']=NEW
    row['scaler']['SuspendedState']=f.FLAGS;row['deploymentConfiguration']=c.expected_config(p['baseline']);return row


class ConsumerTests(unittest.TestCase):
    def tearDown(self):f.interrupted=False

    def test_only_selected_image_changes_sidecar_roles_commands_preserved(self):
        original=raw();body=c.render(original,[],'actual-backend',IMAGE+'c'*64)
        self.assertEqual(body['containerDefinitions'][1],original['containerDefinitions'][1]);self.assertEqual(body['taskRoleArn'],original['taskRoleArn'])
        body['containerDefinitions'][0]['image']=original['containerDefinitions'][0]['image']
        self.assertEqual(body,c.td_semantic(original));self.assertNotIn('tags',body)
        self.assertNotIn('revision',body);self.assertNotIn('status',body);self.assertNotIn('registeredBy',body)

    def test_registered_env_secret_name_order_accepted_full_values_checked(self):
        body=c.render(raw(),[{'key':'existing','value':'same'}],'actual-backend',IMAGE+'c'*64)
        registered=copy.deepcopy(body);registered.pop('tags');registered['taskDefinitionArn']=NEW
        registered['containerDefinitions'][0]['environment'].reverse();registered['containerDefinitions'][0]['secrets'].reverse()
        c.registered_matches(registered,[{'key':'existing','value':'same'}],body)
        registered['containerDefinitions'][0]['environment'][0]['value']='changed'
        with self.assertRaisesRegex(RuntimeError,'changed configuration'):c.registered_matches(registered,[{'key':'existing','value':'same'}],body)

    def test_unexpected_td_fields_duplicate_names_and_wrong_selection_reject(self):
        for mode in ('field','environment','secret','container'):
            value=raw()
            if mode=='field':value['unknownReadonlyFuture']='deny'
            elif mode=='environment':value['containerDefinitions'][0]['environment'].append({'name':'A','value':'other'})
            elif mode=='secret':value['containerDefinitions'][0]['secrets'].append({'name':'DATABASE_URL','valueFrom':'other'})
            else:value['containerDefinitions'].append(copy.deepcopy(value['containerDefinitions'][0]))
            with self.assertRaises(RuntimeError):c.render(value,[],'actual-backend',IMAGE+'c'*64)
        with self.assertRaises(RuntimeError):c.render(raw(),[],'homiio',IMAGE+'c'*64)

    def test_dns_build_recipe_not_promotable(self):
        lots={'consumers':[{'repository':'OxyHQ/tnp','imageRecipes':[{'service':'tnp-dns'}]}]}
        with self.assertRaisesRegex(RuntimeError,'20 affected'):c.recipe_for(lots,'tnp-dns')

    def test_duplicate_recipe_rejected(self):
        lots={'consumers':[{'repository':'OxyHQ/Homiio','imageRecipes':[{'service':'homiio'}]*2}]}
        with self.assertRaises(RuntimeError):c.recipe_for(lots,'homiio')

    def test_registration_intent_precedes_stdin_write_and_readback(self):
        p=plan();calls=[]
        with tempfile.TemporaryDirectory()as base:
            d=Path(base)
            def register(body):
                self.assertTrue((d/'register-intent.json').is_file());self.assertEqual(json.loads((d/'register-intent.json').read_text())['requestCanonicalSha256'],f.digest(body))
                calls.append(body);return {'taskDefinition':{'taskDefinitionArn':NEW}}
            new={**c.render(raw(),[],'actual-backend',IMAGE+'c'*64),'taskDefinitionArn':NEW}
            with patch.object(c,'task_definition',side_effect=[(raw(),[]),(new,[])]),patch.object(c,'aws_register',side_effect=register):
                self.assertEqual(c.register(p,d),NEW)
            self.assertEqual(len(calls),1);self.assertTrue((d/'registered.json').is_file());self.assertTrue((d/'register-ack.json').is_file())
            self.assertNotIn('fixture-only',(d/'register-intent.json').read_text())

    def test_registration_ack_lost_no_retry(self):
        p=plan()
        with tempfile.TemporaryDirectory()as base,patch.object(c,'task_definition',return_value=(raw(),[])),patch.object(c,'aws_register',side_effect=TimeoutError())as register:
            with self.assertRaisesRegex(RuntimeError,'ACK unknown'):c.register(p,Path(base))
            self.assertEqual(register.call_count,1);self.assertTrue((Path(base)/'register-ack-unknown.json').is_file())

    def test_registered_sidecar_change_rejected(self):
        p=plan();new=c.render(raw(),[],'actual-backend',IMAGE+'c'*64);new['taskDefinitionArn']=NEW;new['containerDefinitions'][1]['image']='changed'
        with tempfile.TemporaryDirectory()as base,patch.object(c,'task_definition',side_effect=[(raw(),[]),(new,[])]),patch.object(c,'aws_register',return_value={'taskDefinition':{'taskDefinitionArn':NEW}}):
            with self.assertRaisesRegex(RuntimeError,'changed configuration'):c.register(p,Path(base))
            self.assertTrue((Path(base)/'register-ack.json').is_file());self.assertFalse((Path(base)/'registered.json').exists())

    def test_promote_updates_td_count_and_no_auto_rollback_in_one_call(self):
        p=plan()
        with tempfile.TemporaryDirectory()as base,patch.object(c,'validate'),patch.object(c,'assert_zero'),patch.object(f,'service_row'),\
            patch.object(c,'register',return_value=NEW),patch.object(c,'monitor',return_value=active(p)),patch.object(c,'run_smoke',side_effect=lambda p,d:f.private_json(d/'smoke-result.json',{'exitCode':0})),patch.object(f,'write_once')as write:
            c.promote(p,Path(base)/'promote');args=write.call_args.args[2]
            self.assertEqual(args[args.index('--task-definition')+1],NEW);self.assertEqual(args[args.index('--desired-count')+1],'1')
            config=json.loads(args[args.index('--deployment-configuration')+1]);self.assertFalse(config['deploymentCircuitBreaker']['rollback'])
            self.assertTrue(config['deploymentCircuitBreaker']['resetOnHealthyTask']);self.assertEqual(config['maximumPercent'],200)

    def test_smoke_failure_attempts_hold_not_old_rollback(self):
        p=plan()
        with tempfile.TemporaryDirectory()as base,patch.object(c,'validate'),patch.object(c,'assert_zero'),patch.object(f,'service_row'),\
            patch.object(c,'register',return_value=NEW),patch.object(c,'monitor',return_value=active(p)),patch.object(c,'run_smoke',side_effect=RuntimeError('failed')),\
            patch.object(f,'write_once'),patch.object(c,'hold_failed')as hold:
            d=Path(base)/'promote'
            with self.assertRaises(RuntimeError):c.promote(p,d)
            hold.assert_called_once();receipt=json.loads((d/'completion.json').read_text());self.assertFalse(receipt['completed']);self.assertTrue(receipt['noOldImageRollback'])

    def test_update_ack_unknown_blocks_advance_and_auto_retry(self):
        p=plan()
        def unknown(d,*args):f.private_json(d/'promote-ack-unknown.json',{'unknown':True});raise RuntimeError('ACK unknown')
        with tempfile.TemporaryDirectory()as base,patch.object(c,'validate'),patch.object(c,'assert_zero'),patch.object(f,'service_row'),\
            patch.object(c,'register',return_value=NEW),patch.object(f,'write_once',side_effect=unknown),patch.object(c,'monitor')as monitor,patch.object(c,'hold_failed')as hold:
            with self.assertRaises(RuntimeError):c.promote(p,Path(base)/'promote')
            monitor.assert_not_called();hold.assert_not_called()

    def test_failed_rollout_held_zero_even_older_stopping_task(self):
        p=plan();stopping=active(p);stopping['tasks']=[task(status='STOPPING',desired='STOPPED'),task(2,'STOPPING','STOPPED',TD)]
        stopped=copy.deepcopy(stopping)
        for k in ('desired','running','pending'):stopped[k]=0
        for k in ('desired','running','pending'):stopped['deployments'][0][k]=0
        stopped['deployments'][0]['rolloutState']='FAILED';stopped['tasks']=[{**t,'lastStatus':'STOPPED'}for t in stopped['tasks']]
        remembered=set()
        with tempfile.TemporaryDirectory()as base,patch.object(f,'service_row',side_effect=[stopping,stopped]),patch.object(f,'write_once')as write,patch.object(f,'describe_tasks',return_value=stopped['tasks']):
            c.hold_failed(p,NEW,Path(base),remembered)
            self.assertEqual(len(remembered),2);self.assertTrue(json.loads((Path(base)/'held.json').read_text())['heldCount0'])
            args=write.call_args.args[2];self.assertEqual(args[-1],'0');self.assertNotIn('--task-definition',args)

    def test_hold_missing_attempt_is_not_safe(self):
        p=plan();row=active(p)
        with tempfile.TemporaryDirectory()as base,patch.object(f,'service_row',return_value=row),patch.object(f,'write_once'),patch.object(f,'describe_tasks',side_effect=RuntimeError('Task readback missing')):
            with self.assertRaisesRegex(RuntimeError,'readback missing'):c.hold_failed(p,NEW,Path(base),set())
            self.assertFalse((Path(base)/'held.json').exists())

    def test_monitor_wrong_running_digest_denied(self):
        p=plan();row=active(p);row['tasks'][0]['containers'][0]['digest']='sha256:'+'d'*64
        with tempfile.TemporaryDirectory()as base,patch.object(f,'service_row',return_value=row):
            with self.assertRaisesRegex(RuntimeError,'digest differs'):c.monitor(p,NEW,Path(base),set())

    def test_scaler_restore_requires_own_smoke_and_preserves_original_flags(self):
        p=plan();p['config']['smoke']={'sha256':'f'*64}
        receipt={'kind':'consumer-promotion-receipt-v1','planCanonicalSha256':f.digest(p),'newTaskDefinition':NEW,'service':active(p),
            'smokeResult':{'path':'fixture','sha256':'f'*64},'allAttemptedTasks':[],'ownSmokePassed':True,'scalerRestored':False}
        with tempfile.TemporaryDirectory()as base,patch.object(c,'validate'),patch.object(c,'read_ref',side_effect=[receipt,{'exitCode':0,'scriptSha256':'f'*64}]),\
            patch.object(f,'service_row',return_value=active(p)),patch.object(f,'write_once')as write,patch.object(f,'scalers',return_value={'homiio':p['baseline']['scaler']}):
            c.restore_scaler(p,{},Path(base)/'restore');args=write.call_args.args[2]
            self.assertEqual(json.loads(args[-1]),p['baseline']['scaler']['SuspendedState']);self.assertEqual(args[args.index('--role-arn')+1],'fixture-role')
        receipt['ownSmokePassed']=False
        with tempfile.TemporaryDirectory()as base,patch.object(c,'validate'),patch.object(c,'read_ref',return_value=receipt),patch.object(f,'write_once')as write:
            with self.assertRaisesRegex(RuntimeError,'receipt'):c.restore_scaler(p,{},Path(base)/'restore')
            write.assert_not_called()

    def test_cli_requires_exact_reviewed_plan_bytes_before_any_operation(self):
        with tempfile.TemporaryDirectory() as base:
            p=Path(base)/'plan.json';p.write_text('{}\n')
            for digest in (None,'e'*64):
                argv=['consumer-promotion.py','--promote','--plan',str(p),'--output',base+'/out']
                if digest:argv+=['--plan-file-sha256',digest]
                with patch.object(sys,'argv',argv),patch.object(c,'promote')as promote:
                    with self.assertRaisesRegex(RuntimeError,'plan byte hash'):c.main()
                    promote.assert_not_called()
            expected=hashlib.sha256(p.read_bytes()).hexdigest()
            with patch.object(sys,'argv',['consumer-promotion.py','--promote','--plan',str(p),'--output',base+'/out','--plan-file-sha256',expected]),patch.object(c,'promote')as promote:
                c.main();promote.assert_called_once_with({},base+'/out')

    def test_bootstrap_managed_is_explicit_and_only_two_reviewed_services(self):
        identity={'sourceSha':'e'*40,'imageUri':IMAGE+'c'*64}
        for service in ('tnp-api','website-api'):
            receipt={'kind':'root-consumer-migration-verification-v1','service':service,'sourceSha':identity['sourceSha'],
                'imageUri':identity['imageUri'],'mode':'bootstrap-managed','evidence':[{'path':'fixture','sha256':'f'*64}]}
            with patch.object(c,'read_ref',side_effect=[receipt,{'canonicalStartup':'synthetic source binding'}]):
                self.assertEqual(c.migration_policy({'mode':'bootstrap-managed','verification':{}},identity,service),receipt)
        with self.assertRaisesRegex(RuntimeError,'not reviewed'):
            c.migration_policy({'mode':'bootstrap-managed','verification':{}},identity,'homiio')

    def test_required_and_not_required_migration_are_explicit_bound_receipts(self):
        identity={'sourceSha':'e'*40,'imageUri':IMAGE+'c'*64}
        for mode in ('required','not-required'):
            receipt={'kind':'root-consumer-migration-verification-v1','service':'homiio','sourceSha':identity['sourceSha'],
                'imageUri':identity['imageUri'],'mode':mode,'evidence':[{'path':'fixture','sha256':'f'*64}]}
            with patch.object(c,'read_ref',side_effect=[receipt,{'fixture':'synthetic'}]):c.migration_policy({'mode':mode,'verification':{}},identity,'homiio')
        with self.assertRaises(RuntimeError):c.migration_policy({},identity,'homiio')

    def test_image_proof_links_actual_source_dockerfile_and_ecr_manifest(self):
        dockerfile=b'FROM fixture-only\n';config_digest='d'*64
        manifest=json.dumps({'schemaVersion':2,'config':{'digest':'sha256:'+config_digest},'layers':[]},separators=(',',':'))
        manifest_sha=hashlib.sha256(manifest.encode()).hexdigest()
        recipe={'repository':'OxyHQ/Homiio','dockerfile':'Dockerfile','dockerfileSha256':hashlib.sha256(dockerfile).hexdigest(),'target':'api','ecrRepository':'oxy/homiio'}
        receipt={'kind':'root-consumer-image-verification-v1','service':'homiio','repository':recipe['repository'],'sourceSha':'e'*40,'sourceTreeSha':'f'*40,
            'imageUri':IMAGE+manifest_sha,'manifestSha256':manifest_sha,'configSha256':config_digest,'platform':'linux/arm64',
            'dockerfileSha256':recipe['dockerfileSha256'],'target':'api','evidence':[{'fixture':'external inspection record'}]}
        commit={'sha':'e'*40,'tree':{'sha':'f'*40}};contents={'type':'file','encoding':'base64','content':base64.b64encode(dockerfile).decode()}
        image={'failures':[],'images':[{'imageId':{'imageDigest':'sha256:'+manifest_sha},'imageManifest':manifest}]}
        with patch.object(c,'read_ref',side_effect=[receipt,{'synthetic':'external proof'}]),patch.object(c,'gh_json',side_effect=[commit,contents]),patch.object(f,'aws',return_value=image):
            self.assertEqual(c.image_identity({'service':'homiio','imageVerification':{}},recipe),receipt)
        for mode in ('source','dockerfile','manifest','uri'):
            changed=copy.deepcopy(receipt);gh=[commit,contents];ecr=copy.deepcopy(image)
            if mode=='source':gh[0]={'sha':'different','tree':{'sha':'f'*40}}
            elif mode=='dockerfile':gh[1]={'type':'file','encoding':'base64','content':base64.b64encode(b'changed').decode()}
            elif mode=='manifest':ecr['images'][0]['imageManifest']=manifest+' '
            else:changed['imageUri']='mutable:latest'
            with patch.object(c,'read_ref',side_effect=[changed,{}]),patch.object(c,'gh_json',side_effect=gh),patch.object(f,'aws',return_value=ecr):
                with self.assertRaises(RuntimeError):c.image_identity({'service':'homiio','imageVerification':{}},recipe)

    def test_evidence_changed_bytes_fail_before_use(self):
        with tempfile.TemporaryDirectory()as base:
            path=Path(base)/'proof.json';path.write_text('{"fixture":true}')
            reference=c.ref(path);path.write_text('{"fixture":false}')
            with self.assertRaisesRegex(RuntimeError,'bytes changed'):c.read_ref(reference)

    def test_aws_registration_transports_json_stdin_not_argv(self):
        import os,sys
        with tempfile.TemporaryDirectory()as base:
            script=Path(base)/'aws';script.write_text('#!'+sys.executable+'\nimport sys,json\na=json.load(sys.stdin)\nassert sys.argv[sys.argv.index("--cli-input-json")+1]=="file:///dev/stdin"\nassert not any("fixture-only" in x for x in sys.argv)\nprint(json.dumps({"taskDefinition":{"taskDefinitionArn":"'+NEW+'"}}))\n')
            script.chmod(0o700)
            with patch.dict(os.environ,{'PATH':base}):self.assertEqual(c.aws_register(c.render(raw(),[],'actual-backend',IMAGE+'c'*64))['taskDefinition']['taskDefinitionArn'],NEW)

    def test_explicit_hold_revalidates_registered_td_without_fresh_github(self):
        p=plan();body=c.render(raw(),[],'actual-backend',IMAGE+'c'*64);new={**body,'taskDefinitionArn':NEW}
        record={'taskDefinition':NEW,'semanticSha256':f.digest(c.td_semantic(new)),'tagsSha256':f.digest([]),
            'registrationCanonicalSha256':p['registrationCanonicalSha256'],'planCanonicalSha256':f.digest(p)}
        with tempfile.TemporaryDirectory()as base,patch.object(c,'validate')as validate,patch.object(c,'read_ref',return_value=record),            patch.object(c,'task_definition',side_effect=[(raw(),[]),(new,[])]),patch.object(c,'hold_failed')as hold:
            c.hold_reviewed(p,{},Path(base)/'hold');validate.assert_called_once_with(p,image_reads=False);hold.assert_called_once()

    def test_smoke_real_process_stdout_withheld_and_failure_detected(self):
        with tempfile.TemporaryDirectory()as base:
            d=Path(base);script=d/'smoke.py';script.write_text("print('synthetic output not retained')\nraise SystemExit(1)\n")
            p=plan();p['config']['smoke']={'script':str(script),'sha256':hashlib.sha256(script.read_bytes()).hexdigest(),'interpreter':'python3','arguments':[],'timeoutSeconds':5}
            with self.assertRaisesRegex(RuntimeError,'smoke failed'):c.run_smoke(p,d)
            receipt=json.loads((d/'smoke-result.json').read_text());self.assertEqual(receipt['exitCode'],1);self.assertTrue(receipt['rawOutputWithheld'])
            self.assertNotIn('synthetic output',(d/'smoke-result.json').read_text())


if __name__=='__main__':unittest.main(verbosity=2)
