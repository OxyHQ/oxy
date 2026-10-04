import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {generateKeyPairSync,sign} from 'node:crypto';
import {runSmoke,inspectInventory,requestFor,MODEL,DEPLOYMENTS,hash,HISTORICAL_REVIEW,validatePilot} from './smoke.mjs';
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
   assert.equal(JSON.parse(options.body).input.length,2);assert.equal(JSON.parse(options.body).tools.length,21);assert.equal(JSON.parse(options.body).maxOutputTokens,2048);assert.equal(JSON.parse(options.body).routingProfile,'auto');
   if(post==='unknown')throw new Error('transport-lost-secret-'+token);
   if(post==='refused')return response({code:'context_length_exceeded',message:'context',retryable:false,requestId:'original-request'},400);
   return response({schemaVersion:1,requestId:'original-request',model:record.resolvedModelReference,servingProvider:record.servingProvider,finishReason:'stop',output:[{role:'assistant',content:[{type:'text',text:'OK'}]}]});
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

test('historical compiled policy requires new explicit cap and preserves exact three-route set',async()=>{
 const {validatePilot}=await import('./smoke.mjs');
 const policy=require('/home/nate/Oxy/oxy/.worktrees/alia-production-input-budget-20261004/packages/api/dist/config/inferenceEconomicPolicy.js');
 const withCap={...policy,INTERNAL_METERED_RELATIONSHIPS:structuredClone(policy.INTERNAL_METERED_RELATIONSHIPS)};withCap.INTERNAL_METERED_RELATIONSHIPS[0].pilot.maxPricePerRequestUsd='0.05';validatePilot(withCap);assert.throws(()=>validatePilot(policy));
 const changed={...policy,INTERNAL_METERED_RELATIONSHIPS:structuredClone(policy.INTERNAL_METERED_RELATIONSHIPS)};changed.INTERNAL_METERED_RELATIONSHIPS[0].pilot.deployments.push({deploymentId:'foreign',modelReference:MODEL,provider:'groq'});
 assert.throws(()=>validatePilot(changed));
});
test('actual Oxy normalization confirms canonical Hello exceeds old cap and fits preflight ceiling',()=>{
 const api='/home/nate/Oxy/oxy/.worktrees/alia-production-input-budget-20261004/packages/api/dist/';
 const {normalizeResponsesRequest,responsesRequestSchema}=require(api+'schemas/inferenceEdge.schemas.js');
 const {controlledInputBudget}=require(api+'services/inferenceInternalPilot.js');
 const request=requestFor(intent);const budget=controlledInputBudget(normalizeResponsesRequest(responsesRequestSchema.parse(request)));
 assert.equal(budget,29027);assert.ok(budget<32768);assert.equal(request.routingProfile,'auto');assert.equal(request.maxOutputTokens,2048);
});

test('reviewed Groq30-day retention is reported separately from ZDR availability',()=>{const result=inspectInventory(fixture().inventory,now);assert.deepEqual(result.quotes.find(q=>q.provider==='groq').privacy,{retainsPayloads:true,retentionDays:30,trainsOnCustomerData:false,zeroDataRetentionAvailable:true});});

test('diagnostic verifies signed exact authority, reports missing usage, no SDK construction or API request',async()=>{
 const f=fixture({claims:{scopes:['inference:invoke']}});const stages=[];
 const r=await runSmoke({...f.args,mode:'diagnostic',checkpoint:x=>stages.push(x),OxyInferenceClient:class{constructor(){throw new Error('SDK must not construct')}}});
 assert.equal(r.authority.signatureVerified,true);assert.deepEqual(r.authority.scopes,{invoke:true,usageRead:false});assert.equal(r.invokeReady,false);assert.equal(r.postCount,0);assert.equal(r.getCount,0);assert.equal(r.emitIntentSent,false);assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);assert.deepEqual(stages,['factory_mint','credential_shape','jwks','signature','authority']);assert.ok(!JSON.stringify(r).includes(f.token));
});
test('diagnostic permits stale price observation only because no response or generation read can occur',async()=>{
 const f=fixture();f.inventory.observedAt=new Date(now()-600000).toISOString();const r=await runSmoke({...f.args,mode:'diagnostic'});assert.equal(r.priceSnapshotFresh,false);assert.equal(r.priceValidated,false);assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});
