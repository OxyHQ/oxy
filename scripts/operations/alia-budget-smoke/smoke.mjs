import { createHash } from 'node:crypto';
import { wire } from './wire-fixture.mjs';
import { inspectAliaCredential, verifyAliaCredential } from './verify-credential.mjs';
export const MODEL = 'openai/gpt-oss-120b@observed-2026-09-01';
export const ORIGIN = 'https://api.oxy.so';
export const DEPLOYMENTS = Object.freeze({
  dep_cerebras_gpt_oss_120b_observed_2026_09_01: 'cerebras',
  dep_groq_openai_gpt_oss_120b_observed_2026_09_01: 'groq',
  dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01: 'openrouter',
});
const requireValue = (ok, code) => { if (!ok) throw new Error(code); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export function requestFor(intent) {
  requireValue(/^oxy1579-alia-[0-9]{13}-[a-f0-9]{16}$/.test(intent), 'invalid_original_intent');
  // Exact real Alia builder fixture; only output bound and original key differ.
  return { ...structuredClone(wire), maxOutputTokens: 2048, clientRequestId: intent };
}
// Historical three-route review remains useful only to replay local controls.
// Production preparation supplies a separately reviewed, image/policy-bound set.
export const HISTORICAL_REVIEW = Object.freeze({
  policyVersion:'oxy-inference-economics/2026-10-04.1', maxQuotePicos:'20000000000',
  routes:Object.entries(DEPLOYMENTS).map(([deploymentId,provider])=>({deploymentId,provider,modelReference:MODEL,availabilityScope:'internal_alia',
    privacy:{retainsPayloads:provider==='groq',retentionDays:provider==='groq'?30:0,trainsOnCustomerData:false,zeroDataRetentionAvailable:true}})),
});
export function validateReview(review) {
  requireValue(review && typeof review.policyVersion==='string' && review.policyVersion.length>0
    && ['20000000000','50000000000'].includes(review.maxQuotePicos), 'invalid_route_review');
  const routes=review.routes;
  requireValue(Array.isArray(routes) && [3,4].includes(routes.length)
    && new Set(routes.map(r=>r.deploymentId)).size===routes.length,'review_route_set_differs');
  requireValue(Object.entries(DEPLOYMENTS).every(([id,provider])=>routes.some(r=>r.deploymentId===id
    && r.provider===provider && r.modelReference===MODEL)), 'historical_route_missing');
  for(const r of routes)requireValue(typeof r.deploymentId==='string' && /^[a-zA-Z0-9_-]+$/.test(r.deploymentId)
    && typeof r.modelReference==='string' && r.modelReference.includes('@') && typeof r.provider==='string'
    && typeof r.availabilityScope==='string' && ['internal_alia','platform_internal','public_payg'].includes(r.availabilityScope)
    && typeof r.privacy?.retainsPayloads==='boolean' && Number.isSafeInteger(r.privacy.retentionDays)
    && r.privacy.retentionDays>=0 && r.privacy.trainsOnCustomerData===false && r.privacy.zeroDataRetentionAvailable===true,
    'review_route_invalid');
  return review;
}
export function validatePilot(policy, review=HISTORICAL_REVIEW) {
  validateReview(review);
  requireValue(policy.INFERENCE_ECONOMIC_POLICY_VERSION===review.policyVersion,'policy_version_changed');
  const rows=policy.INTERNAL_METERED_RELATIONSHIPS.filter(r=>r.consumerApplicationId==='6a2f851751b784a86fd0e934');
  requireValue(rows.length===1,'relationship_ambiguous');const r=rows[0];
  requireValue(r.relationshipId==='alia-kaana' && r.lane==='service_token' && r.environments.length===1 && r.environments[0]==='production'
    && r.pilot?.maxControlledCompletionInputBudget===126976 && r.pilot.maxControlledInputBudget===8192
    && r.pilot.maxPricePerRequestUsd==='0.05' && r.pilot.maxOutputTokens===2048 && r.capacity.maxConcurrentRequests===32 && r.capacity.maxRequestsPerUtcDay===5000,'policy_bounds_changed');
  const allowed=r.pilot.deployments;
  requireValue(allowed.length===review.routes.length && new Set(allowed.map(x=>x.deploymentId)).size===allowed.length
    && allowed.every(x=>review.routes.some(r=>r.deploymentId===x.deploymentId && r.provider===x.provider && r.modelReference===x.modelReference)),'allowed_route_set_changed');
}
const PICO = 1000000000000n;
function decimal(value) {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(value), 'invalid_exact_price');
  const [whole,fraction=''] = value.split('.'); return BigInt(whole)*PICO+BigInt(fraction.padEnd(12,'0'));
}
function ceilDiv(a,b) { return (a+b-1n)/b; }
export function inspectInventory(inventory, now = Date.now, review=HISTORICAL_REVIEW) {
  validateReview(review);
  requireValue(inventory?.kind === 'inference-pilot-readiness' && inventory.profile === 'oxy'
    && inventory.readOnly === true && inventory.isolation === 'repeatable read', 'read_only_inventory_required');
  const age = now()-Date.parse(inventory.observedAt);
  requireValue(Number.isFinite(age) && age >= 0 && age <= 300000, 'stale_inventory');
  const table = name => { const row = inventory.tables?.[name]; requireValue(row?.status === 'complete'
    && row.count === row.rows?.length, 'incomplete_inventory'); return row.rows; };
  const prices = table('price_versions'), units = table('price_version_unit_prices');
  const rows = table('inference_deployments');
  requireValue(rows.length === review.routes.length && new Set(rows.map(r=>r.internal_route_id_digest)).size===rows.length, 'route_set_differs');
  const quotes = review.routes.map(({deploymentId,provider,modelReference,privacy,priceVersionId,availabilityScope}) => {
    const matches=rows.filter(r=>r.internal_route_id_digest===hash(deploymentId));
    requireValue(matches.length===1,'deployment_binding_differs'); const route=matches[0];
    requireValue(route.provider_slug===provider && route.status==='active' && route.permission_state==='approved'
      && route.legal_review_status==='approved' && route.availability_scope===availabilityScope
      && route.retains_payloads===privacy.retainsPayloads
      && route.retention_days===privacy.retentionDays && route.trains_on_customer_data===false
      && route.zero_data_retention_available===true && route.platform_fee_price_version_id===null,'route_not_reviewed');
    const matched=prices.filter(p=>p.id===route.price_version_id);
    requireValue(matched.length===1,'price_ambiguous');const price=matched[0];
    requireValue(price.status==='active' && price.currency==='USD' && price.provider===provider
      && price.model_reference===modelReference && (!priceVersionId || price.id===priceVersionId) && Date.parse(price.effective_from)<=now()
      && (price.effective_until===null || Date.parse(price.effective_until)>now()+190000),'price_not_current');
    // Conservative tariff estimate, not invoice or upstream retry cost. Price
    // all input partitions at the highest input rate; same for output/reasoning.
    const all=units.filter(u=>u.price_version_id===price.id);
    requireValue(all.length===5 && new Set(all.map(u=>u.unit)).size===5,'price_unit_set_differs');
    const rate = unit => { const u=all.find(u=>u.unit===unit); requireValue(u && /^[1-9][0-9]*$/.test(String(u.per)), 'price_unit_missing');
      return ceilDiv(decimal(u.amount),BigInt(u.per)); };
    const input=[rate('input_tokens'),rate('cached_input_tokens')].reduce((a,b)=>a>b?a:b);
    const output=[rate('output_tokens'),rate('reasoning_tokens')].reduce((a,b)=>a>b?a:b);
    const quote=input*32768n+output*2048n+rate('requests');
    requireValue(quote<=BigInt(review.maxQuotePicos),'quote_exceeds_reviewed_limit');
    return {deploymentId,provider,modelReference,priceVersionId:price.id,quotePicos:quote.toString(),currency:'USD',privacy:{retainsPayloads:route.retains_payloads,retentionDays:route.retention_days,trainsOnCustomerData:route.trains_on_customer_data,zeroDataRetentionAvailable:route.zero_data_retention_available}};
  });
  return {inventorySha256:hash(JSON.stringify(inventory)),observedAt:inventory.observedAt,
    inputCeiling:32768,outputCeiling:2048,maxQuotePicos:review.maxQuotePicos,quotes};
}
function bounded(promise, milliseconds) {
  let timer; return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),milliseconds);})])
    .finally(()=>clearTimeout(timer));
}
function safeRecord(record, completion, quote, review) {
  requireValue(record?.schemaVersion===2 && record.kind==='metered_usage' && record.applicationId==='6a2f851751b784a86fd0e934'
    && record.credentialId==='wl_d50a0056191d0448024900b4' && record.environment==='production'
    && record.delegatedUserId===undefined && record.economicTreatment==='internal_metered'
    && record.economicPolicyVersion===review.policyVersion
    && review.routes.some(r=>r.modelReference===record.resolvedModelReference && r.provider===record.servingProvider)
    && record.customerCharge?.status==='not_charged' && typeof record.requestId==='string'
    && (!completion || (completion.requestId===record.requestId && completion.model===record.resolvedModelReference && completion.servingProvider===record.servingProvider)), 'receipt_binding_differs');
  requireValue(record.tariff?.status==='quoted' && record.tariff.currency==='USD'
    && quote.quotes.some(q=>q.provider===record.servingProvider && q.modelReference===record.resolvedModelReference && q.priceVersionId===record.tariff.priceVersionId)
    && decimal(record.tariff.amount)<=BigInt(review.maxQuotePicos), 'receipt_tariff_differs');
  requireValue(Array.isArray(record.units) && record.units.every(u=>typeof u.unit==='string' && Number.isSafeInteger(u.quantity) && u.quantity>=0),'usage_invalid');
  return {schemaVersion:2,requestId:record.requestId,outcome:record.outcome,model:record.resolvedModelReference,
    provider:record.servingProvider,economicPolicyVersion:record.economicPolicyVersion,units:record.units,
    tariff:record.tariff,customerCharge:record.customerCharge};
}
export async function runSmoke({ credential, OxyInferenceClient, inventory, intent, fetchImpl=fetch, now=Date.now,
  emitIntent=()=>{}, checkpoint=()=>{}, mode='invoke', review=HISTORICAL_REVIEW }) {
  requireValue(mode==='invoke'||mode==='reconcile'||mode==='diagnostic','invalid_mode');
  if(mode==='diagnostic') {
    checkpoint('factory_mint');
    const token=await bounded(Promise.resolve().then(()=>credential()),15000);
    const authority=await inspectAliaCredential(token,fetchImpl,now,checkpoint);
    const age=now()-Date.parse(inventory?.observedAt);
    return {kind:'alia-budget-smoke-diagnostic',ok:true,intent,authority,
      invokeReady:authority.scopes.invoke&&authority.scopes.usageRead,
      priceSnapshotFresh:Number.isFinite(age)&&age>=0&&age<=300000,
      priceValidated:false,postCount:0,getCount:0,emitIntentSent:false};
  }
  checkpoint('price_snapshot');
  const request=requestFor(intent);const quote=inspectInventory(inventory,mode==='reconcile'?()=>Date.parse(inventory.observedAt):now,review);
  checkpoint('factory_mint');
  const token=await bounded(Promise.resolve().then(()=>credential()),15000);
  const authority=await verifyAliaCredential(token,fetchImpl,now,checkpoint);
  let postCount=0,getCount=0;
  const transport=async(url,options={})=>{
    const method=options.method??'GET';const target=new URL(url);
    requireValue(target.origin===ORIGIN && !target.search && !target.hash && !target.username && !target.password,'foreign_transport');
    if(method==='POST') {
      requireValue(mode==='invoke' && ++postCount===1 && target.pathname==='/v1/responses','repeat_or_foreign_post');
      inspectInventory(inventory,now,review); // Expiry after token/JWKS wait also fails before POST.
      requireValue(options.headers?.['Idempotency-Key']===intent && options.body===JSON.stringify(request),'request_changed');
      emitIntent({kind:'alia-budget-smoke-send',intent,bodySha256:hash(options.body),quote,authority});
    } else requireValue(method==='GET' && target.pathname==='/v1/generations/by-idempotency-key'
      && ++getCount===1 && options.headers?.['Idempotency-Key']===intent,'foreign_or_repeated_read');
    return fetchImpl(url,{...options,redirect:'error'});
  };
  const client=new OxyInferenceClient({baseURL:ORIGIN,credential:token,fetch:transport});
  let completion=null, firstStatus=null;
  if(mode==='invoke') {
    try {
      completion=await bounded(client.respond(request,{idempotencyKey:intent,signal:AbortSignal.timeout(180000)}),180000);
      requireValue(completion?.schemaVersion===1 && typeof completion.requestId==='string'
        && review.routes.some(r=>r.modelReference===completion.model && r.provider===completion.servingProvider),'completion_binding_differs'); firstStatus=200;
    } catch(error) { completion=null; firstStatus=Number.isSafeInteger(error?.status)?error.status:null; }
  }
  const base={kind:'alia-budget-smoke-result-v1',intent,mode,requestBodySha256:hash(JSON.stringify(request)),
    inputBytes:Buffer.byteLength(JSON.stringify(request.input)),requestBytes:Buffer.byteLength(JSON.stringify(request)),outputLimit:2048,postCount,getCount,firstHttpStatus:firstStatus,quote,authority};
  try {
    const raw=await bounded(client.getGenerationRecordByIdempotencyKey(intent,{signal:AbortSignal.timeout(15000)}),15000);
    const record=safeRecord(raw,completion,quote,review);
    const hasText=completion!==null && Array.isArray(completion.output) && completion.output.some(m=>Array.isArray(m.content) && m.content.some(c=>c.type==='text' && typeof c.text==='string' && c.text.trim().length>0));
    const hasToolCalls=completion!==null && Array.isArray(completion.output) && completion.output.some(m=>Array.isArray(m.toolCalls) && m.toolCalls.length>0);
    const realResponse=hasText && !hasToolCalls && completion.finishReason==='stop';
    return {...base,getCount,ok:realResponse&&record.outcome==='completed',record,
      outcome:realResponse?'response_and_usage_observed':'usage_reconciled_result_missing',
      finishReason:completion?.finishReason??null,hasText,hasToolCalls,toolsExecuted:0,
      answerSha256:completion?hash(JSON.stringify(completion.output)):null,
      providerCost:'not_asserted_requires_cost_feed',retryAttempted:false};
  } catch {
    return {...base,getCount,ok:false,outcome:'usage_unresolved_no_retry',retryAttempted:false,
      answerSha256:completion?hash(JSON.stringify(completion.output??[])):null};
  }
}
