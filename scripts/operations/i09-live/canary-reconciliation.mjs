import { createHash } from 'node:crypto';
const MODEL='openai/gpt-oss-120b@observed-2026-09-01';
export const DEPLOYMENTS=Object.freeze({dep_cerebras_gpt_oss_120b_observed_2026_09_01:'cerebras',dep_groq_openai_gpt_oss_120b_observed_2026_09_01:'groq',dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01:'openrouter'});
const requireValue=(value,code)=>{if(!value)throw new Error(code);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function attestExactDeployments(client){
 requireValue(client&&typeof client.attestDeployments==='function','canonical_kaana_binding_missing');
 const result=await client.attestDeployments(Object.keys(DEPLOYMENTS),{signal:AbortSignal.timeout(30000),scopedExecutionContractVersion:'3.6.0'});
 requireValue(result?.scopedExecutionContractVersion==='3.6.0'&&typeof result.snapshotId==='string'&&result.snapshotId.length>0,'attestation_contract_missing');
 requireValue(Array.isArray(result.deployments)&&result.deployments.length===3,'exact_deployments_missing');
 const ids=new Set();
 for(const row of result.deployments){requireValue(Object.hasOwn(DEPLOYMENTS,row.deploymentId)&&!ids.has(row.deploymentId)&&row.provider===DEPLOYMENTS[row.deploymentId]&&row.modelReference===MODEL,'deployment_identity_differs');ids.add(row.deploymentId);}
 // Absence remains unknown. The real edge decides current eligibility.
 return {kind:'i09-signed-deployment-attestation-v1',snapshotId:result.snapshotId,scopedExecutionContractVersion:result.scopedExecutionContractVersion,deployments:result.deployments.map(({deploymentId,provider,modelReference,regions,acceptedParameters,scopedExecution})=>({deploymentId,provider,modelReference,regions,...(acceptedParameters===undefined?{}:{acceptedParameters}),...(scopedExecution===undefined?{}:{scopedExecution})})),rawSha256:hash(result)};
}
export function requireSettledOperation(before,after,canary){
 requireValue(before.kind==='i09-exact-operation-observation-v1'&&after.kind===before.kind&&before.intent===after.intent&&after.intent===canary.clientRequestId&&before.applicationId===after.applicationId&&before.ownerAccountId===after.ownerAccountId,'observation_binding_differs');
 requireValue(before.readOnly===true&&after.readOnly===true&&before.isolation==='repeatable read'&&after.isolation==='repeatable read','observation_not_readonly');
 requireValue(before.metered.length===0&&before.attempts.length===0,'intent_previously_present');
 requireValue(canary.ok===true&&canary.firstHttpStatus===200&&canary.retryHttpStatus===409&&after.metered.length===1,'admission_not_confirmed');
 const row=after.metered[0];
 requireValue(row.request_id===canary.requestId&&row.application_id===after.applicationId&&row.account_id===after.ownerAccountId&&row.application_credential_id===canary.authority.credentialId&&row.environment==='production'&&row.delegated_user_id===null,'metered_authority_differs');
 requireValue(row.status==='settled'&&row.outcome==='completed'&&row.economic_treatment==='internal_metered'&&row.economic_relationship_id==='alia-kaana'&&row.economic_policy_version==='oxy-inference-economics/2026-10-03.3'&&row.usage_receipt_id===null,'metered_economics_differs');
 // Direct explicit-model claims persist only admitted_*; final_authorized_* is
 // appended by finalizeMeteredAuthorization for preclaimed Auto authorization.
 // This pilot is explicit-model only: requested/admitted/resolved must all agree.
 const approved=(deployment,provider,model)=>Object.hasOwn(DEPLOYMENTS,deployment)&&DEPLOYMENTS[deployment]===provider&&model===MODEL;
 const finalTuple=[row.final_authorized_deployment_id,row.final_authorized_provider,row.final_authorized_model_reference];
 const direct=finalTuple.every(value=>value===null);
 requireValue(direct||finalTuple.every(value=>typeof value==='string'&&value.length>0),'final_route_differs');
 const deployment=direct?row.admitted_deployment_id:row.final_authorized_deployment_id;
 const provider=direct?row.admitted_provider:row.final_authorized_provider;
 const model=direct?row.admitted_model_reference:row.final_authorized_model_reference;
 requireValue(row.requested_model_reference===MODEL&&row.resolved_model_reference===MODEL&&approved(row.admitted_deployment_id,row.admitted_provider,row.admitted_model_reference)&&approved(deployment,provider,model)&&row.serving_provider===provider&&row.serving_provider===canary.provider,'final_route_differs');
 requireValue(Array.isArray(canary.usage)&&canary.usage.length>0&&canary.usage.every(unit=>Object.hasOwn(row,unit.unit)&&String(row[unit.unit])===String(unit.quantity)),'metered_usage_differs');
 requireValue(JSON.stringify(before.money)===JSON.stringify(after.money),'owner_money_changed_requires_reconciliation');
 requireValue(after.attempts.length>0&&after.attempts.every(a=>a.request_id===row.request_id&&Object.hasOwn(DEPLOYMENTS,a.deployment_id)&&a.provider===DEPLOYMENTS[a.deployment_id]&&a.model_reference===MODEL)&&after.attempts.some(a=>a.served===true&&a.deployment_id===deployment&&a.provider===provider&&a.model_reference===model),'exact_attempts_missing_or_foreign');
 return row;
}
export async function readExactFeedEvents(reader,requestId,afterCursor){
 requireValue(reader&&typeof reader.readPage==='function'&&typeof requestId==='string'&&requestId.length>0,'invalid_feed_context');
 let cursor=afterCursor;const matching=[];const positions=new Set();let pages=0;
 for(;pages<20;pages++){
  const page=await reader.readPage(cursor,500);requireValue(Array.isArray(page.attempts)&&page.attempts.length<=500,'feed_page_bound');
  for(const event of page.attempts){if(event.requestId===requestId){requireValue(!positions.has(event.position),'duplicate_feed_position');positions.add(event.position);matching.push(event);requireValue(matching.length<=64,'attempt_bound_exceeded');}}
  if(page.caughtUp){requireValue(matching.length>0,'exact_request_not_in_bounded_feed');return {events:matching,pages:pages+1,caughtUp:true,lastCursor:page.next??cursor};}
  requireValue(typeof page.next==='string'&&page.next!==cursor,'feed_cursor_not_advancing');cursor=page.next;
 }
 throw new Error('feed_not_caught_up_within_bound');
}
export async function replayConfirmedEvents({events,observation,feedModule,readAfter}){
 requireValue(events.length>0&&events.length===observation.attempts.length,'feed_sql_attempt_set_differs');
 const indices=new Set();
 for(const event of events){const row=observation.attempts.find(r=>r.request_id===event.requestId&&r.attempt_index===event.attemptIndex);requireValue(row&&!indices.has(event.attemptIndex)&&row.facts_digest===feedModule.attemptFactsDigest(event),'feed_sql_facts_differ');indices.add(event.attemptIndex);}
 // Only already-stored, authenticated feed events reach the canonical idempotent writer.
 const result=await feedModule.ingestProviderCostAttempts(events);
 requireValue(result.inserted===0&&result.mismatches===0&&result.duplicates===events.length,'canonical_replay_not_duplicate_only');
 const after=await readAfter();requireValue(JSON.stringify(after.attempts)===JSON.stringify(observation.attempts)&&JSON.stringify(after.money)===JSON.stringify(observation.money)&&JSON.stringify(after.metered)===JSON.stringify(observation.metered),'replay_changed_exact_rows_or_money');
 return {kind:'i09-authenticated-feed-replay-v1',requestId:events[0].requestId,eventCount:events.length,...result,rowsUnchanged:true,moneyUnchanged:true,cursorBefore:observation.cursor,cursorAfter:after.cursor};
}
