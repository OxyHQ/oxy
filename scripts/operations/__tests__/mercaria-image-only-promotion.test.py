import copy, http.server, importlib.util, json, stat, tempfile, threading, unittest, urllib.parse
from pathlib import Path
from unittest.mock import patch
PATH=Path(__file__).resolve().parents[1]/'mercaria-image-only-promotion.py'
spec=importlib.util.spec_from_file_location('image_only',PATH);c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
NEW='237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mercaria@sha256:'+'a'*64

def baseline():
    return {'family':'oxy-mercaria','taskDefinitionArn':c.OLD_TD,'revision':61,'status':'ACTIVE','taskRoleArn':'existing-task-role','executionRoleArn':'existing-execution-role','networkMode':'awsvpc','cpu':'256','memory':'512','runtimePlatform':{'cpuArchitecture':'ARM64','operatingSystemFamily':'LINUX'},'volumes':[],
      'containerDefinitions':[{'name':'mercaria','image':c.OLD_IMAGE,'environment':[{'name':'STRIPE_ENABLED','value':'false'},{'name':'UNCHANGED','value':'public'},{'name':'MERCHANT_BILLING_PEABLE_COHORT','value':json.dumps(c.COHORT,indent=1)}],
      'secrets':[{'name':x,'valueFrom':c.SSM+x}for x in ['OXY_APPLICATION_KEY','OXY_APPLICATION_SECRET','STRIPE_SECRET_KEY']]+[{'name':t,'valueFrom':c.SSM+s}for t,s in c.ALIASES.items()],
      'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-region':'us-west-2','awslogs-group':'/oxy/ecs','awslogs-stream-prefix':'mercaria'}},'portMappings':[{'containerPort':3001}],'command':['node','dist/index.js']}, {'name':'collector','image':'same-sidecar','environment':[{'name':'KEEP','value':'yes'}]}]}

def service():
    return {'serviceName':'mercaria','taskDefinition':c.OLD_TD,'desiredCount':1,'runningCount':1,'pendingCount':0,'deployments':[{'id':'baseline','rolloutState':'COMPLETED'}],'deploymentConfiguration':{'minimumHealthyPercent':100,'maximumPercent':200,'deploymentCircuitBreaker':{'enable':True,'rollback':False}},'loadBalancers':[],'networkConfiguration':{'awsvpcConfiguration':{'assignPublicIp':'DISABLED','subnets':['original'],'securityGroups':['original']}}}

