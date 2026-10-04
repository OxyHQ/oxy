import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {generateKeyPairSync,sign} from 'node:crypto';
import {runSmoke,inspectInventory,requestFor,MODEL,DEPLOYMENTS,hash} from './smoke.mjs';
const require=createRequire('/home/nate/Oxy/Mention/.worktrees/jev-receipt-recovery-20261004/packages/backend/package.json');
const {OxyInferenceClient}=require('@oxy.so/core/inference');
const now=()=>1791140000000;
const intent='oxy1579-alia-1791140000000-1234567890abcdef';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function fixture({claims={},post='success',receipt='success'}={}) {
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const key={...publicKey.export({format:'jwk'}),kid:'test',alg:'EdDSA',use:'sig'};
 const claim={type:'service',iss:'oxy-auth',aud:'oxy-api',appId:'6a2f851751b784a86fd0e934',ownerAccountId:'01a0369b-1222-712f-8df6-f8ffeb78ccc2',credentialId:'wl_d50a0056191d0448024900b4',environment:'production',scopes:['inference:invoke','inference:usage:read'],iat:now()/1000,exp:now()/1000+300,...claims};
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const signing=encode({alg:'EdDSA',typ:'JWT',kid:'test'})+'.'+encode(claim);
 const token=signing+'.'+sign(null,Buffer.from(signing),privateKey).toString('base64url');
 const table=rows=>({status:'complete',count:rows.length,rows});
 const inventory={kind:'inference-pilot-readiness',profile:'oxy',readOnly:true,isolation:'repeatable read',observedAt:new Date(now()).toISOString(),tables:{
  inference_deployments:table(Object.entries(DEPLOYMENTS).map(([id,provider])=>({internal_route_id_digest:hash(id),provider_slug:provider,status:'active',permission_state:'approved',legal_review_status:'approved',availability_scope:'internal_alia',retains_payloads:provider==='groq',retention_days:provider==='groq'?30:0,trains_on_customer_data:false,zero_data_retention_available:true,price_version_id:'price-'+provider,platform_fee_price_version_id:null}))),
  price_versions:table(Object.values(DEPLOYMENTS).map(provider=>({id:'price-'+provider,status:'active',currency:'USD',provider,model_reference:MODEL,effective_from:new Date(now()-1000).toISOString(),effective_until:null}))),
  price_version_unit_prices:table(Object.values(DEPLOYMENTS).flatMap(provider=>['input_tokens','cached_input_tokens','output_tokens','reasoning_tokens','requests'].map(unit=>({price_version_id:'price-'+provider,unit,amount:unit==='requests'?'0':'0.35',per:unit==='requests'?'1':'1000000'}))))
 }};
 const record={schemaVersion:2,kind:'metered_usage',applicationId:claim.appId,credentialId:claim.credentialId,environment:'production',economicTreatment:'internal_metered',economicPolicyVersion:'oxy-inference-economics/2026-10-04.1',requestId:'original-request',resolvedModelReference:MODEL,servingProvider:'groq',outcome:'completed',customerCharge:{status:'not_charged'},tariff:{status:'quoted',amount:'0.001',currency:'USD',priceVersionId:'price-groq'},units:[{unit:'output_tokens',quantity:2}]};
 const calls=[];const sent=[];
 return {token,inventory,record,calls,sent,args:{credential:async()=>token,OxyInferenceClient,inventory,intent,now,emitIntent:x=>sent.push(x),fetchImpl:async(url,options)=>{
  if(url.endsWith('jwks.json'))return response({keys:[key]});
  calls.push({url,options});assert.equal(options.redirect,'error');assert.equal(options.headers['X-Oxy-User-Id'],undefined);
  if(options.method==='POST') {
   assert.equal(JSON.parse(options.body).input.length,2);assert.equal(JSON.parse(options.body).tools.length,21);assert.equal(JSON.parse(options.body).maxOutputTokens,128);assert.equal(JSON.parse(options.body).routingProfile,'auto');
   if(post==='unknown')throw new Error('transport-lost-secret-'+token);
   if(post==='refused')return response({code:'context_length_exceeded',message:'context',retryable:false,requestId:'original-request'},400);
   return response({schemaVersion:1,requestId:'original-request',model:MODEL,servingProvider:'groq',finishReason:'stop',output:[{role:'assistant',content:[{type:'text',text:'OK'}]}]});
  }
  if(receipt==='missing')return response({code:'not_found',message:'missing',retryable:false,requestId:'lookup'},404);
  return response({data:record});
 }}};
}
test('published SDK sends exactly one synthetic POST then original-key GET, no credential/answer logged',async()=>{
 const f=fixture();const r=await runSmoke(f.args);assert.equal(r.ok,true);assert.ok(r.requestBytes>27000);assert.ok(r.requestBytes<32768);
 assert.deepEqual(f.calls.map(c=>c.options.method),['POST','GET']);assert.equal(f.sent.length,1);
 assert.ok(f.calls.every(c=>c.options.headers['Idempotency-Key']===intent));
 assert.ok(!JSON.stringify(r).includes(f.token));assert.ok(!JSON.stringify(r).includes('"text":"OK"'));
});
for(const post of ['unknown','refused'])test(post+' never repeats POST; settled record does not restore missing answer',async()=>{
 const f=fixture({post});const r=await runSmoke(f.args);assert.equal(r.ok,false);assert.equal(r.outcome,'usage_reconciled_result_missing');assert.deepEqual(f.calls.map(c=>c.options.method),['POST','GET']);
});
test('404 remains unknown, not zero cost and not retry permission',async()=>{const f=fixture({post:'unknown',receipt:'missing'});const r=await runSmoke(f.args);assert.equal(r.outcome,'usage_unresolved_no_retry');assert.equal(r.retryAttempted,false);assert.equal(f.calls.length,2);});
test('separate reconcile mode makes only original-key GET',async()=>{const f=fixture();const r=await runSmoke({...f.args,mode:'reconcile'});assert.equal(r.postCount,0);assert.deepEqual(f.calls.map(c=>c.options.method),['GET']);assert.equal(r.outcome,'usage_reconciled_result_missing');});
for(const [name,claims]of [['wrong owner',{ownerAccountId:'foreign'}],['wrong app',{appId:'foreign'}],['wrong credential',{credentialId:'foreign'}],['wrong environment',{environment:'test'}],['missing usage scope',{scopes:['inference:invoke']}],['insufficient TTL',{iat:now()/1000-120,exp:now()/1000+180}]])test(name+' refuses before any request',async()=>{const f=fixture({claims});await assert.rejects(runSmoke(f.args));assert.equal(f.calls.length,0);});
for(const [name,mutate]of [
 ['stale',x=>x.observedAt=new Date(now()-300001).toISOString()],
 ['partial',x=>x.tables.price_versions.status='missing'],
 ['foreign deployment',x=>x.tables.inference_deployments.rows[0].internal_route_id_digest=hash('foreign')],
 ['unreviewed',x=>x.tables.inference_deployments.rows[0].legal_review_status='pending'],
 ['Cerebras retention changed',x=>x.tables.inference_deployments.rows[0].retains_payloads=true],
 ['Groq retention days changed',x=>x.tables.inference_deployments.rows[1].retention_days=31],
 ['Groq privacy snapshot changed',x=>x.tables.inference_deployments.rows[1].retains_payloads=false],
 ['OpenRouter retention days changed',x=>x.tables.inference_deployments.rows[2].retention_days=30],
 ['expired price',x=>x.tables.price_versions.rows[0].effective_until=new Date(now()+1000).toISOString()],
 ['expensive',x=>x.tables.price_version_unit_prices.rows[0].amount='10'],
 ['duplicate unit',x=>x.tables.price_version_unit_prices.rows[0].unit='output_tokens'],
])test(name+' inventory blocks POST',async()=>{const f=fixture();mutate(f.inventory);await assert.rejects(runSmoke(f.args));assert.equal(f.calls.length,0);});
test('JWT wait crossing inventory deadline prevents late POST',async()=>{const f=fixture();let clock=now();f.args.credential=async()=>{clock+=301000;return f.token;};await assert.rejects(runSmoke({...f.args,now:()=>clock}));assert.equal(f.calls.length,0);});
test('foreign receipt is rejected even after a successful response',async()=>{const f=fixture();f.record.credentialId='foreign';const r=await runSmoke(f.args);assert.equal(r.ok,false);assert.equal(r.outcome,'usage_unresolved_no_retry');});
test('payload is deterministic and request intent format is closed',()=>{assert.equal(requestFor(intent).input.length,2);assert.equal(requestFor(intent).tools.length,21);assert.throws(()=>requestFor('old-key'));assert.equal(inspectInventory(fixture().inventory,now).quotes.length,3);});

