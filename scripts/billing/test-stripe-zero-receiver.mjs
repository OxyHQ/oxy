/** Own authenticated zero invoice event, local fixture signatures, no provider mutations. */
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
assert.equal(process.argv.length,3);
const owned=process.argv[2];
assert.match(owned,/^\/home\/nate\/Oxy\/\.agent-evidence\/integration-stripe-1519-20261003\/[a-f0-9]{24}$/);
const manifest=JSON.parse(await readFile(join(owned,'manifest.private.json'),'utf8'));
const captured=await readFile(join(owned,'zero-event.private.json'),'utf8');
const event=JSON.parse(captured),invoice=event.data.object;
assert.equal(event.type,'invoice.paid');assert.equal(event.livemode,false);assert.equal(invoice.amount_paid,0);
assert.equal(invoice.customer,manifest.resources.find(x=>x.kind==='customer').id);
assert.equal(invoice.parent.subscription_details.subscription,manifest.resources.find(x=>x.kind==='subscription').id);
assert.equal(process.env.STRIPE_SECRET_KEY,'sk_test_offline_fixture');assert.equal(process.env.BILLING_PROCESSOR_ENVIRONMENT,'test');
const api=join(process.cwd(),'packages/api');const require=createRequire(join(api,'package.json'));
const {sql}=require('drizzle-orm'),express=require('express');
const source=async(p)=>import(pathToFileURL(join(api,'src',p+'.ts')).href);
const pg=await source('config/postgres');const schema=await source('db/schema/users');const credits=await source('db/schema/userCredits');
const catalogueModule=await source('services/productBillingCatalogue.service');
const {loadBillingRouter,assertAcceptedWebhookDelivery,rehearsalErrorDiagnostic}=await import(pathToFileURL(join(api,'scripts/stripe-billing-sandbox-rehearsal.ts')).href);
const directory=await mkdtemp(join(tmpdir(),'oxy-zero-receiver-'));
process.env.BILLING_PRODUCT_CATALOGUE_FILE=join(directory,'catalogue.json');
const broken=JSON.parse(await readFile(join(owned,'catalogue.private.json'),'utf8'));
assert.ok(broken.prices.some(x=>x.amountMinorUnits===0));
const invalid=catalogueModule.productBillingCatalogueSchema.safeParse(broken);assert.equal(invalid.success,false);
assert.ok(invalid.error.issues.some(x=>x.path.join('.')==='prices.0.amountMinorUnits'));
const corrected={...broken,prices:broken.prices.filter(x=>x.amountMinorUnits>0)};
assert.equal(corrected.prices.length,0);catalogueModule.productBillingCatalogueSchema.parse(corrected);
const realFetch=globalThis.fetch;let rejectedExternalRequests=0;
globalThis.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.hostname!=='127.0.0.1'){rejectedExternalRequests++;throw new Error('Fixture rejects all external requests');}
 return realFetch(input,options);
};
let server;
try{
 await pg.connectPostgres();const db=pg.getDb();
 const mapped=broken.subscriptions.find(x=>x.providerSubscriptionId===invoice.parent.subscription_details.subscription);
 assert.ok(mapped);
 const [payer]=await db.insert(schema.users).values({id:mapped.payerAccountId,kind:'personal',color:'teal'}).returning({id:schema.users.id});
 assert.equal(payer.id,mapped.payerAccountId);
 await db.insert(credits.userCredits).values({userId:payer.id,creditsFree:0,creditsFreeLimit:0,creditsPaid:0,stripeCustomerId:invoice.customer});
 const app=express();app.use('/billing/webhook',express.raw({type:'application/json'}));app.use('/billing',await loadBillingRouter(process.cwd()));
 server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const signature=()=>{const t=Math.floor(Date.now()/1000);return `t=${t},v1=${createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${captured}`).digest('hex')}`;};
 const send=()=>fetch(`http://127.0.0.1:${server.address().port}/billing/webhook`,{method:'POST',body:captured,headers:{'content-type':'application/json','stripe-signature':signature()},signal:AbortSignal.timeout(10000)});
 await writeFile(process.env.BILLING_PRODUCT_CATALOGUE_FILE,JSON.stringify(broken));
 const red=await send();assert.equal(red.status,500);assert.deepEqual(await red.clone().json(),{error:'Webhook handler error'});
 let rejected;try{await assertAcceptedWebhookDelivery(red);}catch(error){rejected=rehearsalErrorDiagnostic(error,'fixture');}
 assert.equal(rejected?.receiverStatus,500);assert.equal(rejected?.receiverCode,'webhook_handler_failed');
 const [failure]=await db.execute(sql`select outcome,outcome_detail from billing_stripe_events where stripe_event_id=${event.id}`);
 assert.equal(failure.outcome,'failed');assert.match(failure.outcome_detail,/amountMinorUnits/);
 await writeFile(process.env.BILLING_PRODUCT_CATALOGUE_FILE,JSON.stringify(corrected));
 const green=await send();await assertAcceptedWebhookDelivery(green);assert.equal(green.status,200);assert.deepEqual(await green.json(),{received:true});
 const replay=await send();assert.equal(replay.status,200);
 const [receipt]=await db.execute(sql`select outcome,attempts from billing_stripe_events where stripe_event_id=${event.id}`);
 assert.equal(receipt.outcome,'not_granted');assert.equal(receipt.attempts,3);
 const [balance]=await db.execute(sql`select credits_paid from user_credits where user_id=${payer.id}`);assert.equal(Number(balance.credits_paid),0);
 const [counts]=await db.execute(sql`select (select count(*) from billing_credit_grants) as credits, (select count(*) from access_grants) as access, (select count(*) from billing_transactions) as transactions`);
 assert.equal(Number(counts.credits),0);assert.equal(Number(counts.access),0);assert.equal(Number(counts.transactions),0);
 assert.equal(rejectedExternalRequests,0);
 console.log(JSON.stringify({sameAuthenticatedOwnEvent:true,sameInvoiceCustomerBinding:true,sameFixturePayerBinding:true,realRawBodyRoute:true,actualRunnerDeliveryDiagnostic:true,receiverFailureStatus:500,receiverFailureCode:"webhook_handler_failed",invalidPaidCatalogueStatus:500,validNoPaidMappingStatus:200,replayStatus:200,receiptAttempts:3,outcome:'not_granted',creditGrants:0,accessGrants:0,balance:0,providerRequests:0,providerMutations:0,providerSignedDelivery:false}));
}finally{
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await pg.closePostgres();globalThis.fetch=realFetch;await rm(directory,{recursive:true,force:true});
}
