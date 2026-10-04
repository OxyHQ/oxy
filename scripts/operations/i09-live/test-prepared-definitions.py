import importlib.util,json,tempfile,hashlib,base64,re,subprocess
from pathlib import Path
P=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prepare',P/'prepare-observation.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='i09-definitions-') as raw:
 root=Path(raw);m.prepare(root/'op');op=json.loads((root/'op/plan.json').read_text());b=json.loads((root/'op/baseline-definition.json').read_text());c=json.loads((root/'op/caller-definition.json').read_text())
 assert 'taskRoleArn' not in b and b['containerDefinitions'][0]['environment'][1]['value']=='https://kaana.ai'
 assert {x['name']for x in b['containerDefinitions'][0]['secrets']}=={'DATABASE_URL','KAANA_EDGE_SIGNING_PRIVATE_KEY'}
 assert c['taskRoleArn']=='arn:aws:iam::237343248947:role/oxy-alia-task' and not c['containerDefinitions'][0]['secrets']
 text=c['containerDefinitions'][0]['command'][-1];packed=json.loads(base64.b64decode(re.search(r"Buffer.from\('([A-Za-z0-9+/=]+)'",text)[1]))
 assert packed['sources']['pilot-canary.mjs']==(P/'pilot-canary.mjs').read_text()
 for name in packed:
  if isinstance(packed[name],dict) and name!='sources' and 'pilot-canary.mjs' in packed[name]: assert packed[name]['pilot-canary.mjs']==hashlib.sha256((P/'pilot-canary.mjs').read_bytes()).hexdigest()
 baseline={'kind':'i09-baseline-attestation-v1','intent':op['intent'],'observation':{}};canary={'clientRequestId':op['intent'],'ok':True};(root/'before.json').write_text(json.dumps(baseline));(root/'result.json').write_text(json.dumps(canary));m.prepare_post(root/'post',root/'op',root/'before.json',root/'result.json')
 p=json.loads((root/'post/post-definition.json').read_text());assert p['containerDefinitions'][0]['secrets']==b['containerDefinitions'][0]['secrets'] and 'taskRoleArn'not in p
 for definition in [b,c,p]: subprocess.run(['node','--input-type=module','--check'],input=definition['containerDefinitions'][0]['command'][-1],text=True,check=True,capture_output=True)
 canary['clientRequestId']='foreign';(root/'result.json').write_text(json.dumps(canary))
 try:m.prepare_post(root/'foreign',root/'op',root/'before.json',root/'result.json');raise RuntimeError('foreign accepted')
 except AssertionError:pass
 print('I09 3 generated entrypoints syntax PASS; minimal authority, unchanged factory, exact source hashes, wrong intent rejection PASS; no network/mutations')
