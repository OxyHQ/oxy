/** Execute the ACTUAL parent helper with VM-isolated material/fork/HTTPS services.
 * Clock and owned credential state are real PostgreSQL. No production authority.
 * Offset simulates clock/expiry progression without waiting or renewing a token.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
const source=resolve(process.argv[2]);
const psql='/usr/lib/postgresql/17/bin/psql';
const sql=query=>execFileSync(psql,['-X','-h','127.0.0.1','-p','5628','-U','oxy','-d',process.env.EXPIRY_FIXTURE_DATABASE,'-v','ON_ERROR_STOP=1','-Atc',query],{encoding:'utf8'}).trim();
assert.match(process.env.EXPIRY_FIXTURE_DATABASE??'',/^canary_expiry_[a-f0-9]{16}$/);
let offset=0,mode='',issued=0,revoked=0,clockReads=0,probes=0;
const now=()=>Number(sql(`SELECT floor(extract(epoch FROM clock_timestamp())*1000 + ${offset})::bigint`));
const id='aaaaaaaa-1111-4111-8111-111111111111';
const fixtureService={
 async issueAliaRevocationCanary(){issued++;sql(`INSERT INTO owned_credential VALUES ('${id}','active')`);},
 async revokeAliaRevocationCanary(){revoked++;sql(`UPDATE owned_credential SET status='revoked' WHERE id='${id}'`);},
 async inspectAliaRevocationCanary(){const status=sql(`SELECT status FROM owned_credential WHERE id='${id}'`);return{exists:!!status,status};},
 async verifyAliaCanaryAuthorityUnchanged(){return true;},
 async retireAliaCanaryAfterTaskFailure(){sql(`UPDATE owned_credential SET status='revoked' WHERE id='${id}'`);return{credentialId:id,retired:true,exists:true};},
};
const db={async connectPostgres(){},async closePostgres(){},getDb(){return{
 async execute(){clockReads++;return[{nowMillis:String(now())}];},
 select(){return{from(){return{async where(){return[{status:sql(`SELECT status FROM owned_credential WHERE id='${id}'`)}]}}}}},
};}};
function fork(){const child=new EventEmitter();child.exitCode=null;
 child.send=(message,callback)=>{callback?.();queueMicrotask(()=>{
  if(message.command==='close'){child.emit('message',{id:message.id,result:{closed:true}});child.exitCode=0;child.emit('exit',0);return;}
  if(message.command==='init'){
   const observedAtMillis=now();if(mode==='cross-warm')offset=360000;
   child.emit('message',{id:message.id,result:{outcome:'ALLOW',effectCount:1,coreVersion:'4.2.0',cachePrewarmed:true,verifierCredentialId:'wl_'+'a'.repeat(24),observedAtMillis}});return;
  }
  probes++;if(mode==='cross-probe')offset=360000;
  child.emit('message',{id:message.id,result:{outcome:mode==='oracle-error'?'ERROR':'DENY',effectCount:1,status:403,observedAtMillis:now()}});
 });};child.kill=()=>{child.exitCode=0;child.emit('exit',0);};return child;}
const requireFixture=path=>{
 if(path.endsWith('config/postgres.js'))return db;
 if(path.endsWith('aliaRevocationCanary.service.js'))return fixtureService;
 if(path.endsWith('credentialMaterial.js'))return{generateCredentialMaterial:()=>({publicKey:'fixture-public',secret:'fixture-secret'}),credentialVerifier:()=>({fixture:true})};
 if(path.endsWith('applicationCredentials.js'))return{applicationCredentials:{status:'status',id:'id'}};
 if(path==='drizzle-orm')return{eq(){},sql(){return'fixed-clock-query';}};
 throw new Error('unexpected_fixture_import');
};
class ControlledDate extends Date{static now(){return now();}}
const context=vm.createContext({Buffer,URL,AbortSignal,Date:ControlledDate,process:{env:{}},setTimeout,clearTimeout,
 async fetch(){const iat=Math.floor(now()/1000),lifetime=mode==='short-bearer'?10:300;
 return{status:200,async json(){return{data:{expiresIn:lifetime,token:'fixture.'+Buffer.from(JSON.stringify({appId:'fixture-app',credentialId:id,ownerAccountId:'fixture-owner',environment:'production',scopes:['acting-as:offline','inference:invoke'],iat,exp:iat+lifetime})).toString('base64url')+'.fixture'}}}};}});
const synthetic=(identifier,exports)=>{const module=new vm.SyntheticModule(Object.keys(exports),function(){for(const[key,value]of Object.entries(exports))this.setExport(key,value);},{context,identifier});return module;};
const actual=new vm.SourceTextModule(readFileSync(source,'utf8'),{context,identifier:source,initializeImportMeta(meta){meta.url='file://'+source;}});
await actual.link(async name=>{
 if(name==='node:module')return synthetic(name,{createRequire:()=>requireFixture});
 if(name==='node:child_process')return synthetic(name,{fork});
 if(name==='node:perf_hooks')return synthetic(name,{performance});
 const module=await import(name);return synthetic(name,module);
});await actual.evaluate();
let checks=0;
async function run(name,seconds=300){offset=0;mode=name;issued=revoked=clockReads=probes=0;sql('TRUNCATE owned_credential');
 const start=now(),plan={applicationId:'fixture-app',ownerAccountId:'fixture-owner',credentialId:id,nonce:'b'.repeat(24),principalId:'existing-fixture-grant',expiresAt:new Date(start+seconds*1000).toISOString()};
 const result=await actual.namespace.executeCanary({apiPackage:'/fixture/api/package.json',plan,operator:{operatorArn:'fixture-operator',authorizationSha256:'a'.repeat(64)}});
 assert.equal(result.cleanupConfirmed,true);assert.equal(sql("SELECT count(*) FROM owned_credential WHERE status<>'revoked'"),'0');
 return{result,issued,probes,clockReads};}
// Same requirement fixture on old and final parent: initial ALLOW, canonical
// revoked readback and DENY, but the accepted sample is beyond credential expiry.
const crossed=await run('cross-probe');
assert.equal(crossed.result.measured,false,'natural expiry must never count as measured revocation');assert.equal(crossed.issued,1);assert.equal(crossed.probes,2);checks++;
if(process.argv[3]==='red-only'){console.log('Unexpected baseline pass');process.exit(1);}
for(const name of ['cross-warm','short-bearer']){const x=await run(name);assert.equal(x.result.measured,false);assert.equal(x.issued,1);checks++;}
for(const seconds of [30,-10]){const x=await run('fresh',seconds);assert.equal(x.result.measured,false);assert.equal(x.issued,0);checks++;}
const fresh=await run('fresh');assert.equal(fresh.result.success,true);assert.equal(fresh.result.measured,true);assert.equal(fresh.probes,2);assert(fresh.clockReads>=4);checks++;
assert(fresh.result.checks.some(x=>x.kind==='expiry_excluded'&&x.marginMs===2000));checks++;
const error=await run('oracle-error');assert.equal(error.result.measured,false);assert.equal(error.result.primaryFailure,'canary_authoritative_denial_failed');checks++;
const recovery=await actual.namespace.recoverCanary({apiPackage:'/fixture/api/package.json',plan:{credentialId:id,nonce:'b'.repeat(24),expiresAt:new Date(now()-1000).toISOString()},operator:{}});assert(recovery.cleanupConfirmed);assert.equal(sql("SELECT count(*) FROM owned_credential WHERE status<>'revoked'"),'0');checks++;
console.log(JSON.stringify({kind:'actual-parent-controlled-expiry-own-pg-fixture',checks,clock:'actual PostgreSQL clock_timestamp with fixture offset',forkAndMint:'VM-isolated synthetic boundaries',providerRequests:0,awsRequests:0,allOwnedRowsRetired:true}));
