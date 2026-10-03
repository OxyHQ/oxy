/** Real password/session/service authority and SQL over the same final schema. */
import assert from 'node:assert/strict';
import {seedPreserved} from './seed-preserved.mjs';
import {capabilities} from './capability-probe.mjs';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
const require = createRequire(resolve('packages/api/package.json'));
const [mode, manifestPath] = process.argv.slice(2);
assert(['seed','probe','cold'].includes(mode) && manifestPath && process.argv.length === 4);
const { connectPostgres, closePostgres, getDb } = require('./src/config/postgres.ts');
const { users } = require('./src/db/schema/users.ts');
const { accountMembers } = require('./src/db/schema/accountMembers.ts');
const { applications } = require('./src/db/schema/applications.ts');
const { applicationCredentials } = require('./src/db/schema/applicationCredentials.ts');
const { userAuthMethods } = require('./src/db/schema/userAuthMethods.ts');
const { eq } = require('drizzle-orm');
await connectPostgres();
try {
 if (mode === 'seed') {
  const suffix = randomBytes(6).toString('hex');
  const [person] = await getDb().insert(users).values({kind:'personal',username:`rollback${suffix}`,email:`rollback${suffix}@fixture.invalid`}).returning({id:users.id,username:users.username});
  const [org] = await getDb().insert(users).values({kind:'organization',username:`rollbackorg${suffix}`}).returning({id:users.id});
  await getDb().insert(accountMembers).values({accountId:org.id,memberUserId:person.id,role:'admin',status:'active'});
  const password='Rollback-Fixture-Password-1519!';
  await require('./src/services/password.service.ts').storePassword(person.id,password);
  const [app] = await getDb().insert(applications).values({name:`Rollback${suffix}`,ownerAccountId:person.id,createdByUserId:person.id,type:'internal',isOfficial:true,isInternal:true,status:'active',scopes:['user:read','capability-tickets:issue','capabilities:read','catalogs:write'],capabilities:['agency:coordinate','catalog:oxy'],redirectUris:['http://127.0.0.1:17974/callback']}).returning({id:applications.id});
  const {applicationWorkloadIdentities}=require('./src/db/schema/applicationWorkloadIdentities.ts');
  await getDb().insert(applicationWorkloadIdentities).values({applicationId:app.id,provider:'aws-iam',subject:'rollback-owned-workload',scopes:['user:read']});
  const service = require('./src/utils/credentialMaterial.ts').generateCredentialMaterial();
  await getDb().insert(applicationCredentials).values({applicationId:app.id,name:'owned rollback service',publicKey:service.publicKey,secretHash:service.secretHash,type:'service',environment:'development',status:'active',scopes:['user:read','capability-tickets:issue','capabilities:read','catalogs:write']});
  const clientId='oxy_dk_'+randomBytes(24).toString('hex');
  await getDb().insert(applicationCredentials).values({applicationId:app.id,name:'owned rollback public',publicKey:clientId,type:'public',environment:'development',status:'active',scopes:['user:read']});
  const privateKey=randomBytes(32).toString('hex');
  const {deriveSecp256k1PublicKey}=require('@oxy.so/protocol/secp256k1');
  const signer=require('./src/services/signature.service.ts').default;
  const publicKey=signer.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey));
  const [bot]=await getDb().insert(users).values({kind:'bot',username:`rollbackbot${suffix}`}).returning({id:users.id});
  const [key]=await getDb().insert(userAuthMethods).values({userId:bot.id,type:'agent_key',methodPublicKey:publicKey,label:'rollback fixture',enrollmentMethod:'governor'}).returning({id:userAuthMethods.id});
  const preservedTables=await seedPreserved(require,getDb,person);
  writeFileSync(manifestPath,JSON.stringify({person,org,password,service,app,clientId,bot,key,publicKey,privateKey,preservedTables}),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({seeded:true,realPasswordHash:true,syntheticOnly:true}));
 } else {
  const f=JSON.parse(readFileSync(manifestPath,'utf8')); const observations=[];
  async function http(port,path,body,token) {
   const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':path==='/auth/oauth/token'?'application/x-www-form-urlencoded':'application/json',origin:'http://127.0.0.1:17974',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:path==='/auth/oauth/token'?new URLSearchParams(body).toString():JSON.stringify(body)})});
   const data=await response.json(); return {status:response.status,data};
  }
  async function ok(port,path,body,token) { const r=await http(port,path,body,token); assert.equal(r.status,200,`${port}${path}: ${r.status}`);return r.data; }
  const old=17974, current=17975;
  if(mode==='cold') {
   const state=JSON.parse(readFileSync(manifestPath+'.stop.private.json','utf8'));
   assert.equal((await http(old,'/users/me',undefined,state.agentToken)).status,401);
   assert.equal((await http(current,'/users/me',undefined,state.agentToken)).status,401);
   for(const port of [old,current]) {
    const ordinary=await ok(port,'/users/me',undefined,state.ordinaryToken);
    assert.equal((ordinary.data??ordinary).id ?? (ordinary.data??ordinary)._id,f.person.id);
   }
   console.log(JSON.stringify({case:'old restarted after canonical stop',agentDeniedBoth:true,ordinarySessionPreservedBoth:true}));
   process.exitCode=0;
   await closePostgres();
  } else {
  const login=await ok(old,'/auth/signin/password',{identifier:f.person.username,password:f.password});
  const session=login.session ?? login;
  assert(session.accessToken);
  const me=await ok(old,'/users/me',undefined,session.accessToken);
  assert.equal((me.data??me).id ?? (me.data??me)._id,f.person.id);
  observations.push({case:'old real password and users/me',passed:true});
  const deviceId=login.deviceId ?? session.deviceId, deviceSecret=login.deviceSecret ?? session.deviceSecret;
  assert(deviceId && deviceSecret,'password response includes holder proof');
  const second=await ok(old,'/auth/signin/password',{identifier:f.person.username,password:f.password,device:{deviceId,deviceSecret}});
  const holder2=second.deviceSecret ?? second.session?.deviceSecret;
  assert(holder2 && holder2!==deviceSecret);
  await ok(old,`/accounts/${f.org.id}/switch`,{},session.accessToken);
  for (const secret of [deviceSecret,holder2]) {
   const minted=await ok(old,'/session/device/token',{deviceId,deviceSecret:secret});
   assert.equal(minted.data.state.activeAccountId,f.org.id);
   const profile=await ok(old,'/users/me',undefined,minted.data.accessToken);
   assert.equal((profile.data??profile).id ?? (profile.data??profile)._id,f.org.id);
  }
  await ok(old,'/session/device/signout',{accountId:f.org.id},session.accessToken);
  for (const secret of [deviceSecret,holder2]) {
   const minted=await ok(old,'/session/device/token',{deviceId,deviceSecret:secret});assert.equal(minted.data.state.activeAccountId,f.person.id);
  }
  await ok(old,'/session/device/signout',{all:true},session.accessToken);
  for (const secret of [deviceSecret,holder2]) assert.equal((await http(old,'/session/device/token',{deviceId,deviceSecret:secret})).status,401);
  observations.push({case:'old two holders switch/org signout/personal fallback/final signout',passed:true});
  for (const port of [old,current]) {
   const minted=await ok(port,'/auth/service-token',{apiKey:f.service.publicKey,apiSecret:f.service.secret});
   const payload=JSON.parse(Buffer.from(minted.data.token.split('.')[1],'base64url').toString());assert.equal(payload.exp-payload.iat,300);
   observations.push({case:'service token TTL',port,seconds:300});
  }
  for(const port of [old,current]) {
   const challenge=await ok(port,'/auth/service-token/workload/challenge',{});
   const body={provider:'aws-iam',nonce:challenge.data.nonce,attestation:{answersNonce:challenge.data.nonce,subject:'rollback-owned-workload'}};
   const minted=await ok(port,'/auth/service-token/workload',body);
   const claims=JSON.parse(Buffer.from(minted.data.token.split('.')[1],'base64url').toString());
   assert.equal(claims.exp-claims.iat,300);assert.equal(claims.appId,f.app.id);assert(claims.credentialId.startsWith('wl_'));
   assert.equal((await http(port,'/auth/service-token/workload',body)).status,401);
   observations.push({case:'workload HTTP/SQL mint with synthetic attestation and real Redis',port,seconds:300,replayDenied:true});
  }
  const challenge=await ok(current,'/auth/agent/challenge',{publicKey:f.publicKey});
  const timestamp=Date.now();
  const {buildAgentProofMessage}=require('@oxy.so/contracts');
  const signature=require('./src/services/signature.service.ts').default.signMessage(buildAgentProofMessage(challenge,timestamp),f.privateKey);
  const agent=await ok(current,'/auth/agent/verify',{publicKey:f.publicKey,challenge:challenge.challenge,timestamp,signature});
  await ok(current,'/users/me',undefined,agent.accessToken);
  const oldBefore=await http(old,'/users/me',undefined,agent.accessToken);
  const foregroundPerson=await ok(current,'/auth/signin/password',{identifier:f.person.username,password:f.password});
  const checkRevokedCapability=await capabilities(require,http,f,(foregroundPerson.session??foregroundPerson).accessToken,agent.accessToken,observations);
  const verifier=randomBytes(32).toString('base64url');
  const codeOptions={userId:f.bot.id,appId:f.app.id,redirectUri:'http://127.0.0.1:17974/callback',codeChallenge:createHash('sha256').update(verifier).digest('base64url'),scopes:['user:read'],authMethod:{authMethodId:f.key.id,authMethodOwnerId:f.bot.id}};
  const issue=require('./src/services/oauthCode.service.ts').issueAuthCode;
  const codes=[await issue(codeOptions),await issue(codeOptions),await issue(codeOptions)];
  await getDb().update(userAuthMethods).set({revokedAt:new Date()}).where(eq(userAuthMethods.id,f.key.id));
  await checkRevokedCapability();
  const currentAfter=await http(current,'/users/me',undefined,agent.accessToken);
  const oldAfter=await http(old,'/users/me',undefined,agent.accessToken);
  assert.equal(currentAfter.status,401);
  observations.push({case:'new agent session live then revoked key',oldBefore:oldBefore.status,currentAfter:currentAfter.status,oldAfter:oldAfter.status,stopNewLaneRequired:oldAfter.status===200});
  const exchangeBody=(code)=>({grant_type:'authorization_code',client_id:f.clientId,code:code.code,redirect_uri:codeOptions.redirectUri,code_verifier:verifier});
  const currentCode=await http(current,'/auth/oauth/token',exchangeBody(codes[0]));
  const oldCode=await http(old,'/auth/oauth/token',exchangeBody(codes[1]));
  assert.equal(currentCode.status,400);assert.equal(currentCode.data.error,'invalid_grant');
  const {authCodes}=require('./src/db/schema/authCodes.ts');
  const codeHash=createHash('sha256').update(codes[2].code).digest('hex');
  await getDb().update(authCodes).set({expiresAt:new Date(0)}).where(eq(authCodes.codeHash,codeHash));
  const expiredCode=await http(old,'/auth/oauth/token',exchangeBody(codes[2]));
  assert.equal(expiredCode.status,400);assert.equal(expiredCode.data.error,'invalid_grant');
  const [retainedCode]=await getDb().select().from(authCodes).where(eq(authCodes.codeHash,codeHash));assert.equal(retainedCode.authMethodId,f.key.id);
  observations.push({case:'agent code after key revocation and explicit expiry',currentCode:currentCode.status,oldCode:oldCode.status,oldExpiredCode:expiredCode.status,rowRetained:true});
  const {sessions}=require('./src/db/schema/sessions.ts');
  assert.equal(oldCode.status,200);
  const exchangedClaims=JSON.parse(Buffer.from(oldCode.data.access_token.split('.')[1],'base64url').toString());
  const [oldMintedRow]=await getDb().select().from(sessions).where(eq(sessions.sessionId,exchangedClaims.sid));
  assert(oldMintedRow);assert.equal(oldMintedRow.userId,f.bot.id);
  observations.push({case:'old code exchange session provenance',authMethodRetained:oldMintedRow.authMethodId!==null,oldProfile:(await http(old,'/users/me',undefined,oldCode.data.access_token)).status,finalProfile:(await http(current,'/users/me',undefined,oldCode.data.access_token)).status});

  const [stored]=await getDb().select().from(sessions).where(eq(sessions.sessionId,agent.sessionId));
  assert.equal(stored.authMethodId,f.key.id);
  assert.equal(await require('./src/services/session.service.ts').default.deactivateSession(agent.sessionId),true);
  const stoppedCurrent=await http(current,'/users/me',undefined,agent.accessToken);
  const stoppedOld=await http(old,'/users/me',undefined,agent.accessToken);
  const [retained]=await getDb().select().from(sessions).where(eq(sessions.sessionId,agent.sessionId));
  assert(retained && retained.authMethodId===f.key.id && !retained.isActive);
  assert.equal(stoppedCurrent.status,401);
  const ordinary=await ok(current,'/auth/signin/password',{identifier:f.person.username,password:f.password});
  writeFileSync(manifestPath+'.stop.private.json',JSON.stringify({agentToken:agent.accessToken,ordinaryToken:(ordinary.session??ordinary).accessToken}),{mode:0o600,flag:'wx'});
  observations.push({case:'canonical final deactivateSession preserves provenance; warmed-old result recorded',oldAfter:stoppedOld.status,currentAfter:stoppedCurrent.status,rowRetained:true});
  writeFileSync(manifestPath+'.observations.json',JSON.stringify({observations,limits:['No WEB04 concurrency guarantee claimed for old source.','Agent acceptance on old source records a stop requirement, not compatibility.','Financial/provider/requester census added separately.']},null,2));
  console.log(JSON.stringify({observations}));
  }
 }
} finally {await require('./src/config/redis.ts').closeRedis();await closePostgres();}
