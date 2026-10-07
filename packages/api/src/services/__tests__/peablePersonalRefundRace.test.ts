import * as providerEvidence from '../productProviderEvidence.service';
import {reconcileProductAccessFinancialState} from '../productAccessPersistence.service';
import {accessSubscriptionSources,accessProviderRefunds} from '../../db/schema';
import {eq} from 'drizzle-orm';
import {connectPostgres,closePostgres,getDb} from '../../config/postgres';
import {accessGrants} from '../../db/schema';
import {productAccessFixture} from '../__fixtures__/productAccessFixtures';
import {reconcilePeablePersonalPaidInvoice,reconcilePeablePersonalInvoiceState,handlePeablePersonalObservation,type PeableEvidenceAuthority} from '../peablePersonalEvidence.service';
beforeAll(connectPostgres);afterAll(closePostgres);
async function fixture(){
 const f=await productAccessFixture();const context={accountId:f.payer,appId:f.app.id,merchantId:'merch_fixture',customerId:'cus_fixture',subscriptionId:`sub_${f.payer}`,priceId:'price_fixture',planId:'synthetic-approved',offerId:f.offers[0].id,offerVersion:1,mode:'live' as const,environment:'production' as const};
 const invoiceId=`in_${f.payer.replaceAll('-','')}`;const paid={invoiceId,lineId:'il_fixture',paymentIntentId:'pi_fixture',providerSubscriptionId:context.subscriptionId,providerCustomerId:context.customerId,providerPriceId:context.priceId,storeId:f.payer,planId:context.planId,livemode:true,currency:'USD',amountPaid:'2999',netAmount:'2500',taxAmount:'499',periodStart:f.period.start,periodEnd:f.period.end,paidAt:f.now.toISOString(),observedAt:f.now.toISOString()};
 let release!:()=>void;let captured!:()=>void;const atAuthority=new Promise<void>(r=>captured=r),barrier=new Promise<void>(r=>release=r);
 const client={merchants:{retrieve:async()=>({id:context.merchantId,oxyAppId:context.appId,environment:context.environment})},billing:{retrievePaidInvoice:async()=>paid,retrieveInvoiceState:async()=>({...paid,state:'fully_refunded',chargeId:'ch_fixture',amountRefunded:'2999'}),retrieveSubscription:async()=>({providerSubscriptionId:context.subscriptionId,providerCustomerId:context.customerId,providerPriceId:context.priceId,storeId:f.payer,planId:context.planId,livemode:true,status:'active',interval:'month',cancelAtPeriodEnd:false,currentPeriodStart:f.period.start,currentPeriodEnd:f.period.end,trialEndsAt:null})}} as unknown as PeableEvidenceAuthority['client'];
 const authority:PeableEvidenceAuthority={client,readFinalInvoiceAuthority:async source=>{captured();await barrier;return {source,method:'card' as const,invoice:{platform:'peable',currency:'USD',grossMinorUnits:2999,netMinorUnits:2500,taxMinorUnits:499,merchantFeeMinorUnits:0,taxTreatment:'inclusive',sellerId:'synthetic',invoiceIssuerId:'synthetic',taxQuoteId:'synthetic',customerLocationEvidenceId:'synthetic',taxRateEvidenceId:'synthetic',issuedAt:new Date(f.now.getTime()-1000).toISOString(),expiresAt:new Date(f.now.getTime()+60_000).toISOString(),context:{payerAccountId:f.payer,beneficiaryAccountId:f.payer,providerSubscriptionId:context.subscriptionId,offerId:context.offerId,offerVersion:1,periodStart:f.period.start,periodEnd:f.period.end,mode:context.mode,environment:context.environment}}};}};
 return {f,context,paid,client,authority,release,atAuthority,invoiceId};
}
it('a completed refund before activation commits fences the still-fresh paid worker',async()=>{
 const {f,context,client,authority,release,atAuthority,invoiceId}=await fixture();
 const activation=reconcilePeablePersonalPaidInvoice(authority,context,invoiceId,()=>f.now).then(value=>({value}),error=>({error}));await atAuthority;
 const refund=await reconcilePeablePersonalInvoiceState({client},context,invoiceId,()=>f.now);release();const result=await activation;
 expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId,f.payer))).toHaveLength(0);expect(refund.status).toBe('fenced');const [fence]=await getDb().select().from(accessProviderRefunds).where(eq(accessProviderRefunds.payerAccountId,f.payer));expect(fence.invoiceId).toBe(invoiceId);await expect(getDb().update(accessProviderRefunds).set({priceId:'forged'}).where(eq(accessProviderRefunds.id,fence.id))).rejects.toThrow();expect((await reconcilePeablePersonalInvoiceState({client},context,invoiceId,()=>f.now)).status).toBe('replayed');expect(result).toMatchObject({error:expect.any(Error)});expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId,f.payer))).toHaveLength(0);
});

