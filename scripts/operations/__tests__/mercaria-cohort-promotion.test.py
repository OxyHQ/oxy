import copy, importlib.util, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
PATH=Path(__file__).resolve().parents[1]/'mercaria-cohort-promotion.py'
spec=importlib.util.spec_from_file_location('cohort',PATH);c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def baseline():
    return {'family':'oxy-mercaria','taskDefinitionArn':c.OLD_TD,'revision':60,'status':'ACTIVE','requiresAttributes':[],
      'executionRoleArn':'existing-role','networkMode':'awsvpc','cpu':'256','memory':'512',
      'containerDefinitions':[{'name':'mercaria','image':c.OLD_IMAGE,'environment':[{'name':'STRIPE_ENABLED','value':'false'},{'name':'UNCHANGED','value':'public'}],
        'secrets':[{'name':x,'valueFrom':c.SSM+x} for x in ['OXY_APPLICATION_KEY','OXY_APPLICATION_SECRET','STRIPE_SECRET_KEY']],
        'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-region':'us-west-2','awslogs-group':'/oxy/ecs','awslogs-stream-prefix':'mercaria'}},
        'portMappings':[{'containerPort':3001}],'command':['node','dist/index.js']},
        {'name':'collector','image':'old-sidecar','environment':[{'name':'KEEP','value':'yes'}]}], 'volumes':[]}
NEW='237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mercaria@sha256:'+'a'*64

