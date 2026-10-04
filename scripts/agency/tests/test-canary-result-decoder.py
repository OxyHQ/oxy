#!/usr/bin/env python3
import copy,importlib.util,json,sys,subprocess,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
path=ROOT/'scripts/agency/alia-revocation-canary-ecs.py'
spec=importlib.util.spec_from_file_location('canary_decoder',path);m=importlib.util.module_from_spec(spec)
legacy='--legacy' in sys.argv
if legacy:
 sys.argv.remove('--legacy');exec(compile(subprocess.check_output(['git','show','99a4145cca9637b306a5ed70a18db862a332a615:scripts/agency/alia-revocation-canary-ecs.py'],cwd=ROOT,text=True),str(path),'exec'),m.__dict__)
else:spec.loader.exec_module(m)
BASE=json.loads((Path(__file__).parent/'fixtures/canary-expiry-result.json').read_text())
PLAN={'nonce':BASE['nonce'],'operation':'execute','operator':{k:BASE['result'][k] for k in ['operatorArn','authorizationSha256']},'canaryPlan':{'credentialId':BASE['result']['credentialId'],'nonce':BASE['result']['nonce'],'expiresAt':'2026-10-04T06:35:22.742Z'},'live':{'logStreamPrefix':'oxy-api','logGroup':'/oxy/ecs'}}
def collect(row,duplicate=False):
 def aws(*args):
  return {'events':[] if '--next-token' in args else [{'message':m.PREFIX+json.dumps(row)}]*(2 if duplicate else 1),'nextForwardToken':'end'}
 with patch.object(m,'aws',side_effect=aws):return m.collect_result(PLAN,'arn:fixture/task')
class Decoder(unittest.TestCase):
 def test_complete_four_check_success(self):self.assertEqual(collect(BASE),BASE)
 def test_unknown_duplicate_missing_reordered_extra_checks(self):
  for edit in [lambda x:x['checks'].append({'kind':'unknown'}),lambda x:x['checks'].append(x['checks'][0]),lambda x:x['checks'].pop(1),lambda x:x['checks'].reverse(),lambda x:x['checks'][1].update(token='must-not-accept')]:
   row=copy.deepcopy(BASE);edit(row['result'])
   with self.assertRaises(RuntimeError):collect(row)
 def test_measurement_expiry_effect_or_authority_failures(self):
  for edit in [lambda x:x['checks'][1].update(marginMs=0),lambda x:x['checks'][1].update(credentialExpiresAtMillis=1791095722743),lambda x:x['checks'][1].update(measurementRemainingMillis=0),lambda x:x['checks'][2]['receivers'][0].update(observedAtMillis=1791092727000),lambda x:x['checks'][2]['receivers'][0].update(effectCount=2),lambda x:x['checks'][2]['receivers'][0].update(elapsedFromT0Ms=5000),lambda x:x['checks'][3].update(verified=False),lambda x:x.update(cleanupConfirmed=False)]:
   row=copy.deepcopy(BASE);edit(row['result'])
   with self.assertRaises(RuntimeError):collect(row)
 def test_foreign_result_and_duplicate_packet(self):
  for key,value in [('nonce','d'*32),('kind','foreign')]:
   row=copy.deepcopy(BASE);row[key]=value
   with self.assertRaises(RuntimeError):collect(row)
  with self.assertRaises(RuntimeError):collect(BASE,True)
 def test_unmeasured_failure_is_not_promoted_to_success(self):
  row=copy.deepcopy(BASE);row['result'].update(success=False,measured=False,primaryFailure='alia_canary_precondition_failed',checks=[{'kind':'existing_authority_unchanged','verified':True}]);self.assertEqual(collect(row),row)
if __name__=='__main__':unittest.main()
