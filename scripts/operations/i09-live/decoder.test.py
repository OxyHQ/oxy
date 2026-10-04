import importlib.util,json,hashlib,base64
from pathlib import Path
p=Path(__file__).parent;s=importlib.util.spec_from_file_location('decoder',p/'decode-i09-result.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
intent='oxy1519-i09-1791093169991-608bdb4f0ed0e8b0';kind='i09-baseline-attestation-v1';value={'kind':kind,'intent':intent,'observation':{'intent':intent,'readOnly':True,'isolation':'repeatable read','metered':[],'attempts':[]},'registry':{'kind':'i09-signed-deployment-attestation-v1','deployments':[1,2,3]}}
raw=json.dumps(value).encode();packet={'kind':kind,'intent':intent,'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()};events=[{'message':'OXY_I09_RESULT '+json.dumps(packet)}];assert m.decode(events,intent,kind)==value
for changed in [events*2,events+[{'message':'OXY_I09_FAILURE x'}],[{'message':'OXY_I09_RESULT '+json.dumps({**packet,'sha256':'0'*64})}],[{'message':'OXY_I09_RESULT '+json.dumps({**packet,'intent':'foreign'})}]]:
 try:m.decode(changed,intent,kind);raise RuntimeError('mutation accepted')
 except AssertionError:pass
print('I09 original-log decoder 1 positive +4 negative controls PASS')