for(const claims of [{ownerAccountId:'foreign'},{credentialId:'foreign'},{exp:now()/1000-1}])test('diagnostic still refuses foreign or expired signed identity '+JSON.stringify(claims),async()=>{const f=fixture({claims});await assert.rejects(runSmoke({...f.args,mode:'diagnostic'}));assert.equal(f.calls.length,0);});

// This fourth deployment is synthetic fixture data, never a production candidate.
function highFixture() {
 const f=fixture(); const review=structuredClone(HISTORICAL_REVIEW);
 review.policyVersion='synthetic-reviewed-high-v1';
 const high={deploymentId:'synthetic_high_deployment',provider:'synthetic-provider',modelReference:'synthetic/high@v1',priceVersionId:'synthetic-high-price',availabilityScope:'platform_internal',privacy:{retainsPayloads:false,retentionDays:0,trainsOnCustomerData:false,zeroDataRetentionAvailable:true}};
 review.routes.push(high); const t=f.inventory.tables;
 t.inference_deployments.rows.push({...t.inference_deployments.rows[0],internal_route_id_digest:hash(high.deploymentId),provider_slug:high.provider,availability_scope:high.availabilityScope,price_version_id:high.priceVersionId});t.inference_deployments.count++;
 t.price_versions.rows.push({...t.price_versions.rows[0],id:high.priceVersionId,provider:high.provider,model_reference:high.modelReference});t.price_versions.count++;
 t.price_version_unit_prices.rows.push(...structuredClone(t.price_version_unit_prices.rows.slice(0,5)).map(x=>({...x,price_version_id:high.priceVersionId})));t.price_version_unit_prices.count+=5;
 Object.assign(f.record,{economicPolicyVersion:review.policyVersion,resolvedModelReference:high.modelReference,servingProvider:high.provider});f.record.tariff.priceVersionId=high.priceVersionId;
 f.args.review=review;return {...f,review,high};
}
test('synthetic fourth high route works through published SDK without replacing Auto or tools',async()=>{const f=highFixture();const r=await runSmoke(f.args);assert.equal(r.ok,true);assert.equal(r.outputLimit,2048);assert.equal(r.record.model,f.high.modelReference);assert.equal(r.quote.quotes.length,4);assert.deepEqual(f.calls.map(c=>c.options.method),['POST','GET']);const request=JSON.parse(f.calls[0].options.body);assert.equal(request.routingProfile,'auto');assert.equal(request.model,undefined);assert.equal(request.tools.length,21);});
for(const [name,mutate]of [
 ['foreign model',f=>f.inventory.tables.price_versions.rows.at(-1).model_reference='foreign@v1'],
 ['price revision',f=>f.review.routes.at(-1).priceVersionId='different'],
 ['retention drift',f=>f.inventory.tables.inference_deployments.rows.at(-1).retention_days=1],
 ['training drift',f=>f.inventory.tables.inference_deployments.rows.at(-1).trains_on_customer_data=true],
 ['foreign route',f=>f.inventory.tables.inference_deployments.rows.at(-1).internal_route_id_digest=hash('foreign')],
 ['extra route',f=>f.review.routes.push({...f.high,deploymentId:'extra'})],
])test('high review rejects '+name+' before POST',async()=>{const f=highFixture();mutate(f);await assert.rejects(runSmoke(f.args));assert.equal(f.calls.length,0);});
test('policy exact four tuples and version are required',()=>{const f=highFixture();const original=require('/home/nate/Oxy/oxy/.worktrees/alia-production-input-budget-20261004/packages/api/dist/config/inferenceEconomicPolicy.js');const policy={...original,INFERENCE_ECONOMIC_POLICY_VERSION:f.review.policyVersion,INTERNAL_METERED_RELATIONSHIPS:structuredClone(original.INTERNAL_METERED_RELATIONSHIPS)};policy.INTERNAL_METERED_RELATIONSHIPS[0].pilot.maxPricePerRequestUsd='0.05';policy.INTERNAL_METERED_RELATIONSHIPS[0].pilot.deployments.push({deploymentId:f.high.deploymentId,provider:f.high.provider,modelReference:f.high.modelReference});validatePilot(policy,f.review);policy.INTERNAL_METERED_RELATIONSHIPS[0].pilot.deployments.at(-1).modelReference='foreign@v1';assert.throws(()=>validatePilot(policy,f.review));});
test('exact quote boundary includes all 2048 reasoning/output tokens without double charging',()=>{const f=highFixture();const units=f.inventory.tables.price_version_unit_prices.rows.filter(x=>x.price_version_id===f.high.priceVersionId);for(const u of units){u.amount='0';u.per='1';}units.find(x=>x.unit==='requests').amount='0.02';assert.equal(inspectInventory(f.inventory,now,f.review).quotes.at(-1).quotePicos,'20000000000');units.find(x=>x.unit==='reasoning_tokens').amount='0.000000000001';assert.throws(()=>inspectInventory(f.inventory,now,f.review));f.review.maxQuotePicos='50000000000';assert.equal(inspectInventory(f.inventory,now,f.review).quotes.at(-1).quotePicos,'20000002048');});
for(const responseKind of ['empty','length','tool_calls'])test('high '+responseKind+' remains failed despite completed receipt',async()=>{const f=highFixture();const fetch=f.args.fetchImpl;f.args.fetchImpl=async(url,options)=>{const r=await fetch(url,options);if(options?.method!=='POST')return r;const body=await r.json();if(responseKind==='empty')body.output=[];else body.finishReason=responseKind;return response(body);};const r=await runSmoke(f.args);assert.equal(r.ok,false);assert.equal(r.retryAttempted,false);assert.equal(f.calls.length,2);});