it('an older subscription read cannot outrank cancellation after paid persistence awaits',async()=>{
 const {f,context,client,authority,release,invoiceId}=await fixture();release();const first=await reconcilePeablePersonalPaidInvoice(authority,context,invoiceId,()=>f.now);
 let time=f.now.getTime();const originalRead=client.billing.retrieveSubscription;client.billing.retrieveSubscription=async ref=>{const sub=await originalRead(ref);time=f.now.getTime()+100;return sub;};
 let resume!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>resume=r),atPersistence=new Promise<void>(r=>arrived=r);const write=providerEvidence.recordProductProviderPeriod;
 const spy=jest.spyOn(providerEvidence,'recordProductProviderPeriod').mockImplementation(async(...args)=>{const value=await write(...args);arrived();await gate;return value;});
 try{const old=reconcilePeablePersonalPaidInvoice(authority,context,invoiceId,()=>new Date(time));await atPersistence;
  await reconcileProductAccessFinancialState({sourceId:first.sourceId,beneficiaryAccountId:f.payer,payerAccountId:f.payer,provider:'peable',providerSubscriptionId:context.subscriptionId,providerBinding:{providerAccountRef:context.merchantId,mode:context.mode,environment:context.environment},providerObservedAt:new Date(f.now.getTime()+200),status:'active',period:f.period,cancelAtPeriodEnd:true});
  time=f.now.getTime()+300;resume();await old;const [source]=await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id,first.sourceId));expect(source.cancelAtPeriodEnd).toBe(true);expect(source.providerObservedAt.getTime()).toBe(f.now.getTime()+200);
 }finally{resume();spy.mockRestore();}
});

it('subscription wake observation time is captured before an awaited source lookup',async()=>{
 const {f,context,client,authority,release,invoiceId}=await fixture();release();const first=await reconcilePeablePersonalPaidInvoice(authority,context,invoiceId,()=>f.now);
 let time=f.now.getTime();const read=client.billing.retrieveSubscription;client.billing.retrieveSubscription=async ref=>{const value=await read(ref);time=f.now.getTime()+100;return value;};
 const db=getDb(),select=db.select.bind(db);let resume!:()=>void,arrived!:()=>void,spent=false;const gate=new Promise<void>(r=>resume=r),atLookup=new Promise<void>(r=>arrived=r);
 // Delay the real source query result, without replacing the writer or its locks.
 const spy=jest.spyOn(db,'select').mockImplementation(((...args:any[])=>{
  const builder=(select as any)(...args);return new Proxy(builder,{get(target,key){if(key!=='from'){const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}return(table:any)=>{
   const query=target.from(table);if(table!==accessSubscriptionSources||spent)return query;
   return new Proxy(query,{get(q,k){if(k!=='where'){const value=Reflect.get(q,k);return typeof value==='function'?value.bind(q):value;}return(...conditions:any[])=>{const filtered=q.where(...conditions);return new Proxy(filtered,{get(result,p){if(p==='then')return(resolve:any,reject:any)=>Promise.resolve(filtered).then(async rows=>{spent=true;arrived();await gate;return rows;}).then(resolve,reject);const value=Reflect.get(result,p);return typeof value==='function'?value.bind(result):value;}});};}});
  };}});
 }) as any);
 try{
  const event={id:'evt_fixture',object:'event',type:'billing.observation.updated',created:f.now.toISOString(),data:{object:{object:'billing_observation',resourceKind:'subscription',resourceId:context.subscriptionId,revision:1,observedAt:f.now.toISOString()}}};
  const old=handlePeablePersonalObservation(authority,context,JSON.stringify(event),'synthetic',()=>event,()=>new Date(time));await atLookup;
  await reconcileProductAccessFinancialState({sourceId:first.sourceId,beneficiaryAccountId:f.payer,payerAccountId:f.payer,provider:'peable',providerSubscriptionId:context.subscriptionId,providerBinding:{providerAccountRef:context.merchantId,mode:context.mode,environment:context.environment},providerObservedAt:new Date(f.now.getTime()+200),status:'active',period:f.period,cancelAtPeriodEnd:true});time=f.now.getTime()+300;resume();expect(await old).toEqual({status:'stale'});
  const [source]=await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id,first.sourceId));expect(source.cancelAtPeriodEnd).toBe(true);expect(source.providerObservedAt.getTime()).toBe(f.now.getTime()+200);
 }finally{resume();spy.mockRestore();}
});