class Tests(unittest.TestCase):
    def test_only_image_changes_including_literal_cohort_sidecar_roles_and_flags(self):
        old=baseline();before=copy.deepcopy(old);actual=c.render(old,NEW);expected=c.m.td_semantic(old);expected['containerDefinitions'][0]['image']=NEW
        self.assertEqual(actual,c.m.td_semantic(expected));self.assertEqual(old,before)
        self.assertEqual(actual['containerDefinitions'][0]['environment'],c.m.td_semantic(old)['containerDefinitions'][0]['environment'])
        self.assertEqual(actual['containerDefinitions'][0]['secrets'],c.m.td_semantic(old)['containerDefinitions'][0]['secrets'])
        self.assertEqual(actual['taskRoleArn'],old['taskRoleArn']);self.assertEqual(actual['containerDefinitions'][1],old['containerDefinitions'][1])
    def test_cohort_alias_flag_duplicate_and_image_drift_denied(self):
        mutations=[lambda b:b['containerDefinitions'][0]['environment'].append({'name':'MERCHANT_BILLING_ENABLED','value':'true'}),lambda b:b['containerDefinitions'][0]['environment'].append({'name':'STRIPE_ENABLED','value':'true'}),lambda b:b['containerDefinitions'][0]['environment'].append({'name':'PEABLE_APP_SECRET','value':'do-not-copy'}),lambda b:b['containerDefinitions'][0]['secrets'].pop(),lambda b:b['containerDefinitions'][0].update(image='foreign'),lambda b:b['containerDefinitions'][0]['environment'][2].update(value='{}')]
        for mutate in mutations:
            b=baseline();mutate(b)
            with self.subTest(mutate=mutate):self.assertRaises((ValueError,RuntimeError),c.render,b,NEW)
        self.assertRaises(ValueError,c.render,baseline(),c.OLD_IMAGE);self.assertRaises(ValueError,c.render,baseline(),NEW.replace('/oxy/mercaria@','/oxy/foreign@'))
    def test_actual_prepare_validate_binds_source_body_count_and_baseline_identity(self):
        td={'taskDefinition':baseline(),'tags':[{'key':'retained','value':'yes'}]};s=service();rows=[{'taskArn':'own-task','taskDefinitionArn':c.OLD_TD,'lastStatus':'RUNNING'}];identity={'imageUri':NEW,'sourceSha':'a'*40};config={'placeholder':'bound-by-reviewed-input-check'}
        with patch.object(c,'inputs_checked',return_value=identity),patch.object(c,'service',return_value=s),patch.object(c,'td',return_value=td),patch.object(c,'tasks',side_effect=lambda status:['own-task']if status=='RUNNING'else []),patch.object(c,'describe',return_value=rows),patch.object(c.m.f,'account',return_value='synthetic-operator'):
            p=c.prepare(config);c.validate(p)
            for mutate in [lambda p:p.update(operatorSha256='0'*64),lambda p:p['registration'].update(taskRoleArn='foreign'),lambda p:p['baselineTasks'].append('foreign')]:
                bad=copy.deepcopy(p);mutate(bad);self.assertRaises(ValueError,c.validate,bad)
            s['desiredCount']=2;self.assertRaises(ValueError,c.validate,p)
    def test_real_private_intents_one_registration_one_td_only_update_and_unknown_ack(self):
        for failure in [None,'register','update']:
            with self.subTest(failure=failure),tempfile.TemporaryDirectory(dir='/home/nate/Oxy/.agent-evidence')as d:
                body=c.render(baseline(),NEW);body['tags']=[];p={'registration':body,'baselineService':{'desiredCount':1}};out=Path(d)/'out';calls=[];arn=c.PREFIX+'62'
                def aws(*args,write=False):
                    calls.append((args,write))
                    if args[1]=='register-task-definition':
                        f=Path(args[3].removeprefix('file://'));self.assertEqual(stat.S_IMODE(f.stat().st_mode),0o600);self.assertEqual(json.loads(f.read_text()),body)
                        if failure=='register':raise c.UnknownAck('unknown')
                        return {'taskDefinition':{'taskDefinitionArn':arn}}
                    self.assertTrue((out/'update-intent.json').exists());self.assertNotIn('--desired-count',args)
                    if failure=='update':raise c.UnknownAck('unknown')
                    return {'service':{}}
                with patch.object(c,'validate'),patch.object(c,'aws',side_effect=aws),patch.object(c,'td',return_value={'taskDefinition':{**{k:v for k,v in body.items()if k!='tags'},'taskDefinitionArn':arn},'tags':[]}),patch.object(c,'monitor')as monitor:
                    if failure:self.assertRaises(c.UnknownAck,c.execute,p,out)
                    else:c.execute(p,out)
                    writes=[x for x in calls if x[1]];self.assertEqual(len(writes),1 if failure=='register'else 2)
                    if failure:
                        monitor.assert_not_called();f=json.loads((out/'failure.json').read_text());self.assertTrue(f['rootReconciliationRequired']);self.assertFalse(f['automaticMutationRetry']);self.assertFalse(f['automaticScaleZero']);self.assertEqual(f['baselineDefinition'],c.OLD_TD)
                    else:monitor.assert_called_once()
    def test_reviewed_readiness_routes_retired_targets_and_positive_binding(self):
        self.assertTrue(c.log_matches([{'message':json.dumps(c.POSITIVE)}]));self.assertRaises(ValueError,c.log_matches,[{'message':json.dumps({**c.POSITIVE,'cohortSha256':'foreign'})}])
        row=lambda ip,state:{'Target':{'Id':ip,'Port':3001},'TargetHealth':{'State':state}}
        self.assertTrue(c.target_ready([row('new','healthy')],{'new'},{'old'},3001));self.assertFalse(c.target_ready([row('new','initial')],{'new'},{'old'},3001));self.assertRaises(ValueError,c.target_ready,[row('foreign','healthy')],{'new'},{'old'},3001)

        observed=[]
        class Routes(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                observed.append(self.path);self.send_response(200 if self.path in ['/health','/health/ready']else 404);self.end_headers();self.wfile.write(b'{"status":"ok"}')
            def log_message(self,*args):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Routes);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();request=c.urllib.request.Request
        def local(url,*args,**kwargs):
            parsed=urllib.parse.urlsplit(url);self.assertEqual((parsed.scheme,parsed.netloc),('https','api.mercaria.co'))
            return request('http://127.0.0.1:'+str(server.server_port)+parsed.path,*args,**kwargs)
        try:
            with patch.object(c.urllib.request,'Request',side_effect=local):result=c.public_smoke()
            self.assertEqual(observed,['/health','/health/ready']);self.assertEqual([x['status']for x in result],[200,200])
        finally:server.shutdown();server.server_close();thread.join(timeout=5)

if __name__=='__main__':unittest.main()
