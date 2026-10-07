import {billingNamespaceSchema} from '../config/billingNamespace';
import {getDb} from '../config/postgres';
import {accessSubscriptionSources,accessProviderPeriods} from '../db/schema';
import {and,eq} from 'drizzle-orm';
import {reconcileProductAccessFinancialState} from './productAccessPersistence.service';
import {z} from 'zod';
import {oxyAccountIdSchema} from '@oxy.so/contracts';
import type {Peable, BillingPaidInvoice, BillingInvoiceState} from '@peable.to/sdk';
import {recordProductProviderPeriod,revokeProductProviderPaidPeriod,type ProductProviderPeriodInput} from './productProviderEvidence.service';
import {validatePersonalInvoiceForAction,personalFinalInvoiceSchema} from './peablePersonalBilling.service';
export const peablePaidEvidenceSchema=z.object({invoiceId:z.string().min(1),lineId:z.string().min(1),paymentIntentId:z.string().min(1),providerSubscriptionId:z.string().min(1),providerCustomerId:z.string().min(1),providerPriceId:z.string().min(1),storeId:z.string().min(1),planId:z.string().min(1),livemode:z.boolean(),currency:z.literal('USD'),amountPaid:z.literal('2999'),netAmount:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),taxAmount:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),periodStart:z.string().datetime(),periodEnd:z.string().datetime(),paidAt:z.string().datetime(),observedAt:z.string().datetime()}).strict();
export interface PeableInvoiceSource {invoiceId:string;paymentIntentId:string;customerId:string;subscriptionId:string;priceId:string;planId:string;merchantId:string;appId:string;mode:'live'|'test';environment:'production'|'test'|'development'|'staging';}
export interface PeableEvidenceAuthority{
 /** Authenticated server read through the updated Peable SDK, not browser data. */
 client:Pick<Peable,'merchants'> & {billing:Pick<Peable['billing'],'retrievePaidInvoice'|'retrieveInvoiceState'|'retrieveSubscription'>};
 /** Authoritative tax/seller evidence is not currently supplied by Peable. No default. */
 readFinalInvoiceAuthority?:(source:PeableInvoiceSource)=>Promise<{source:PeableInvoiceSource;invoice:unknown;method:'card'|'faircoin'}>;
}
export interface PeablePersonalPaidContext {accountId:string;customerId:string;subscriptionId:string;priceId:string;planId:string;merchantId:string;appId:string;mode:'live'|'test';environment:'production'|'test'|'development'|'staging';offerId:string;offerVersion:number;}
async function assertPeableEvidenceOwner(authority:PeableEvidenceAuthority,context:PeablePersonalPaidContext){
 billingNamespaceSchema.parse({mode:context.mode,environment:context.environment});
 if(!authority.client.merchants?.retrieve)throw new Error('Authenticated Peable merchant read unconfigured');
 const merchant=await authority.client.merchants.retrieve();
 if(merchant.id!==context.merchantId||merchant.oxyAppId!==context.appId||merchant.environment!==context.environment)throw new Error('Peable credential owner differs');
}
/** Shared trusted context is frozen from an owned checkout/source and reviewed offer,
 * not metadata. Remains closed until real SDK and tax authority are supported. */
