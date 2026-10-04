import assert from 'node:assert/strict';import {createRequire} from 'node:module';import{readCanaryObservation}from'./read-canary-observation.mjs';
const require=createRequire(`${process.cwd()}/package.json`),postgres=require('postgres');const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5635');const db=postgres(url.href,{max:1});const owner='01a0369b-1222-712f-8df6-f8ffeb78ccc2',app='6a2f851751b784a86fd0e934',intent='oxy1519-i09-1791093169991-608bdb4f0ed0e8b0';let passed=0;
try{
 await assert.rejects(readCanaryObservation('never-connect','foreign'),/invalid_exact_intent/);passed++;
 await db`INSERT INTO users(id,color) VALUES (${owner},'blue')`;
 await db`INSERT INTO applications(id,name,owner_account_id,type,status,is_official,is_internal,scopes) VALUES (${app},'Synthetic local I09',${owner},'internal','active',true,true,ARRAY['inference:invoke'])`;
 const before=await readCanaryObservation(url.href,intent);assert.equal(before.readOnly,true);assert.equal(before.isolation,'repeatable read');assert.equal(before.metered.length,0);assert.equal(before.attempts.length,0);assert.equal(before.cursor,null);assert(Object.values(before.money).every(row=>row.count==='0'));passed++;
 await db`INSERT INTO account_balances(account_id,currency) VALUES (${owner},'USD')`;
 const after=await readCanaryObservation(url.href,intent);assert.equal(after.money.account_balances.count,'1');assert.notEqual(before.money.account_balances.sha256,after.money.account_balances.sha256);assert.deepEqual(before.money.usage_receipts,after.money.usage_receipts);assert(!JSON.stringify(after).includes('purchased_balance'));passed++;
 await db`UPDATE applications SET status='suspended' WHERE id=${app}`;await assert.rejects(readCanaryObservation(url.href,intent),/caller_context_changed/);passed++;
 console.log(`I09 exact observation ${passed} controls PASS, fully migrated own PG only`);
}finally{await db.end({timeout:5});}