test('actual compiled accepted policy preserves exact three-route execution set for auto',async()=>{
 const {validatePilot}=await import('./smoke.mjs');
 const policy=require('/home/nate/Oxy/oxy/.worktrees/alia-production-input-budget-20261004/packages/api/dist/config/inferenceEconomicPolicy.js');
 validatePilot(policy);
 const changed={...policy,INTERNAL_METERED_RELATIONSHIPS:structuredClone(policy.INTERNAL_METERED_RELATIONSHIPS)};changed.INTERNAL_METERED_RELATIONSHIPS[0].pilot.deployments.push({deploymentId:'foreign',modelReference:MODEL,provider:'groq'});
 assert.throws(()=>validatePilot(changed));
});
test('actual Oxy normalization confirms canonical Hello exceeds old cap and fits preflight ceiling',()=>{
 const api='/home/nate/Oxy/oxy/.worktrees/alia-production-input-budget-20261004/packages/api/dist/';
 const {normalizeResponsesRequest,responsesRequestSchema}=require(api+'schemas/inferenceEdge.schemas.js');
 const {controlledInputBudget}=require(api+'services/inferenceInternalPilot.js');
 const request=requestFor(intent);const budget=controlledInputBudget(normalizeResponsesRequest(responsesRequestSchema.parse(request)));
 assert.equal(budget,29027);assert.ok(budget<32768);assert.equal(request.routingProfile,'auto');assert.equal(request.maxOutputTokens,128);
});

test('reviewed Groq30-day retention is reported separately from ZDR availability',()=>{const result=inspectInventory(fixture().inventory,now);assert.deepEqual(result.quotes.find(q=>q.provider==='groq').privacy,{retainsPayloads:true,retentionDays:30,trainsOnCustomerData:false,zeroDataRetentionAvailable:true});});