class Tests(unittest.TestCase):
    def test_render_exact_image_public_cohort_and_existing_secret_aliases_only(self):
        old=baseline();new=c.render(old,NEW);chosen=new['containerDefinitions'][0]
        self.assertEqual(chosen['image'],NEW);self.assertEqual(json.loads(next(x['value'] for x in chosen['environment'] if x['name']=='MERCHANT_BILLING_PEABLE_COHORT')),c.COHORT)
        expected=c.m.td_semantic(old);e=expected['containerDefinitions'][0];e['image']=NEW
        e['environment'].append({'name':'MERCHANT_BILLING_PEABLE_COHORT','value':json.dumps(c.COHORT,separators=(',',':'))})
        for target,source in c.ALIASES.items():e['secrets'].append({'name':target,'valueFrom':c.SSM+source})
        self.assertEqual(new,c.m.td_semantic(expected));self.assertEqual(old,baseline())
        self.assertEqual(new['containerDefinitions'][1],old['containerDefinitions'][1]);self.assertNotIn('revision',new)
    def test_environment_reordering_normalizes_but_duplicates_are_denied(self):
        old=baseline();a=c.render(old,NEW)
        old['containerDefinitions'][0]['environment'].reverse();old['containerDefinitions'][0]['secrets'].reverse();self.assertEqual(a,c.render(old,NEW))
        old['containerDefinitions'][0]['environment'].append(old['containerDefinitions'][0]['environment'][0]);self.assertRaises(RuntimeError,c.render,old,NEW)
    def test_enabled_general_or_action_rail_rejected(self):
        for field in ['STRIPE_ENABLED','MERCHANT_BILLING_ENABLED']:
            old=baseline();rows=old['containerDefinitions'][0]['environment'];rows[:]=[x for x in rows if x['name']!=field];rows.append({'name':field,'value':'true'})
            with self.subTest(field=field):self.assertRaises(ValueError,c.render,old,NEW)
    def test_existing_foreign_half_pair_or_missing_stripe_reference_rejected(self):
        for field in ['OXY_APPLICATION_KEY','OXY_APPLICATION_SECRET','STRIPE_SECRET_KEY']:
            old=baseline();rows=old['containerDefinitions'][0]['secrets'];next(x for x in rows if x['name']==field)['valueFrom']='foreign'
            with self.subTest(field=field):self.assertRaises(ValueError,c.render,old,NEW)
        old=baseline();old['containerDefinitions'][0]['environment'].append({'name':'PEABLE_APP_SECRET','value':'do-not-copy'});self.assertRaises(ValueError,c.render,old,NEW)
    def test_existing_cohort_or_foreign_selected_image_rejected(self):
        old=baseline();old['containerDefinitions'][0]['environment'].append({'name':'MERCHANT_BILLING_PEABLE_COHORT','value':'{}'});self.assertRaises(ValueError,c.render,old,NEW)
        self.assertRaises(ValueError,c.render,baseline(),c.OLD_IMAGE)
        old=baseline();old['containerDefinitions'][0]['image']='foreign';self.assertRaises(ValueError,c.render,old,NEW)
    def test_exact_positive_is_required_and_all_mismatches_rejected(self):
        self.assertFalse(c.log_matches([{'message':'{}'}]))
        self.assertTrue(c.log_matches([{'message':json.dumps({**c.POSITIVE,'level':30})}]))
        for field in ['cohortSha256','mode','environment','storeCount']:
            with self.subTest(field=field):self.assertRaises(ValueError,c.log_matches,[{'message':json.dumps({**c.POSITIVE,field:'foreign'})}])
        self.assertRaises(ValueError,c.log_matches,[{'message':json.dumps({'msg':'Merchant billing registration failed'})}])
    def test_target_initial_unhealthy_and_known_old_draining_wait_but_foreign_denied(self):
        def row(ip,state,port=3001):return {'Target':{'Id':ip,'Port':port},'TargetHealth':{'State':state}}
        for state in ['initial','unhealthy']:
            self.assertFalse(c.target_ready([row('new',state)],{'new'},{'old'},3001))
        self.assertFalse(c.target_ready([row('new','healthy'),row('old','draining')],{'new'},{'old'},3001))
        self.assertTrue(c.target_ready([row('new','healthy')],{'new'},{'old'},3001))
        self.assertRaises(ValueError,c.target_ready,[row('foreign','healthy')],{'new'},{'old'},3001)
        self.assertRaises(ValueError,c.target_ready,[row('old','healthy')],{'new'},{'old'},3001)
    def test_task_attachment_uses_actual_ecs_representation(self):
        t={'attachments':[{'type':'ElasticNetworkInterface','details':[{'name':'privateIPv4Address','value':'10.0.0.1'}]}]}
        self.assertEqual(c.task_ips([t]),{'10.0.0.1'})
        self.assertRaises(ValueError,c.task_ips,[t,t])
        self.assertRaises(ValueError,c.task_ips,[{'attachments':[]}])
    def execution(self,transport_unknown=False,monitor_failure=False):
        body=c.render(baseline(),NEW);body['tags']=[{'key':'owned','value':'yes'}]
        p={'registration':body,'baselineService':{'desiredCount':1}};calls=[];newarn=c.PREFIX+'61'
        def fake(*args,write=False):
            calls.append((args,write))
            if args[1]=='register-task-definition':
                # The exact fsynced file exists before the one mutation attempt.
                intent=Path(args[3].removeprefix('file://'));self.assertEqual(json.loads(intent.read_text()),body)
                return {'taskDefinition':{'taskDefinitionArn':newarn}}
            if transport_unknown:raise c.UnknownAck('unknown')
            return {'service':{}}
        def mon(*_):
            if monitor_failure:raise ValueError('registration_failed')
        with tempfile.TemporaryDirectory(dir='/home/nate/Oxy/.agent-evidence') as d:
            out=Path(d)/'out'
            with patch.object(c,'validate') as validate,patch.object(c,'aws',side_effect=fake),patch.object(c,'td',return_value={'taskDefinition':{**{k:v for k,v in body.items() if k!='tags'},'taskDefinitionArn':newarn},'tags':body['tags']}),patch.object(c,'monitor',side_effect=mon):
                if transport_unknown or monitor_failure:self.assertRaises((c.UnknownAck,ValueError),c.execute,p,out)
                else:c.execute(p,out)
                self.assertEqual(validate.call_count,2)
                self.assertTrue((out/'registration-intent.json').exists());self.assertTrue((out/'update-intent.json').exists())
                self.assertEqual(len([x for x in calls if x[1]]),2)
                if monitor_failure or transport_unknown:
                    failure=json.loads((out/'failure.json').read_text());self.assertFalse(failure['automaticScaleZero']);self.assertFalse(failure['automaticOldImageRollback']);self.assertEqual(failure['baselineDefinition'],c.OLD_TD);self.assertEqual(failure['preservedDesiredCount'],1)
                for args,write in calls:
                    if write:self.assertNotIn('--desired-count',args)
                if transport_unknown:self.assertTrue((out/'failure.json').exists());self.assertFalse((out/'update-ack.json').exists())
    def test_success_uses_private_registration_file_and_one_td_only_update(self):self.execution()
    def test_unknown_ack_has_no_retry_or_automatic_hold_or_false_acceptance(self):self.execution(transport_unknown=True)
    def test_confirmed_failure_stops_without_count_or_rollback_write(self):self.execution(monitor_failure=True)
    def test_monitor_requires_positive_in_every_actual_new_task_before_acceptance(self):
        arn=c.PREFIX+'61'
        service={'taskDefinition':arn,'desiredCount':2,'runningCount':2,'pendingCount':0,'deployments':[{'rolloutState':'COMPLETED'}],'loadBalancers':[{'targetGroupArn':'owned-target-group','containerPort':3001}]}
        def task(n,ip,definition=arn):return {'taskArn':'arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/'+str(n).zfill(32),'taskDefinitionArn':definition,'lastStatus':'RUNNING','containers':[{'name':'mercaria','lastStatus':'RUNNING','imageDigest':NEW.split('@')[1]}],'attachments':[{'type':'ElasticNetworkInterface','details':[{'name':'privateIPv4Address','value':ip}]}]}
        live=[task(1,'10.0.0.1'),task(2,'10.0.0.2')]
        p={'baselineService':{**service,'taskDefinition':c.OLD_TD},'baselineTaskRows':[task(9,'10.0.0.9',c.OLD_TD)],'identity':{'imageUri':NEW},'registration':c.render(baseline(),NEW)}
        health={'TargetHealthDescriptions':[{'Target':{'Id':ip,'Port':3001},'TargetHealth':{'State':'healthy'}}for ip in ['10.0.0.1','10.0.0.2']]}
        with tempfile.TemporaryDirectory(dir='/home/nate/Oxy/.agent-evidence') as d,patch.object(c,'service',return_value=service),patch.object(c,'tasks',side_effect=lambda status:[t['taskArn']for t in live]if status=='RUNNING'else []),patch.object(c,'describe',return_value=live),patch.object(c,'aws',return_value=health),patch.object(c,'own_logs',side_effect=[True,False,True,True]) as logs,patch.object(c,'public_smoke',return_value=[{'status':200}]) as smoke,patch.object(c.time,'sleep') as sleep:
            out=Path(d);c.monitor(p,arn,out)
            self.assertEqual(logs.call_count,4);sleep.assert_called_once();smoke.assert_called_once()
            result=json.loads((out/'accepted.json').read_text());self.assertTrue(result['everyTaskRegistrationPositive']);self.assertEqual(len(result['tasks']),2)
    def test_steady_baseline_must_preserve_available_rolling_mode(self):
        s={'taskDefinition':c.OLD_TD,'desiredCount':1,'runningCount':1,'pendingCount':0,'deployments':[{'rolloutState':'COMPLETED'}],'deploymentConfiguration':{'minimumHealthyPercent':100,'maximumPercent':200,'deploymentCircuitBreaker':{'enable':True,'rollback':False}}}
        c.steady(s)
        for field,value in [('minimumHealthyPercent',0),('maximumPercent',100)]:
            other=copy.deepcopy(s);other['deploymentConfiguration'][field]=value;self.assertRaises(ValueError,c.steady,other)
        other=copy.deepcopy(s);other['deploymentConfiguration']['deploymentCircuitBreaker']['rollback']=True;self.assertRaises(ValueError,c.steady,other)
    def test_aws_generated_tags_excluded_and_custom_tags_retained(self):
        self.assertEqual(c.tags({'tags':[{'key':'aws:reserved','value':'x'},{'key':'keep','value':'yes'}]}),[{'key':'keep','value':'yes'}])

if __name__=='__main__':unittest.main()
