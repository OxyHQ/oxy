import unittest,importlib.util,json,hashlib,tempfile,time,copy,base64,subprocess
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).parent;spec=importlib.util.spec_from_file_location('baseline',P/'operation-ecs.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
LIVE=json.loads(Path('/home/nate/Oxy/.agent-evidence/i04-i09-runtime-693-alia449-20261004/readiness-plan.json').read_text())['live'];LIVE['image']=json.loads(m.CALLER_DEFINITION.read_text())['containerDefinitions'][0]['image']
def plan():
 root=m.EVIDENCE/'baseline-run';paths={'result':str(root/'result.private.json'),'receipt':str(root/'receipt.json'),'cleanup':str(root/'cleanup.json')}
 p={'schemaVersion':1,'profile':'caller','nonce':'a'*32,'preparedAt':int(time.time()),'baselineFiles':paths,'baselineHashes':{name:hashlib.sha256(Path(path).read_bytes()).hexdigest()for name,path in paths.items()},'definitionPath':str(m.CALLER_DEFINITION),'definitionFileSha256':m.CALLER_SHA,'decoderSha256':hashlib.sha256(m.DECODER.read_bytes()).hexdigest(),'launcherSha256':hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest(),'live':LIVE};p['taskDefinitionSha256']=m.digest(m.build_definition(p));return p
class T(unittest.TestCase):
 def test_shape(self):
  d=m.build_definition(plan());self.assertLess(len(json.dumps(d,separators=(',',':'))),60000);self.assertEqual(d['taskRoleArn'],'arn:aws:iam::237343248947:role/oxy-alia-task')
  a=copy.deepcopy(d);a.update(taskDefinitionArn='arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-alia-i09-inference-canary:1',status='ACTIVE');m.verify_registered(a,d)
  for k,v in [('taskRoleArn','foreign'),('containerDefinitions',[{**d['containerDefinitions'][0],'environmentFiles':[{}]}])]:
   b=copy.deepcopy(a);b[k]=v
   with self.assertRaises(RuntimeError):m.verify_registered(b,d)
 def registration(self):
  d=m.build_definition(plan());a=copy.deepcopy(d);a.update(taskDefinitionArn='arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-alia-i09-inference-canary:1',status='ACTIVE');return a,d
 def test_aws_reordered_named_inputs(self):
  a,d=self.registration();a['containerDefinitions'][0]['environment'].reverse();a['containerDefinitions'][0]['secrets'].reverse();m.verify_registered(a,d)
 def test_named_input_changed_value_rejected(self):
  for field,attr in [('environment','value'),('secrets','valueFrom')]:
   a,d=self.registration();a['containerDefinitions'][0][field]=[{'name':'foreign',attr:'changed'}]
   with self.assertRaises(RuntimeError):m.verify_registered(a,d)
 def test_duplicate_named_input_rejected(self):
  for field in ['environment','secrets']:
   a,d=self.registration();a['containerDefinitions'][0][field]=[{'name':'duplicate','value':'x'},{'name':'duplicate','value':'x'}]
   with self.assertRaisesRegex(RuntimeError,'Duplicate'):m.verify_registered(a,d)
 def test_baseline_tamper_rejected(self):
  p=plan();p['baselineHashes']['result']='0'*64
  with self.assertRaisesRegex(RuntimeError,'Baseline bytes'):m.build_definition(p)
 def test_post_generated_definition_and_binding(self):
  spec=importlib.util.spec_from_file_location('generator',P/'prepare-observation.py');gen=importlib.util.module_from_spec(spec);spec.loader.exec_module(gen)
  with tempfile.TemporaryDirectory()as raw:
   root=Path(raw);canary=root/'canary.json';canary.write_text(json.dumps({'ok':True,'clientRequestId':m.INTENT}))
   gen.prepare_post(root/'post',m.EVIDENCE/'operation-v3',m.EVIDENCE/'baseline-run/result.private.json',canary)
   p=plan();p['profile']='post';p['live']=json.loads((m.EVIDENCE/'readiness-plan.json').read_text())['live'];post=root/'post/post-plan.json';definition=root/'post/post-definition.json';p.update(postPlanPath=str(post),postPlanSha256=hashlib.sha256(post.read_bytes()).hexdigest(),definitionPath=str(definition),definitionFileSha256=hashlib.sha256(definition.read_bytes()).hexdigest());d=m.build_definition(p);self.assertNotIn('taskRoleArn',d);self.assertLess(len(json.dumps(d,separators=(',',':'))),60000)
   data=json.loads(post.read_text());data['intent']='foreign';post.write_text(json.dumps(data));p['postPlanSha256']=hashlib.sha256(post.read_bytes()).hexdigest()
   with self.assertRaisesRegex(RuntimeError,'Post input binding'):m.build_definition(p)
 def test_caller_decoder_exact_authority(self):
  m.ACTIVE_PHASE='caller';result={'clientRequestId':m.INTENT,'authority':{'appId':'6a2f851751b784a86fd0e934','ownerAccountId':'01a0369b-1222-712f-8df6-f8ffeb78ccc2','credentialId':'wl_d50a0056191d0448024900b4','environment':'production','signatureVerified':True,'lifetime':300},'ok':True,'firstHttpStatus':200,'retryHttpStatus':409,'retryAttempted':True,'requestId':'fixture','usage':[]}
  events=lambda:[{'message':'OXY_INTERNAL_PILOT_CANARY '+json.dumps(result)}]
  self.assertEqual(m.decode(events(),'nonce'),result)
  result['authority']['credentialId']='foreign'
  with self.assertRaises(RuntimeError):m.decode(events(),'nonce')
 def execute(self,failure=None):
  p=plan();d=m.build_definition(p);td='arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-alia-i09-inference-canary:1';task='arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/'+'b'*32;calls=[]
  def aws(*a):
   calls.append(a)
   if a[1]=='register-task-definition':
    if failure=='registration':raise RuntimeError('unknown')
    return {'taskDefinition':{**d,'taskDefinitionArn':td,'status':'ACTIVE'}}
   if a[1]=='describe-task-definition':return 'INACTIVE' if '--query'in a else {'taskDefinition':{**d,'taskDefinitionArn':td,'status':'ACTIVE'}}
   if a[1]=='run-task':
    self.assertTrue(a[3].startswith('file://'));self.assertTrue(Path(a[3][7:]).exists())
    if failure=='dispatch':raise RuntimeError('unknown')
    return {'tasks':[{'taskArn':task}]}
   if a[1]=='describe-tasks':return {'tasks':[{'taskDefinitionArn':td,'startedBy':'i09-caller-'+p['nonce'][:12],'lastStatus':'RUNNING' if failure=='stop' else 'STOPPED','containers':[{'exitCode':0,'imageDigest':LIVE['image'].split('@')[1]}]}]}
   if a[1]=='stop-task':raise RuntimeError('stop failed')
   if a[1]=='deregister-task-definition':return {}
   raise RuntimeError(str(a[:2]))
  with tempfile.TemporaryDirectory()as raw,patch.object(m,'aws',side_effect=aws),patch.object(m,'describe',return_value=LIVE),patch.object(m,'collect_result',return_value={'clientRequestId':m.INTENT}),patch.object(m.time,'monotonic',side_effect=[0,1000,1001]):
   out=Path(raw)/'run'
   if failure:
    with self.assertRaises(RuntimeError):m.execute(p,out)
   else:m.execute(p,out)
   cleanup=json.loads((out/'cleanup.json').read_text());self.assertLessEqual(sum(a[1]=='run-task'for a in calls),1)
   if failure=='registration':self.assertTrue(cleanup['registrationOutcomeUnknown'])
   else:self.assertTrue(cleanup['definitionInactive']);self.assertEqual(sum(a[1]=='deregister-task-definition'for a in calls),1)
   if failure=='dispatch':self.assertTrue(cleanup['dispatchOutcomeUnknown'])
   if failure=='stop':self.assertIn('task_cleanup_failed',cleanup['failures'])
 def test_success(self):self.execute()
 def test_registration_unknown(self):self.execute('registration')
 def test_dispatch_unknown(self):self.execute('dispatch')
 def test_stop_failure_still_deregisters(self):self.execute('stop')
 def test_aws_retry_boundary(self):
  expired=subprocess.TimeoutExpired('aws',90)
  with patch.object(m.subprocess,'run',side_effect=[expired,subprocess.CompletedProcess([],0,'{}','')])as run:self.assertEqual(m.aws('ecs','describe-tasks'),{});self.assertEqual(run.call_count,2)
  with patch.object(m.subprocess,'run',side_effect=expired)as run:
   with self.assertRaisesRegex(RuntimeError,'unknown'):m.aws('ecs','run-task')
   self.assertEqual(run.call_count,1)
 def test_error_scrub(self):
  with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','An error occurred (AccessDeniedException) token=SECRET https://private')):
   with self.assertRaises(RuntimeError)as error:m.aws('ecs','run-task')
   self.assertIn('AccessDeniedException',str(error.exception));self.assertNotIn('SECRET',str(error.exception));self.assertNotIn('https',str(error.exception))
if __name__=='__main__':unittest.main()
