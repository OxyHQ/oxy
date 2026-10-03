/** Bounded operational canary. No real provider/inference effect; the sink is loopback.
 * External launcher binds this file and compiled API image, authenticates AWS and
 * durably records task/credential intent before execute. No public endpoint added.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const BASE_URL = 'https://api.oxy.so';
function modules(apiPackage) {
  const require = createRequire(apiPackage);
  const root = dirname(apiPackage);
  return {
    db: require(join(root,'dist/config/postgres.js')),
    canary: require(join(root,'dist/services/aliaRevocationCanary.service.js')),
    material: require(join(root,'dist/utils/credentialMaterial.js')),
    schema: require(join(root,'dist/db/schema/applicationCredentials.js')).applicationCredentials,
    orm: require('drizzle-orm'),
  };
}
export async function prepareCanary({apiPackage,principalId,operator}) {
  const m=modules(apiPackage);
  try { await m.db.connectPostgres(); return await m.canary.prepareAliaRevocationCanary(principalId,operator); }
  finally { await m.db.closePostgres(); }
}
export function createCanaryWorker() {
  const child=fork(join(dirname(fileURLToPath(import.meta.url)),'alia-revocation-canary-receiver.mjs'),[],
    {execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>
      ['PATH','HOME','LANG','LC_ALL','NODE_ENV','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_CONTAINER_CREDENTIALS_FULL_URI',
       'AWS_CONTAINER_AUTHORIZATION_TOKEN'].includes(key)))});
  const pending=new Map(); let closed=false;
  child.on('message',m=>{ const waiter=pending.get(m.id); if(waiter){pending.delete(m.id);clearTimeout(waiter.timer);waiter.resolve(m.result);} });
  const rejectAll=()=>{closed=true; for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('receiver_unavailable'));} pending.clear();};
  child.on('exit',rejectAll);child.on('error',rejectAll);
  return {child,
    command(command,input){if(closed)return Promise.reject(new Error('receiver_unavailable'));return new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('receiver_timeout'));},15000);
      pending.set(id,{resolve,reject,timer});child.send({id,command,input},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(new Error('receiver_send_failed'));}});
    });},
    async stop(){try{if(!closed)await this.command('close');}finally{
      if(!closed){child.kill('SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,3000))]);}
      if(!closed){child.kill('SIGKILL');await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,3000))]);}
      if(!closed)throw new Error('receiver_cleanup_unconfirmed');
    }},
  };
}
async function mintBearer(material,plan) {
  const response=await fetch(new URL('/auth/service-token',BASE_URL),{method:'POST',redirect:'error',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:material.publicKey,apiSecret:material.secret}),signal:AbortSignal.timeout(5000)});
  const body=await response.json(),data=body.data??body;
  if(response.status!==200||typeof data.token!=='string'||!Number.isSafeInteger(data.expiresIn)||data.expiresIn<1||data.expiresIn>300)throw new Error('service_mint_failed');
  const claims=JSON.parse(Buffer.from(data.token.split('.')[1],'base64url').toString('utf8'));
  if(claims.appId!==plan.applicationId||claims.credentialId!==plan.credentialId||claims.ownerAccountId!==plan.ownerAccountId
    ||claims.environment!=='production'||claims.exp-claims.iat>300||claims.exp<=claims.iat
    ||!Array.isArray(claims.scopes)||claims.scopes.length!==2||!['acting-as:offline','inference:invoke'].every(s=>claims.scopes.includes(s)))throw new Error('service_mint_context_mismatch');
  return data.token;
}
/** Every returned field is safe metadata; bearer/material never enters a receipt. */
export async function executeCanary({apiPackage,plan,operator,signal}) {
  const m=modules(apiPackage),material=m.material.generateCredentialMaterial();
  const workers=[];let issued=false,primaryFailure=null,cleanupFailure=null;const checks=[];
  const stopIfAborted=()=>{if(signal?.aborted)throw new Error('canary_interrupted');};
  const safe={kind:'alia-credential-revocation-canary-result-v1',credentialId:plan.credentialId,nonce:plan.nonce,
    operatorArn:operator.operatorArn,authorizationSha256:operator.authorizationSha256,checks,measured:false,cleanupConfirmed:false};
  try {
    stopIfAborted();await m.db.connectPostgres();stopIfAborted();
    // Set before the await: uncertain commit must still reconcile/retire by exact ID.
    issued=true;await m.canary.issueAliaRevocationCanary(plan,m.material.credentialVerifier(material),operator);
    stopIfAborted();const bearer=await mintBearer(material,plan);stopIfAborted();
    for(let i=0;i<2;i++)workers.push(createCanaryWorker());
    const warm=await Promise.all(workers.map(worker=>worker.command('init',{apiPackage,baseURL:BASE_URL,principalId:plan.principalId,bearer})));
    if(warm.some(x=>x.outcome!=='ALLOW'||x.effectCount!==1||x.coreVersion!=='4.2.0'||x.cachePrewarmed!==true))throw new Error('canary_initial_allow_failed');
    if(warm[0].verifierCredentialId!==warm[1].verifierCredentialId||warm[0].verifierCredentialId===plan.credentialId)throw new Error('canary_verifier_mismatch');
    checks.push({kind:'two_independent_receivers',coreVersion:'4.2.0',cachePrewarmed:true,verifierCredentialId:warm[0].verifierCredentialId,
      verifierSameApplication:true,effectsPerReceiverBefore:1});
    stopIfAborted();const t0=performance.now();
    await m.canary.revokeAliaRevocationCanary(plan,m.material.credentialVerifier(material),operator);
    const t1=performance.now();
    const [row]=await m.db.getDb().select({status:m.schema.status}).from(m.schema).where(m.orm.eq(m.schema.id,plan.credentialId));
    if(row?.status!=='revoked')throw new Error('canary_retirement_readback_failed');
    stopIfAborted();
    const denied=await Promise.all(workers.map(async(worker,index)=>{
      const result=await worker.command('probe');return{index,...result,elapsedFromT0Ms:performance.now()-t0};
    }));
    if(denied.some(x=>x.outcome!=='DENY'||x.effectCount!==1||x.elapsedFromT0Ms>=5000))throw new Error('canary_authoritative_denial_failed');
    checks.push({kind:'canonical_credential_revocation',commitFromT0Ms:t1-t0,receivers:denied});safe.measured=true;
  } catch (error) {
    const known = new Set(['canary_interrupted','alia_canary_precondition_failed','service_mint_failed','service_mint_context_mismatch',
      'canary_initial_allow_failed','canary_verifier_mismatch','canary_retirement_readback_failed','canary_authoritative_denial_failed',
      'receiver_unavailable','receiver_timeout','receiver_send_failed']);
    primaryFailure = known.has(error?.message) ? error.message : 'canary_failed';
  }
  finally {
    for(const worker of workers){try{await worker.stop();}catch{cleanupFailure='receiver_cleanup_unconfirmed';}}
    if(issued){try{
      const row=await m.canary.inspectAliaRevocationCanary(plan,m.material.credentialVerifier(material),operator);
      if(row.exists&&row.status!=='revoked')await m.canary.revokeAliaRevocationCanary(plan,m.material.credentialVerifier(material),operator);
      const after=await m.canary.inspectAliaRevocationCanary(plan,m.material.credentialVerifier(material),operator);
      if(after.exists&&after.status!=='revoked')throw new Error('cleanup');
      safe.cleanupConfirmed=true;
      try {
        const unchanged=await m.canary.verifyAliaCanaryAuthorityUnchanged(plan,operator);
        checks.push({kind:'existing_authority_unchanged',verified:unchanged});
        if(!unchanged)primaryFailure??='authority_drift';
      } catch { primaryFailure??='authority_readback_failed'; }
    }catch{cleanupFailure='credential_cleanup_unconfirmed';}}
    else safe.cleanupConfirmed=true;
    material.secret='';await m.db.closePostgres();
  }
  return {...safe,success:safe.measured&&safe.cleanupConfirmed&&!primaryFailure&&!cleanupFailure,primaryFailure,cleanupFailure};
}

/** Recovery requires only the durable prior plan. Material stays inside the canonical API service. */
export async function recoverCanary({apiPackage,plan,operator}) {
  const m=modules(apiPackage);
  try {
    await m.db.connectPostgres();
    const result=await m.canary.retireAliaCanaryAfterTaskFailure(plan,operator);
    let authorityUnchanged=false;
    try {authorityUnchanged=await m.canary.verifyAliaCanaryAuthorityUnchanged(plan,operator);} catch {}
    return {kind:'alia-credential-revocation-canary-recovery-v1',credentialId:result.credentialId ?? plan.credentialId,
      nonce:plan.nonce,cleanupConfirmed:result.retired || !result.exists,authorityUnchanged};
  } finally {await m.db.closePostgres();}
}
