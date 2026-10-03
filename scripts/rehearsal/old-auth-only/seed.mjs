/** Real password/session/service authority and SQL over the same final schema. */
import assert from 'node:assert/strict';
import {installIoGuard} from './io-guard.mjs';
import {seedPreserved} from './seed-preserved.mjs';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
const source=process.env.AUTH_ONLY_SCHEMA_SOURCE;
assert(source);
const deployment=process.env.AUTH_ONLY_BOOTSTRAP_ENVIRONMENT;assert(['test','production'].includes(deployment));
const credentialEnvironment=deployment==='production'?'production':'development';
const keyPrefix=deployment==='production'?'oxy_pk_':'oxy_dk_';
const require = createRequire(resolve(source,'packages/api/package.json'));
const [mode, manifestPath] = process.argv.slice(2);
assert(mode === 'seed' && manifestPath && process.argv.length === 4);
installIoGuard(require,manifestPath+'.'+mode+'.external.json');
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
  const [app] = await getDb().insert(applications).values({name:`Rollback${suffix}`,ownerAccountId:person.id,createdByUserId:person.id,type:'internal',isOfficial:true,isInternal:true,status:'active',scopes:['user:read','capability-tickets:issue','capabilities:read','catalogs:write'],capabilities:['agency:coordinate','catalog:oxy'],redirectUris:['http://127.0.0.1:18002/callback']}).returning({id:applications.id});
  const {applicationWorkloadIdentities}=require('./src/db/schema/applicationWorkloadIdentities.ts');
  await getDb().insert(applicationWorkloadIdentities).values({applicationId:app.id,provider:'aws-iam',subject:'rollback-owned-workload',scopes:['user:read']});
  // Fixture only: the canonical route stores SHA-256 of a random service secret.
  const secret=randomBytes(32).toString('hex');
  const service={publicKey:keyPrefix+randomBytes(24).toString('hex'),secret,secretHash:createHash('sha256').update(secret).digest('hex')};
  await getDb().insert(applicationCredentials).values({applicationId:app.id,name:'owned rollback service',publicKey:service.publicKey,secretHash:service.secretHash,type:'service',environment:credentialEnvironment,status:'active',scopes:['user:read','capability-tickets:issue','capabilities:read','catalogs:write']});
  const clientId=keyPrefix+randomBytes(24).toString('hex');
  await getDb().insert(applicationCredentials).values({applicationId:app.id,name:'owned rollback public',publicKey:clientId,type:'public',environment:credentialEnvironment,status:'active',scopes:['user:read']});
  const privateKey=randomBytes(32).toString('hex');
  const {deriveSecp256k1PublicKey}=require('@oxy.so/protocol/secp256k1');
  const signer=require('./src/services/signature.service.ts').default;
  const publicKey=signer.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey));
  const [bot]=await getDb().insert(users).values({kind:'bot',username:`rollbackbot${suffix}`,publicKey}).returning({id:users.id});
  await getDb().insert(accountMembers).values({accountId:bot.id,memberUserId:person.id,role:'admin',status:'active'});
  const [key]=await getDb().insert(userAuthMethods).values({userId:bot.id,type:'agent_key',methodPublicKey:publicKey,label:'rollback fixture',enrollmentMethod:'governor'}).returning({id:userAuthMethods.id});
  const [unrelatedOrg]=await getDb().insert(users).values({kind:'organization',username:`rollbackoutsider${suffix}`}).returning({id:users.id});
  await getDb().insert(accountMembers).values({accountId:org.id,memberUserId:bot.id,role:'admin',status:'active'});
  const preservedTables=await seedPreserved(require,getDb,person);
  writeFileSync(manifestPath,JSON.stringify({person,org,unrelatedOrg,password,service,app,clientId,bot,key,publicKey,privateKey,preservedTables}),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({seeded:true,realPasswordHash:true,syntheticOnly:true}));

 }
} catch(error) {console.error(error);console.error(JSON.stringify({failed:true,errorName:error.name,location:String(error.stack).split('\n').find(line=>line.includes('old-auth-only/seed.mjs'))}));process.exitCode=1;} finally { await closePostgres(); process.exit(process.exitCode??0); }
