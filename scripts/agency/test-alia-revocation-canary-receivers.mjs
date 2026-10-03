/** Two REAL SDK processes and crypto over loopback; authority/AWS facts are synthetic.
 * This fixture measures helper behavior, not the productive <5s requirement.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { createCanaryWorker } from './alia-revocation-canary.mjs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const apiPackage=process.argv[2]?resolve(process.argv[2]):join(ROOT,'packages/api/package.json');
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const jwk={...publicKey.export({format:'jwk'}),kid:'canary-fixture',use:'sig',alg:'EdDSA'};
const appId='6a2f851751b784a86fd0e934',principalId='synthetic-existing-grant',credentialId='aa1aa1aa-1111-4111-8111-111111111111';
const verifierId='wl_'+'a'.repeat(24);let revoked=false,outage=false,lookups=0;
function token(id){const now=Math.floor(Date.now()/1000);const body={type:'service',appId,appName:'Alia fixture',credentialId:id,
 ownerAccountId:'69b2d3df5d12f58c9800d651',environment:'production',tier:'internal',scopes:['acting-as:offline','inference:invoke'],iat:now,exp:now+300,iss:'oxy-auth',aud:'oxy-api'};
 const input=[{alg:'EdDSA',kid:'canary-fixture',typ:'JWT'},body].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');return input+'.'+sign(null,Buffer.from(input),privateKey).toString('base64url');}
function authenticated(value){try{const [h,p,s]=value.split('.');const claims=JSON.parse(Buffer.from(p,'base64url'));
 return verify(null,Buffer.from(h+'.'+p),publicKey,Buffer.from(s,'base64url'))&&claims.credentialId===verifierId;}catch{return false;}}
const workloadToken=token(verifierId),bearer=token(credentialId);
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');res.setHeader('Content-Type','application/json');
 const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
 if(url.pathname==='/.well-known/jwks.json')return send(200,{keys:[jwk]});
 if(url.pathname==='/metadata')return send(200,{AccessKeyId:'AKIA'+'A'.repeat(16),SecretAccessKey:'B'.repeat(40),Token:'synthetic-session'});
 if(url.pathname==='/auth/service-token/workload/challenge')return send(200,{data:{nonce:'C'.repeat(48)}});
 if(url.pathname==='/auth/service-token/workload')return send(200,{data:{token:workloadToken,expiresIn:300,appName:'Alia fixture'}});
 if(url.pathname==='/internal/service-acting-as/verify'){
  lookups++;if(!authenticated((req.headers.authorization??'').replace('Bearer ','')))return send(401,{code:'invalid_fixture_verifier'});
  if(outage)return send(503,{code:'fixture_outage'});
  if(url.searchParams.get('appId')!==appId||url.searchParams.get('userId')!==principalId||url.searchParams.get('credentialId')!==credentialId)return send(200,{data:{authorized:false,scopes:[],epoch:'1'}});
  return send(200,{data:{authorized:!revoked,scopes:revoked?[]:['acting-as:offline','inference:invoke'],epoch:'1'}});
 }
 send(404,{});
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const baseURL=`http://127.0.0.1:${server.address().port}`;
const children=[];let sequence=0,checks=0;
function spawn(){
 const previous=process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI, previousMode=process.env.NODE_ENV;
 process.env.NODE_ENV='production';
 process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI=baseURL+'/metadata';
 let worker;
 try{worker=createCanaryWorker();}finally{
  if(previous===undefined)Reflect.deleteProperty(process.env,'AWS_CONTAINER_CREDENTIALS_FULL_URI');
  else process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI=previous;
  if(previousMode===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');else process.env.NODE_ENV=previousMode;
 }
 children.push(worker.child);return worker;
}
try{
 const processes=[spawn(),spawn()];
 const warmed=await Promise.all(processes.map(x=>x.command('init',{apiPackage,baseURL,principalId,bearer})));
 assert.deepEqual(warmed.map(x=>[x.outcome,x.effectCount,x.coreVersion,x.cachePrewarmed,x.verifierCredentialId]),[
 ['ALLOW',1,'4.2.0',true,verifierId],['ALLOW',1,'4.2.0',true,verifierId]]);checks+=2;
 assert(lookups>=4);checks++;
 outage=true;const errors=await Promise.all(processes.map(x=>x.command('probe')));
 assert(errors.every(x=>x.outcome==='ERROR'&&x.effectCount===1));checks+=2;
 outage=false;revoked=true;const denied=await Promise.all(processes.map(x=>x.command('probe')));
 assert(denied.every(x=>x.outcome==='DENY'&&x.effectCount===1&&x.status===403));checks+=2;
 assert(lookups>=12);checks++;
 for(const x of processes){assert(!x.child.spawnargs.join(' ').includes(bearer));assert(!x.child.spawnargs.join(' ').includes(workloadToken));checks+=2;await x.stop();}
 console.log(JSON.stringify({fixture:'two-real-sdk-processes-synthetic-oracle',assertions:checks,coreVersion:'4.2.0',processes:2,parentForkUsed:true,
  cachePrewarmed:true,effectsBefore:[1,1],effectsAfter:[1,1],outageCountedAsDeny:false,liveRevocationMeasured:false}));
}finally{for(const child of children){if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,2000))]);if(child.exitCode===null)child.kill('SIGKILL');}}
 await new Promise(done=>server.close(done));}