export async function reconcilePeablePersonalPaidInvoice(authority:PeableEvidenceAuthority,
 context:PeablePersonalPaidContext,invoiceId:string,clock:()=>Date=()=>new Date()){
 if(!authority.client.billing.retrievePaidInvoice||!authority.readFinalInvoiceAuthority)throw new Error('Authoritative Peable evidence is unconfigured');
 await assertPeableEvidenceOwner(authority,context);
 const paid:BillingPaidInvoice=await authority.client.billing.retrievePaidInvoice(context.subscriptionId,invoiceId);
 const value=peablePaidEvidenceSchema.parse(paid);
 const validateTime=()=>{const now=clock();
 if(value.invoiceId!==invoiceId||value.providerSubscriptionId!==context.subscriptionId||value.providerCustomerId!==context.customerId||value.providerPriceId!==context.priceId||value.storeId!==context.accountId||value.planId!==context.planId||value.livemode!==(context.mode==='live')||Date.parse(value.observedAt)>now.getTime()||now.getTime()-Date.parse(value.observedAt)>60_000||Date.parse(value.paidAt)>now.getTime()||Date.parse(value.periodStart)>now.getTime()||Date.parse(value.periodEnd)<=now.getTime())throw new Error('Peable paid period ownership/time differs');
 };
 validateTime();
 const source:PeableInvoiceSource={invoiceId:value.invoiceId,paymentIntentId:value.paymentIntentId,customerId:context.customerId,subscriptionId:context.subscriptionId,priceId:context.priceId,planId:context.planId,merchantId:context.merchantId,appId:context.appId,mode:context.mode,environment:context.environment};
 const authorityResult=await authority.readFinalInvoiceAuthority(Object.freeze({...source}));
 if(!authorityResult.source||Object.keys(source).some(k=>authorityResult.source[k as keyof PeableInvoiceSource]!==source[k as keyof PeableInvoiceSource]))throw new Error('Peable authoritative invoice source differs');
 const method=z.enum(['card','faircoin']).parse(authorityResult.method);
 const validateInvoice=()=>validatePersonalInvoiceForAction(authorityResult.invoice,{payerAccountId:context.accountId,beneficiaryAccountId:context.accountId,providerSubscriptionId:context.subscriptionId,offerId:context.offerId,offerVersion:context.offerVersion,periodStart:value.periodStart,periodEnd:value.periodEnd,mode:context.mode,environment:context.environment},method,clock());
 const invoice=validateInvoice();
 if(value.netAmount===null||value.taxAmount===null||BigInt(value.netAmount)!==BigInt(invoice.netMinorUnits)||BigInt(value.taxAmount)!==BigInt(invoice.taxMinorUnits))throw new Error('Peable authoritative invoice totals differ');
 const accountId=oxyAccountIdSchema.parse(context.accountId);
 const input:ProductProviderPeriodInput={binding:{providerAccountRef:context.merchantId,mode:context.mode,environment:context.environment},subscription:{schemaVersion:1,beneficiaryAccountId:accountId,payerAccountId:accountId,provider:'peable',providerSubscriptionId:context.subscriptionId,status:'active',period:{start:value.periodStart,end:value.periodEnd},cancelAtPeriodEnd:false},offer:{offerId:context.offerId,offerVersion:context.offerVersion,origin:'bundle'},paidLine:{invoiceId:value.invoiceId,lineId:value.lineId,priceId:value.providerPriceId,quantity:1,period:{start:value.periodStart,end:value.periodEnd}},event:{id:`peable-read:${value.invoiceId}:${value.lineId}`,createdAt:value.paidAt},providerObservedAt:new Date(value.observedAt)};
 // Only paid period is authoritative here. Do not overwrite cancellation/status
 // from an invoice read: read fresh subscription via the same owned SDK mapping.
 const subscription=await authority.client.billing.retrieveSubscription(context.subscriptionId);
 const subscriptionObservedAt=clock();input.providerObservedAt=subscriptionObservedAt;
 if(subscription.providerSubscriptionId!==context.subscriptionId||subscription.interval!=='month'||subscription.trialEndsAt!==null||subscription.storeId!==context.accountId||subscription.planId!==context.planId||subscription.providerCustomerId!==context.customerId||subscription.providerPriceId!==context.priceId||subscription.livemode!==(context.mode==='live')||subscription.currentPeriodStart!==value.periodStart||subscription.currentPeriodEnd!==value.periodEnd)throw new Error('Peable current subscription differs');
 input.subscription.status=subscription.status;input.subscription.cancelAtPeriodEnd=subscription.cancelAtPeriodEnd;
 validateTime();validateInvoice();
 const result=await recordProductProviderPeriod(input);
 // A paid-line replay does not update an existing source snapshot. Explicitly
 // reconcile the later owned subscription read, preserving cancellation/status.
 await reconcileProductAccessFinancialState({sourceId:result.sourceId,beneficiaryAccountId:context.accountId,payerAccountId:context.accountId,provider:'peable',providerSubscriptionId:context.subscriptionId,providerBinding:input.binding,providerObservedAt:subscriptionObservedAt,status:subscription.status,period:{start:value.periodStart,end:value.periodEnd},cancelAtPeriodEnd:subscription.cancelAtPeriodEnd});
 return result;
}
export type PersonalInvoiceAuthority=z.infer<typeof personalFinalInvoiceSchema>;

