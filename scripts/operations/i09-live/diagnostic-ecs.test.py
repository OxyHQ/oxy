import unittest,importlib.util,pathlib,base64,json,hashlib
P=pathlib.Path(__file__).with_name('diagnostic-ecs.py');s=importlib.util.spec_from_file_location('diag',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def packet(r):
 raw=json.dumps(r).encode();return {'message':'OXY_I09_RESULT '+json.dumps({'kind':r['kind'],'intent':r['intent'],'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()})}
def result():return {'kind':m.KIND,'intent':'oxy1519-i09-1791093169991-608bdb4f0ed0e8b0','requestId':'6c937204-26ae-4309-bba8-ef0ffdb9c07b','readOnly':True,'writerCalls':0,'inferenceCalls':0,'chronology':[{'stage':'sql_observation','passed':False,'code':'unclassified_error'}],'baselineCounts':{'metered':0,'attempts':0},'sql':None,'settledGuard':None,'feed':None}
class Decoder(unittest.TestCase):
 def test_valid_diagnostic_is_not_acceptance(self):self.assertEqual(m.decode([packet(result())],'unused')['sql'],None)
 def test_exact_identity_and_zero_writes(self):
  for key,val in [('kind','i09-final-exact-reconciliation-v1'),('intent','foreign'),('requestId','foreign'),('writerCalls',1),('inferenceCalls',1),('readOnly',False)]:
   r=result();r[key]=val
   with self.assertRaises(AssertionError):m.decode([packet(r)],'unused')
 def test_duplicate_or_failure_packet_rejected(self):
  p=packet(result())
  for events in [[p,p],[p,{'message':'OXY_I09_FAILURE {}'}]]:
   with self.assertRaises(AssertionError):m.decode(events,'unused')
 def test_digest_and_unknown_schema_rejected(self):
  r=result();r['unexpected']='private'
  with self.assertRaises(AssertionError):m.decode([packet(r)],'unused')
  p=packet(result());d=json.loads(p['message'].split(' ',1)[1]);d['sha256']='0'*64;p['message']='OXY_I09_RESULT '+json.dumps(d)
  with self.assertRaises(AssertionError):m.decode([p],'unused')
 def test_source_remains_original_transport(self):
  op=m.load_operation();self.assertEqual(op.PROFILES['post']['family'],m.FAMILY);self.assertEqual(hashlib.sha256((m.HERE/'operation-ecs.py').read_bytes()).hexdigest(),m.SOURCE_SHA)
if __name__=='__main__':unittest.main()
