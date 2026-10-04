import { createRequire } from 'node:module';
const require=createRequire(`${process.cwd()}/package.json`),postgres=require('postgres');
const APP='6a2f851751b784a86fd0e934',OWNER='01a0369b-1222-712f-8df6-f8ffeb78ccc2';
const UNITS='input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,requests,images,audio_input_milliseconds,audio_output_milliseconds,video_milliseconds,characters,embeddings,audio_input_tokens,cached_audio_input_tokens,audio_output_tokens,session_milliseconds';
export async function readCanaryObservation(databaseUrl,intent){
 if(!/^oxy1519-i09-[0-9]{13}-[a-f0-9]{16}$/.test(intent))throw new Error('invalid_exact_intent');
 const db=postgres(databaseUrl,{max:1,connect_timeout:10,idle_timeout:5,prepare:false});
 try{return await db.begin('isolation level repeatable read read only',async tx=>{
  await tx`SET LOCAL statement_timeout='10s'`;await tx`SET LOCAL lock_timeout='5s'`;
  const [settings]=await tx`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,transaction_timestamp()::text AS observed_at`;
  if(settings.readonly!=='on'||settings.isolation!=='repeatable read')throw new Error('readonly_required');
  const [app]=await tx`SELECT id,owner_account_id,status,type FROM applications WHERE id=${APP}`;
  if(!app||app.owner_account_id!==OWNER||app.status!=='active'||app.type!=='internal')throw new Error('caller_context_changed');
  const metered=await tx.unsafe(`SELECT request_id,idempotency_key,account_id,application_id,application_credential_id,delegated_user_id,environment,economic_treatment,economic_policy_version,economic_relationship_id,requested_model_reference,admitted_model_reference,admitted_provider,admitted_deployment_id,final_authorized_model_reference,final_authorized_provider,final_authorized_deployment_id,status,outcome,usage_source,resolved_model_reference,serving_provider,settled_price_version_id,tariff_status,tariff_amount::text,tariff_currency,usage_receipt_id,created_at,settled_at,${UNITS} FROM inference_metered_usage WHERE application_id=$1 AND right(idempotency_key,length($2)+1)=(':'||$2) ORDER BY request_id LIMIT 3`,[APP,intent]);
  if(metered.length>1||metered.some(row=>row.account_id!==OWNER||row.environment!=='production'))throw new Error('ambiguous_or_foreign_operation');
  const requestId=metered[0]?.request_id;
  const attempts=requestId===undefined?[]:await tx.unsafe(`SELECT request_id,attempt_index,provider,key_class,deployment_id,model_reference,cost_source,cost_amount::text,cost_currency,rate_card_version_id,cost_complete,served,occurred_at,units_measured,${UNITS},outcome,failure_code,latency_ms,feed_position,facts_digest,ingested_at FROM inference_provider_cost_attempts WHERE request_id=$1 ORDER BY attempt_index LIMIT 65`,[requestId]);
  if(attempts.length>64)throw new Error('attempt_bound_exceeded');
  const money={};
  for(const table of ['account_balances','billing_ledger_entries','usage_reservations','usage_receipts']){
   const [summary]=await tx.unsafe(`SELECT count(*)::text AS count,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS sha256 FROM public.${table} t WHERE account_id=$1`,[OWNER]);money[table]=summary;
  }
  const cursor=await tx`SELECT feed,cursor,updated_at FROM inference_provider_cost_feed_cursors WHERE feed='kaana-provider-attempts'`;
  if(cursor.length>1)throw new Error('ambiguous_feed_cursor');
  return {kind:'i09-exact-operation-observation-v1',intent,readOnly:true,isolation:settings.isolation,observedAt:settings.observed_at,applicationId:APP,ownerAccountId:OWNER,metered,attempts,money,cursor:cursor[0]??null};
 });}finally{await db.end({timeout:5});}
}
