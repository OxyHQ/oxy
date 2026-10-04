/** Newly created owned DB fixture; creates synthetic consent, never a live operator. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const require=createRequire(join(process.cwd(),'package.json'));
const db=require('./dist/config/postgres.js'),schema=require('./dist/db/schema/index.js');
const service=require('./dist/services/aliaRevocationCanary.service.js');
const material=require('./dist/utils/credentialMaterial.js');
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5616');assert(url.pathname.startsWith('/oxy_canary_transport_'));
try{
 await db.connectPostgres();const sql=db.getDb();
 await sql.insert(schema.users).values({id:service.I03_CANARY_OWNER_ID,color:'blue'});
 const [principal]=await sql.insert(schema.users).values({color:'teal'}).returning();
 await sql.insert(schema.applications).values({id:'6a2f851751b784a86fd0e934',ownerAccountId:service.I03_CANARY_OWNER_ID,name:'canary node fixture',
  type:'internal',isOfficial:true,isInternal:true,status:'active',scopes:['acting-as:offline','inference:invoke']});
 await sql.insert(schema.appGrants).values({applicationId:'6a2f851751b784a86fd0e934',userId:principal.id,scopes:['acting-as:offline','inference:invoke']});
 const actor={operatorArn:'arn:aws:sts::237343248947:assumed-role/Fixture/operator',authorizationSha256:'a'.repeat(64)};
 const plan=await service.prepareAliaRevocationCanary(principal.id,actor);
 const key=material.generateCredentialMaterial();
 await service.issueAliaRevocationCanary(plan,material.credentialVerifier(key),actor);key.secret='';
 console.log('CANARY_NODE_SEED '+JSON.stringify({principalId:principal.id,canaryPlan:plan}));
}finally{await db.closePostgres();}