test('high text with stop and a tool call is incomplete despite a completed matching receipt',async()=>{
 const f=highFixture();const fetch=f.args.fetchImpl;
 f.args.fetchImpl=async(url,options)=>{
  const r=await fetch(url,options);if(options?.method!=='POST')return r;
  const body=await r.json();
  body.output[0].toolCalls=[{id:'synthetic-call',name:'synthetic_tool',arguments:'{}'}];
  return response(body);
 };
 const r=await runSmoke(f.args);
 assert.equal(r.hasText,true);assert.equal(r.finishReason,'stop');assert.equal(r.hasToolCalls,true);
 assert.equal(r.record.outcome,'completed');assert.equal(r.ok,false);
 assert.equal(r.outcome,'usage_reconciled_result_missing');assert.equal(r.toolsExecuted,0);
 assert.equal(r.retryAttempted,false);assert.match(r.answerSha256,/^[a-f0-9]{64}$/);
 assert.equal(f.sent.length,1);assert.deepEqual(f.calls.map(c=>c.options.method),['POST','GET']);
});

test('reviewed high scope drift blocks before POST and old routes remain exact internal_alia',async()=>{const f=highFixture();f.inventory.tables.inference_deployments.rows.at(-1).availability_scope='internal_alia';await assert.rejects(runSmoke(f.args));assert.equal(f.calls.length,0);const g=highFixture();g.inventory.tables.inference_deployments.rows[0].availability_scope='platform_internal';await assert.rejects(runSmoke(g.args));assert.equal(g.calls.length,0);});
test('pilot USD .05 cap is explicit, independently of compiled module hash',()=>{const f=highFixture();const old=require('/home/nate/Oxy/oxy/.worktrees/alia-production-input-budget-20261004/packages/api/dist/config/inferenceEconomicPolicy.js');const policy={...old,INFERENCE_ECONOMIC_POLICY_VERSION:f.review.policyVersion,INTERNAL_METERED_RELATIONSHIPS:structuredClone(old.INTERNAL_METERED_RELATIONSHIPS)};const pilot=policy.INTERNAL_METERED_RELATIONSHIPS[0].pilot;pilot.deployments.push({deploymentId:f.high.deploymentId,provider:f.high.provider,modelReference:f.high.modelReference});for(const cap of [undefined,'0.5','0.050','0.02']){pilot.maxPricePerRequestUsd=cap;assert.throws(()=>validatePilot(policy,f.review));}pilot.maxPricePerRequestUsd='0.05';validatePilot(policy,f.review);});
