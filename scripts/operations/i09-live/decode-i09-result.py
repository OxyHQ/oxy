#!/usr/bin/env python3
"""Decode only the already-collected original task logs. No AWS calls/retries."""
import argparse,base64,hashlib,json,os,re
from pathlib import Path
def decode(events,intent,kind):
 assert re.fullmatch(r'oxy1519-i09-[0-9]{13}-[a-f0-9]{16}',intent)
 assert kind in ['i09-baseline-attestation-v1','i09-final-exact-reconciliation-v1']
 packets=[json.loads(e['message'][len('OXY_I09_RESULT '):])for e in events if e['message'].startswith('OXY_I09_RESULT ')]
 assert len(packets)==1 and not any(e['message'].startswith('OXY_I09_FAILURE ')for e in events)
 p=packets[0];assert set(p)=={'kind','intent','sha256','data'} and p['kind']==kind and p['intent']==intent
 assert isinstance(p['data'],str) and len(p['data'])<=140000
 raw=base64.b64decode(p['data'],validate=True);assert len(raw)<=100000 and hashlib.sha256(raw).hexdigest()==p['sha256']
 result=json.loads(raw);assert result['kind']==kind and result['intent']==intent
 if kind=='i09-baseline-attestation-v1':
  assert set(result)=={'kind','intent','observation','registry'} and result['observation']['readOnly'] is True and result['observation']['isolation']=='repeatable read' and result['observation']['intent']==intent and result['observation']['metered']==[] and result['observation']['attempts']==[]
  assert result['registry']['kind']=='i09-signed-deployment-attestation-v1' and len(result['registry']['deployments'])==3
 else:
  assert set(result)=={'kind','intent','canary','observation','feed','replay'} and result['canary']['ok'] is True and result['canary']['clientRequestId']==intent
  assert result['replay']['inserted']==0 and result['replay']['mismatches']==0 and result['replay']['duplicates']==result['feed']['eventCount']>0 and result['replay']['rowsUnchanged'] is True and result['replay']['moneyUnchanged'] is True
 return result
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--events',required=True);a.add_argument('--intent',required=True);a.add_argument('--kind',required=True);a.add_argument('--output',required=True);v=a.parse_args();events=json.loads(Path(v.events).read_text());result=decode(events['events'],v.intent,v.kind)
 with open(v.output,'x')as f:os.chmod(v.output,0o600);json.dump(result,f,indent=2);f.write('\n')
 print(json.dumps({'decoded':True,'kind':v.kind,'intent':v.intent,'sha256':hashlib.sha256(Path(v.output).read_bytes()).hexdigest()}))
