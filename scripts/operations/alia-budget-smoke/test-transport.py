import importlib.util,json,tempfile,unittest,base64,hashlib
from pathlib import Path
P=Path(__file__).resolve().parent

def load(name):
 spec=importlib.util.spec_from_file_location(name,P/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
prep=load('prepare');dispatch=load('dispatch')
class Transport(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.p=Path(self.temp.name)
  self.binding={'kind':'alia-budget-smoke-accepted-runtime-v1','oxyDefinition':'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:999','aliaDefinition':'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-alia:452','image':'237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:'+'1'*64,'taskRoleArn':prep.ROLE,'budgetSource':'27ebf33872c4e3c6e72e97a728f157d42a8ffaf2','executionRoleArn':'arn:aws:iam::237343248947:role/oxy-api-execution','runtimePlatform':{'cpuArchitecture':'ARM64','operatingSystemFamily':'LINUX'},'network':{'awsvpcConfiguration':{'assignPublicIp':'DISABLED','subnets':['synthetic'],'securityGroups':['synthetic']}},'coreVersion':'4.3.0','contractsVersion':'4.9.1','sdkInferenceModuleSha256':'8'*64,'logGroup':'/oxy/ecs','logStreamPrefix':'oxy-api','cpu':'256','memory':'512'}
  self.inventory={'kind':'inference-pilot-readiness','profile':'oxy','readOnly':True,'isolation':'repeatable read','observedAt':'2026-10-04T17:00:00Z','tables':{k:{'status':'complete','count':0,'rows':[]}for k in ['inference_deployments','price_versions','price_version_unit_prices']}}
  (self.p/'binding.json').write_text(json.dumps(self.binding));(self.p/'inventory.json').write_text(json.dumps(self.inventory))
  prep.prepare(self.p/'binding.json',self.p/'inventory.json',self.p/'prepared')
  self.definition=json.loads((self.p/'prepared/definition.json').read_text());self.plan=json.loads((self.p/'prepared/plan.json').read_text())
 def tearDown(self):self.temp.cleanup()
 def test_inventory_has_only_db_secret_and_no_task_role(self):
  prep.prepare(self.p/'binding.json',None,self.p/'reader','inventory');d=json.loads((self.p/'reader/definition.json').read_text())
  dispatch.validate_definition(d,d);self.assertNotIn('taskRoleArn',d);self.assertEqual(d['family'],'oxy-alia-budget-smoke-readonly');self.assertEqual(d['containerDefinitions'][0]['secrets'],[{'name':'DATABASE_URL','valueFrom':'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL'}]);self.assertLess(len(json.dumps(d)),60000)
 def test_only_alia_role_and_no_secrets(self):
  dispatch.validate_definition(self.definition,self.definition);self.assertEqual(self.definition['taskRoleArn'],prep.ROLE);self.assertEqual(self.definition['containerDefinitions'][0]['secrets'],[]);self.assertLess(len(json.dumps(self.definition)),60000)
 def test_reordered_env_accepted(self):
  d=json.loads(json.dumps(self.definition));d['containerDefinitions'][0]['environment'].reverse();dispatch.validate_definition(d,self.definition)
 def test_changed_env_rejected(self):
  d=json.loads(json.dumps(self.definition));d['containerDefinitions'][0]['environment'][0]['value']='foreign'
  with self.assertRaises(RuntimeError):dispatch.validate_definition(d,self.definition)
 def test_duplicate_env_rejected(self):
  d=json.loads(json.dumps(self.definition));d['containerDefinitions'][0]['environment'].append(d['containerDefinitions'][0]['environment'][0])
  with self.assertRaises(RuntimeError):dispatch.validate_definition(d,self.definition)
 def test_db_secret_rejected(self):
  d=json.loads(json.dumps(self.definition));d['containerDefinitions'][0]['secrets']=[{'name':'DATABASE_URL','valueFrom':'foreign'}]
  with self.assertRaises(RuntimeError):dispatch.validate_definition(d,self.definition)
 def test_extra_sidecar_rejected(self):
  d=json.loads(json.dumps(self.definition));d['containerDefinitions'].append(d['containerDefinitions'][0])
  with self.assertRaises(RuntimeError):dispatch.validate_definition(d,self.definition)
 def test_wrong_role_or_sdk_rejected(self):
  for key in ['taskRoleArn','coreVersion','contractsVersion','budgetSource']:
   d=dict(self.binding);d[key]='wrong'
   with self.assertRaises(ValueError):prep.validate_binding(d)
 def test_reconcile_retains_original_key_and_snapshot(self):
  prep.prepare(self.p/'binding.json',self.p/'inventory.json',self.p/'reconcile','reconcile',self.p/'prepared/plan.json');r=json.loads((self.p/'reconcile/plan.json').read_text());self.assertEqual(r['intent'],self.plan['intent']);self.assertEqual(r['inventory'],self.plan['inventory']);self.assertEqual(r['maxPostCount'],0)
 def test_decoder_nonce_and_digest(self):
  raw=json.dumps({'kind':'alia-budget-smoke-result-v1','ok':True}).encode();packet={'nonce':self.plan['nonce'],'intent':self.plan['intent'],'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()};events=[{'message':'OXY_ALIA_BUDGET '+json.dumps(packet)}]
  self.assertTrue(dispatch.decode(events,self.plan)['result']['ok']);packet['nonce']='wrong'
  with self.assertRaises(RuntimeError):dispatch.decode([{'message':'OXY_ALIA_BUDGET '+json.dumps(packet)}],self.plan)
 def test_dispatch_unknown_never_retries_and_fences_definition(self):
  calls=[];td='arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-alia-production-budget-smoke:1';old=dispatch.aws;oldpre=dispatch.preflight
  def aws(*args):
   calls.append(args)
   if args[:2]==('ecs','register-task-definition'):return {'taskDefinition':{'taskDefinitionArn':td}}
   if args[:2]==('ecs','describe-task-definition'):
    if any(x[:2]==('ecs','deregister-task-definition')for x in calls):return {'taskDefinition':{'status':'INACTIVE'}}
    return {'taskDefinition':self.definition}
   if args[:2]==('ecs','run-task'):raise RuntimeError('aws_timeout_outcome_unknown')
   if args[:2]==('ecs','deregister-task-definition'):return {}
   raise AssertionError(args)
  dispatch.aws=aws;dispatch.preflight=lambda p:None
  try:
   with self.assertRaises(RuntimeError):dispatch.execute(self.p/'prepared/plan.json',self.p/'run')
   c=json.loads((self.p/'run/cleanup.json').read_text());self.assertTrue(c['dispatchOutcomeUnknown']);self.assertTrue(c['definitionInactive']);self.assertEqual(sum(a[:2]==('ecs','run-task')for a in calls),1)
   with self.assertRaises(FileExistsError):dispatch.execute(self.p/'prepared/plan.json',self.p/'run-again')
  finally:dispatch.aws=old;dispatch.preflight=oldpre
if __name__=='__main__':unittest.main()
