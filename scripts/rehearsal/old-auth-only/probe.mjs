/** Actual cold HTTP + SQL paths, JWTs and compiled old service; synthetic accounts only. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {installIoGuard} from './io-guard.mjs';
const [manifestPath]=process.argv.slice(2);
assert(manifestPath && process.argv.length===3);
const require=createRequire(resolve('packages/api/package.json'));
installIoGuard(require,manifestPath+'.probe.external.json');
const f=JSON.parse(readFileSync(manifestPath,'utf8'));
const {connectPostgres,getDb,closePostgres}=require('./dist/config/postgres.js');
const {eq}=require('drizzle-orm');
const {sessions}=require('./dist/db/schema/sessions.js');
const {users}=require('./dist/db/schema/users.js');
const {accountMembers}=require('./dist/db/schema/accountMembers.js');
const service=require('./dist/services/session.service.js').default;
await connectPostgres();
const checks=[];
async function http(path,body,token,extra={}) {
 const response=await fetch('http://127.0.0.1:18002'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:18002',...(token?{authorization:'Bearer '+token}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal(response.headers.get('set-cookie'),null);
 return {status:response.status,data:await response.json()};
}
async function ok(path,body,token) {const r=await http(path,body,token);assert.equal(r.status,200,path+':'+r.status);return r.data;}
function record(label) {checks.push(label);console.log(JSON.stringify({case:label,passed:true}));}
const req={headers:{'user-agent':'rollback-owned-fixture'},get:(name)=>name==='user-agent'?'rollback-owned-fixture':undefined};
try {
 await ok('/health');await ok('/.well-known/jwks.json');record('actual bootstrap health and JWKS');
 for(const path of ['/billing/webhook','/capabilities/tickets','/auth/oauth/token','/session/device/background/mint','/_oxy/mcp']) {
  const r=await fetch('http://127.0.0.1:18002'+path,{method:'POST',headers:{'content-type':'application/json'},body:'{broken'});
  assert.equal(r.status,503);assert.equal((await r.json()).error,'ROLLBACK_AUTH_ONLY');assert.equal(r.headers.get('cache-control'),'no-store');
 }
 assert.equal((await http('/socket.io/?EIO=4&transport=polling')).status,503);
 const {connect}=require('node:net');
 const upgrade=await new Promise((done,reject)=>{const socket=connect({host:'127.0.0.1',port:18002});let raw='';socket.on('error',reject);socket.setTimeout(5000,()=>{socket.destroy();reject(new Error('upgrade fixture timed out'));});socket.on('connect',()=>socket.write('GET /v1/realtime HTTP/1.1\r\nHost: 127.0.0.1:18002\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));socket.on('data',chunk=>raw+=chunk);socket.on('end',()=>done(raw));});
 assert(upgrade.startsWith('HTTP/1.1 503 '));record('non-auth admission precedes malformed parsers and polling');
 const login=await ok('/auth/signin/password',{identifier:f.person.username,password:f.password});
 const session=login.session??login;assert(session.accessToken);
 const me=await ok('/users/me',undefined,session.accessToken);assert.equal((me.data??me).id??(me.data??me)._id,f.person.id);
 await ok('/session/validate/'+session.sessionId);record('real scrypt password ordinary bearer and session validation');
 const deviceId=login.deviceId??session.deviceId,deviceSecret=login.deviceSecret??session.deviceSecret;assert(deviceId&&deviceSecret);
 assert.equal((await http('/accounts/'+f.unrelatedOrg.id+'/switch',{},session.accessToken)).status,403);
 const beforeBot=(await getDb().select({id:sessions.id}).from(sessions).where(eq(sessions.userId,f.bot.id))).length;
 assert.equal((await http('/accounts/'+f.bot.id+'/switch',{},session.accessToken)).status,403);
 assert.equal((await getDb().select({id:sessions.id}).from(sessions).where(eq(sessions.userId,f.bot.id))).length,beforeBot);
 await ok('/accounts/'+f.org.id+'/switch',{},session.accessToken);
 const orgMint=await ok('/session/device/token',{deviceId,deviceSecret});assert.equal(orgMint.data.state.activeAccountId,f.org.id);
 const orgProfile=await ok('/users/me',undefined,orgMint.data.accessToken);assert.equal((orgProfile.data??orgProfile).id??(orgProfile.data??orgProfile)._id,f.org.id);record('canonical person to organization switch and no act_as rejection');
 await getDb().update(accountMembers).set({permissionRevokes:['account:act_as']}).where(eq(accountMembers.memberUserId,f.person.id));
 assert.equal((await http('/users/me',undefined,orgMint.data.accessToken)).status,401);record('managed membership removal observed in warm process');
 const minted=await ok('/auth/service-token',{apiKey:f.service.publicKey,apiSecret:f.service.secret});
 const claims=JSON.parse(Buffer.from(minted.data.token.split('.')[1],'base64url'));assert.equal(claims.exp-claims.iat,300);
 for(const path of ['/users/me','/auth/validate','/session/validate/'+session.sessionId]) {
  assert.equal((await http(path,undefined,minted.data.token,{'x-oxy-user-id':f.person.id})).status,503);
 }
 assert.equal((await http('/users/me',undefined,session.accessToken,{'x-oxy-user-id':f.person.id})).status,503);record('app-only TTL300; old attribution delegation denied before data');
 const challenge=await ok('/auth/service-token/workload/challenge',{});
 const workloadBody={provider:'aws-iam',nonce:challenge.data.nonce,attestation:{answersNonce:challenge.data.nonce,subject:'rollback-owned-workload'}};
 const workload=await ok('/auth/service-token/workload',workloadBody);const wc=JSON.parse(Buffer.from(workload.data.token.split('.')[1],'base64url'));
 assert.equal(wc.exp-wc.iat,300);assert(wc.credentialId.startsWith('wl_'));assert.equal(wc.appId,f.app.id);
 assert.equal((await http('/auth/service-token/workload',workloadBody)).status,401);record('workload mint with synthetic verifier, real authority and nonce replay');
 // Normal old SessionService creates existing-state fixtures; the restricted server must reject them.
 const botSession=await service.createSession(f.bot.id,req);
 const operated=await service.createSession(f.org.id,req,{operatedByUserId:f.bot.id});
 for(const row of [botSession,operated]) {
  assert.equal((await http('/users/me',undefined,row.accessToken)).status,401);
  assert.equal((await http('/session/validate/'+row.sessionId)).status,401);
  assert.equal((await http('/accounts/'+f.org.id+'/switch',{},row.accessToken)).status,401);
 }
 assert.equal((await http('/auth/challenge',{publicKey:f.publicKey})).status,503);
 const signatureService=require('./dist/services/signature.service.js').default;
 const {authChallenges}=require('./dist/db/schema/authChallenges.js');
 const oldChallenge=signatureService.generateChallenge();
 const [storedChallenge]=await getDb().insert(authChallenges).values({publicKey:f.publicKey,challenge:oldChallenge,purpose:'signin',expiresAt:new Date(Date.now()+60_000)}).returning({id:authChallenges.id});
 const oldTimestamp=Date.now();const oldSignature=signatureService.signMessage(`auth:${f.publicKey}:${oldChallenge}:${oldTimestamp}`,f.privateKey);
 assert.equal((await http('/auth/verify',{publicKey:f.publicKey,challenge:oldChallenge,timestamp:oldTimestamp,signature:oldSignature})).status,503);
 assert.equal((await getDb().select({used:authChallenges.used}).from(authChallenges).where(eq(authChallenges.id,storedChallenge.id)))[0].used,false);record('bot subject and bot org operator rejected by fresh session boundary');
 const device=require('./dist/services/deviceSession.service.js').default;
 const ownDevice=await device.registerDevice();
 await device.addAccount(ownDevice.deviceId,{accountId:f.bot.id,sessionId:botSession.sessionId});
 const denied=await http('/session/device/token',{deviceId:ownDevice.deviceId,deviceSecret:ownDevice.deviceSecret});assert.equal(denied.status,401);record('device token cannot remint bot through separate path');
 const signer=require('./dist/services/signature.service.js').default;
 const {randomBytes}=require('node:crypto');const key=randomBytes(32).toString('hex');const {deriveSecp256k1PublicKey}=require('@oxy.so/protocol/secp256k1');const pub=signer.canonicalizePublicKey(deriveSecp256k1PublicKey(key));
 await getDb().update(users).set({publicKey:pub}).where(eq(users.id,f.person.id));
 const keyChallenge=await ok('/auth/challenge',{publicKey:pub});const timestamp=Date.now();const signature=signer.signMessage(`auth:${pub}:${keyChallenge.challenge}:${timestamp}`,key);
 const verified=await ok('/auth/verify',{publicKey:pub,challenge:keyChallenge.challenge,timestamp,signature});assert(verified.accessToken??verified.session?.accessToken);record('ordinary key challenge and signed verification');
 assert.equal(await service.deactivateSession(session.sessionId),true);
 assert.equal((await http('/users/me',undefined,session.accessToken)).status,401);record('canonical SQL deactivation observed without restart');
 console.log(JSON.stringify({checks:checks.length,compiledRuntime:true,providerAttestationVerified:false}));
} catch(error) {console.error(JSON.stringify({failed:true,errorName:error.name,assertion:error.code??null,observedStatus:typeof error.actual==='number'?error.actual:null,expectedStatus:typeof error.expected==='number'?error.expected:null,location:String(error.stack).split('\n').find(line=>line.includes('old-auth-only/probe.mjs'))}));process.exitCode=1;} finally {await require('./dist/config/redis.js').closeRedis();await closePostgres();process.exit(process.exitCode??0);}
