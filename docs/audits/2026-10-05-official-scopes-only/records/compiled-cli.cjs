'use strict';
const assert = require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {createRequire}=require('node:module');
const path=require('node:path');
const root='/home/nate/Oxy/oxy/.worktrees/1572-mention-scope-seed-20261005';
const api=path.join(root,'packages/api');
const req=createRequire(path.join(api,'package.json'));
const {eq}=req('drizzle-orm');
const {connectPostgres,closePostgres,getDb}=req('./dist/config/postgres.js');
const {users,applications,applicationWorkloadIdentities}=req('./dist/db/schema');
const {SEED_APPS,MENTION_APPLICATION_ID:appId}=req('./dist/scripts/seedOxyApplicationsSpecs.js');
const ownerId='69b2d3df5d12f58c9800d651';
const spec=SEED_APPS.find(x=>x.id===appId);
const scopes=spec.scopes.filter(x=>!['inference:invoke','inference:usage:read'].includes(x));
function invoke(extra){
 const r=spawnSync(process.execPath,['dist/scripts/seedOxyApplicationScopes.js'],{cwd:api,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',DATABASE_URL:process.env.DATABASE_URL,SCOPES_ONLY:'true',ONLY_APP_IDS:appId,...extra},encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,`CLI failed: ${r.stderr}`);
 const receipt=r.stdout.split('\n').map(x=>{try{return JSON.parse(x)}catch{return null}}).find(x=>x?.kind==='official-application-scopes-only-v1');
 assert.ok(receipt);return receipt;
}
(async()=>{await connectPostgres();try{
 await getDb().insert(users).values({id:ownerId,username:'oxy',kind:'organization',type:'local',color:'blue',accountStatus:'active'});
 await getDb().insert(applications).values({id:appId,name:'Mention',createdByUserId:ownerId,ownerAccountId:ownerId,type:'first_party',isOfficial:true,isInternal:false,status:'active',scopes,description:'Synthetic CLI preservation'});
 const read=async()=> (await getDb().select().from(applications).where(eq(applications.id,appId)))[0];
 const before=await read();const dry=invoke({DRY_RUN:'true'});assert.deepEqual(await read(),before);
 assert.deepEqual(dry.applications[0].added,['inference:invoke','inference:usage:read']);
 const applied=invoke({DRY_RUN:'false',EXPECTED_PLAN_SHA256:dry.planSha256});assert.equal(applied.changed,1);
 const after=await read();assert.deepEqual({...after,scopes:before.scopes},before);
 const again=invoke({DRY_RUN:'true'});assert.equal(invoke({DRY_RUN:'false',EXPECTED_PLAN_SHA256:again.planSha256}).changed,0);
 console.log(JSON.stringify({kind:'compiled-node-cli-test',passed:true,dryRunZeroWrites:true,onlyScopesChanged:true,repeatNoop:true,node:process.version,syntheticOwnedDatabase:true}));
}finally{await getDb().delete(applications).where(eq(applications.id,appId));await getDb().delete(users).where(eq(users.id,ownerId));await closePostgres();}})().catch(e=>{console.error(e);process.exitCode=1});
