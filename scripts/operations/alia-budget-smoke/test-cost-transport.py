import importlib.util,json,tempfile,unittest,hashlib,base64
from pathlib import Path
P=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('cost',P/'prepare-cost.py');cost=importlib.util.module_from_spec(spec);spec.loader.exec_module(cost)
spec=importlib.util.spec_from_file_location('dispatch',P/'dispatch.py');dispatch=importlib.util.module_from_spec(spec);spec.loader.exec_module(dispatch)
ORIGINAL=Path('/home/nate/Oxy/.agent-evidence/i04-alia-production-budget-smoke-20261004/caller-plan-2/plan.json')
class Tests(unittest.TestCase):
 def test_exact_original_intent_readonly_authority_payload_and_no_overwrite(self):
  before=ORIGINAL.read_bytes()
  with tempfile.TemporaryDirectory()as d:
   out=Path(d)/'cost';cost.build(ORIGINAL,out);p=json.loads((out/'plan.json').read_text());definition=json.loads((out/'definition.json').read_text());c=definition['containerDefinitions'][0]
   self.assertEqual(p['intent'],json.loads(before)['intent']);self.assertEqual(p['originalCallerPlanSha256'],hashlib.sha256(before).hexdigest());self.assertEqual(p['maxPostCount'],0);self.assertEqual(p['mode'],'inventory');self.assertNotIn('taskRoleArn',definition);self.assertEqual(len(c['secrets']),1);self.assertEqual(c['secrets'][0]['name'],'DATABASE_URL');self.assertEqual(c['environment'],[{'name':'NODE_ENV','value':'production'}]);self.assertLess(len(json.dumps(definition)),60000)
   with self.assertRaises(ValueError):cost.build(ORIGINAL,out)
  self.assertEqual(ORIGINAL.read_bytes(),before)
 def test_other_mode_and_malformed_intent_rejected_before_output(self):
  for change in [{'mode':'reconcile'},{'intent':'foreign'},{'maxPostCount':2}]:
   with tempfile.TemporaryDirectory()as d:
    p=Path(d)/'original.json';row=json.loads(ORIGINAL.read_text());row.update(change);p.write_text(json.dumps(row));out=Path(d)/'cost'
    with self.assertRaises(ValueError):cost.build(p,out)
    self.assertFalse(out.exists())
 def test_decoder_requires_original_nonce_and_digest(self):
  plan=json.loads(ORIGINAL.read_text());plan['mode']='inventory';raw=json.dumps({'kind':'alia-budget-smoke-cost-observation','ok':True,'observation':{'intent':plan['intent']}}).encode();packet={'nonce':plan['nonce'],'intent':plan['intent'],'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()}
  event=lambda:[{'message':'OXY_ALIA_BUDGET '+json.dumps(packet)}]
  self.assertTrue(dispatch.decode(event(),plan)['result']['ok']);packet['intent']='foreign'
  with self.assertRaises(RuntimeError):dispatch.decode(event(),plan)
if __name__=='__main__':unittest.main()