/** Unmounted wake-up handler: never grant from webhook amounts/status. The
 * authenticated SDK re-read determines current state even for delayed paid events.
 * Partial refund policy is unselected: report review_required, no proportional grant.
 * Existing paid-period evidence is required before exact-line revocation. */
export async function reconcilePeablePersonalInvoiceState(authority:PeableEvidenceAuthority,context:PeablePersonalPaidContext,invoiceId:string,clock:()=>Date=()=>new Date()){
 if(!authority.client.billing.retrieveInvoiceState)throw new Error('Authoritative Peable invoice state unconfigured');
 await assertPeableEvidenceOwner(authority,context);
 const invoiceState:BillingInvoiceState=await authority.client.billing.retrieveInvoiceState(context.subscriptionId,invoiceId);
 const value=peablePaidEvidenceSchema.extend({chargeId:z.string().min(1),amountRefunded:z.string().regex(/^(0|[1-9][0-9]*)$/),state:z.enum(['paid','fully_refunded','partially_refunded'])}).parse(invoiceState);
 const now=clock().getTime();
 if(value.invoiceId!==invoiceId||value.providerSubscriptionId!==context.subscriptionId||value.providerCustomerId!==context.customerId||value.providerPriceId!==context.priceId||value.storeId!==context.accountId||value.planId!==context.planId||value.livemode!==(context.mode==='live')||Date.parse(value.observedAt)>now||now-Date.parse(value.observedAt)>60_000||Date.parse(value.paidAt)>now)throw new Error('Peable invoice state ownership/time differs');
 const refunded=BigInt(value.amountRefunded),paid=BigInt(value.amountPaid);
 if((value.state==='paid'&&refunded!==BigInt(0))||(value.state==='fully_refunded'&&refunded!==paid)||(value.state==='partially_refunded'&&(refunded<=BigInt(0)||refunded>=paid)))throw new Error('Peable refund amount differs');
 if(value.state==='paid'){
  if(Date.parse(value.periodEnd)<=now){
   const [period]=await getDb().select().from(accessProviderPeriods).where(and(eq(accessProviderPeriods.provider,'peable'),eq(accessProviderPeriods.providerAccountRef,context.merchantId),eq(accessProviderPeriods.mode,context.mode),eq(accessProviderPeriods.environment,context.environment),eq(accessProviderPeriods.invoiceId,value.invoiceId),eq(accessProviderPeriods.lineId,value.lineId)));
   if(!period)return {status:'review_required' as const,reason:'historical_paid_period_not_recorded' as const};
   if(period.payerAccountId!==context.accountId||period.beneficiaryAccountId!==context.accountId||period.providerSubscriptionId!==context.subscriptionId||period.priceId!==context.priceId||period.offerId!==context.offerId||period.offerVersion!==context.offerVersion||period.periodStart.toISOString()!==value.periodStart||period.periodEnd.toISOString()!==value.periodEnd)throw new Error('Peable historical paid ownership differs');
   return {status:'historical_replayed' as const,sourceId:period.sourceId,segmentId:period.segmentId};
  }
  return reconcilePeablePersonalPaidInvoice(authority,context,invoiceId,clock);
 }
 if(value.state==='partially_refunded')return {status:'review_required' as const,reason:'partial_refund_entitlement_policy_unconfigured' as const};
 return revokeProductProviderPaidPeriod({binding:{providerAccountRef:context.merchantId,mode:context.mode,environment:context.environment},accountId:context.accountId,subscriptionId:context.subscriptionId,invoiceId:value.invoiceId,lineId:value.lineId,priceId:value.providerPriceId,paymentIntentId:value.paymentIntentId,chargeId:value.chargeId,period:{start:value.periodStart,end:value.periodEnd},observedAt:new Date(value.observedAt)});
}

/** Secrets supplied only by approved server composition. Updated SDK HMAC/timestamp
 * verification is mandatory; verified bytes still carry no payer/plan authority. */
export function createPeableObservationVerifier(client:Pick<Peable,'webhooks'>,secret:string){
 if(!secret)throw new Error('Peable observation signing is unconfigured');
 return (rawBody:string,signature:string):unknown=>client.webhooks.constructEvent(rawBody,signature,secret);
}
/** No route or timer mounted. Context comes from the server's existing owner-bound
 * checkout/source, never from delivery fields. Replays reread current provider state. */
export async function handlePeablePersonalObservation(authority:PeableEvidenceAuthority,context:PeablePersonalPaidContext,rawBody:string,signature:string,verify:(body:string,signature:string)=>unknown|Promise<unknown>,clock:()=>Date=()=>new Date()){
 if(Buffer.byteLength(rawBody)>1_048_576)throw new Error('Peable observation body too large');
 const event=z.object({id:z.string().min(1),object:z.literal('event'),type:z.literal('billing.observation.updated'),created:z.string().datetime(),data:z.object({object:z.object({object:z.literal('billing_observation'),resourceKind:z.enum(['subscription','invoice']),resourceId:z.string().min(1),revision:z.number().int().positive(),observedAt:z.string().datetime()}).strict()}).strict()}).strict().parse(await verify(rawBody,signature));
 await assertPeableEvidenceOwner(authority,context);
 const resource=event.data.object;
 if(resource.resourceKind==='invoice')return reconcilePeablePersonalInvoiceState(authority,context,resource.resourceId,clock);
 if(resource.resourceId!==context.subscriptionId)throw new Error('Peable observation subscription differs');
 const sub=await authority.client.billing.retrieveSubscription(context.subscriptionId);
 const subscriptionObservedAt=clock();
 if(sub.providerSubscriptionId!==context.subscriptionId||sub.providerCustomerId!==context.customerId||sub.providerPriceId!==context.priceId||sub.storeId!==context.accountId||sub.planId!==context.planId||sub.livemode!==(context.mode==='live'))throw new Error('Peable observation ownership differs');
 const [source]=await getDb().select().from(accessSubscriptionSources).where(and(eq(accessSubscriptionSources.provider,'peable'),eq(accessSubscriptionSources.providerSubscriptionId,context.subscriptionId),eq(accessSubscriptionSources.providerAccountRef,context.merchantId),eq(accessSubscriptionSources.payerAccountId,context.accountId),eq(accessSubscriptionSources.beneficiaryAccountId,context.accountId),eq(accessSubscriptionSources.mode,context.mode),eq(accessSubscriptionSources.environment,context.environment)));
 if(!source)return {status:'not_recorded' as const};
 return {status:await reconcileProductAccessFinancialState({sourceId:source.id,beneficiaryAccountId:context.accountId,payerAccountId:context.accountId,provider:'peable',providerSubscriptionId:context.subscriptionId,providerBinding:{providerAccountRef:context.merchantId,mode:context.mode,environment:context.environment},providerObservedAt:subscriptionObservedAt,status:sub.status,period:{start:sub.currentPeriodStart,end:sub.currentPeriodEnd},cancelAtPeriodEnd:sub.cancelAtPeriodEnd})};
}
