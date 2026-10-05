import {z} from 'zod';
import {oxyAccountIdSchema} from '@oxy.so/contracts';
import type {Peable} from '@peable.to/sdk';
import {recordProductProviderPeriod,type ProductProviderPeriodInput} from './productProviderEvidence.service';
import {validatePersonalInvoiceForAction,personalFinalInvoiceSchema} from './peablePersonalBilling.service';
const evidenceSchema=z.object({invoiceId:z.string().min(1),lineId:z.string().min(1),paymentIntentId:z.string().min(1),providerSubscriptionId:z.string().min(1),providerCustomerId:z.string().min(1),providerPriceId:z.string().min(1),storeId:z.string().min(1),planId:z.string().min(1),livemode:z.boolean(),currency:z.literal('USD'),amountPaid:z.literal('2999'),netAmount:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),taxAmount:z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),periodStart:z.string().datetime(),periodEnd:z.string().datetime(),paidAt:z.string().datetime(),observedAt:z.string().datetime()}).strict();
export interface PeableInvoiceSource {invoiceId:string;paymentIntentId:string;customerId:string;subscriptionId:string;priceId:string;planId:string;merchantId:string;appId:string;mode:'live'|'test';environment:'production'|'test'|'development'|'staging';}
export interface PeableEvidenceAuthority{
 /** Authenticated server read through the updated Peable SDK, not browser data. */
 client:Pick<Peable,'billing'> & {billing:{retrievePaidInvoice?(subscriptionId:string,invoiceId:string):Promise<unknown>}};
 /** Authoritative tax/seller evidence is not currently supplied by Peable. No default. */
 readFinalInvoiceAuthority?:(source:PeableInvoiceSource)=>Promise<{source:PeableInvoiceSource;invoice:unknown}>;
}
/** Shared trusted context is frozen from an owned checkout/source and reviewed offer,
 * not metadata. Remains closed until real SDK and tax authority are supported. */
export async function reconcilePeablePersonalPaidInvoice(authority:PeableEvidenceAuthority,
 context:{accountId:string;customerId:string;subscriptionId:string;priceId:string;planId:string;merchantId:string;appId:string;mode:'live'|'test';environment:'production'|'test'|'development'|'staging';offerId:string;offerVersion:number},invoiceId:string,clock:()=>Date=()=>new Date()){
 if(!authority.client.billing.retrievePaidInvoice||!authority.readFinalInvoiceAuthority)throw new Error('Authoritative Peable evidence is unconfigured');
 const value=evidenceSchema.parse(await authority.client.billing.retrievePaidInvoice(context.subscriptionId,invoiceId));
 const validateTime=()=>{const now=clock();
 if(value.invoiceId!==invoiceId||value.providerSubscriptionId!==context.subscriptionId||value.providerCustomerId!==context.customerId||value.providerPriceId!==context.priceId||value.storeId!==context.accountId||value.planId!==context.planId||value.livemode!==(context.mode==='live')||Date.parse(value.observedAt)>now.getTime()||now.getTime()-Date.parse(value.observedAt)>60_000||Date.parse(value.paidAt)>now.getTime()||Date.parse(value.periodStart)>now.getTime()||Date.parse(value.periodEnd)<=now.getTime())throw new Error('Peable paid period ownership/time differs');
 };
 validateTime();
 const source:PeableInvoiceSource={invoiceId:value.invoiceId,paymentIntentId:value.paymentIntentId,customerId:context.customerId,subscriptionId:context.subscriptionId,priceId:context.priceId,planId:context.planId,merchantId:context.merchantId,appId:context.appId,mode:context.mode,environment:context.environment};
 const authorityResult=await authority.readFinalInvoiceAuthority(Object.freeze({...source}));
 if(!authorityResult.source||Object.keys(source).some(k=>authorityResult.source[k as keyof PeableInvoiceSource]!==source[k as keyof PeableInvoiceSource]))throw new Error('Peable authoritative invoice source differs');
 const validateInvoice=()=>validatePersonalInvoiceForAction(authorityResult.invoice,{payerAccountId:context.accountId,beneficiaryAccountId:context.accountId,providerSubscriptionId:context.subscriptionId,offerId:context.offerId,offerVersion:context.offerVersion,periodStart:value.periodStart,periodEnd:value.periodEnd,mode:context.mode,environment:context.environment},'card',clock());
 const invoice=validateInvoice();
 if(value.netAmount===null||value.taxAmount===null||BigInt(value.netAmount)!==BigInt(invoice.netMinorUnits)||BigInt(value.taxAmount)!==BigInt(invoice.taxMinorUnits))throw new Error('Peable authoritative invoice totals differ');
 const accountId=oxyAccountIdSchema.parse(context.accountId);
 const input:ProductProviderPeriodInput={binding:{providerAccountRef:context.merchantId,mode:context.mode,environment:context.environment},subscription:{schemaVersion:1,beneficiaryAccountId:accountId,payerAccountId:accountId,provider:'peable',providerSubscriptionId:context.subscriptionId,status:'active',period:{start:value.periodStart,end:value.periodEnd},cancelAtPeriodEnd:false},offer:{offerId:context.offerId,offerVersion:context.offerVersion,origin:'bundle'},paidLine:{invoiceId:value.invoiceId,lineId:value.lineId,priceId:value.providerPriceId,quantity:1,period:{start:value.periodStart,end:value.periodEnd}},event:{id:`peable-read:${value.invoiceId}:${value.lineId}`,createdAt:value.paidAt},providerObservedAt:new Date(value.observedAt)};
 // Only paid period is authoritative here. Do not overwrite cancellation/status
 // from an invoice read: read fresh subscription via the same owned SDK mapping.
 const subscription=await authority.client.billing.retrieveSubscription(context.subscriptionId);
 if(subscription.providerSubscriptionId!==context.subscriptionId||subscription.interval!=='month'||subscription.trialEndsAt!==null||subscription.storeId!==context.accountId||subscription.planId!==context.planId||subscription.providerCustomerId!==context.customerId||subscription.providerPriceId!==context.priceId||subscription.livemode!==(context.mode==='live')||subscription.currentPeriodStart!==value.periodStart||subscription.currentPeriodEnd!==value.periodEnd)throw new Error('Peable current subscription differs');
 input.subscription.status=subscription.status;input.subscription.cancelAtPeriodEnd=subscription.cancelAtPeriodEnd;
 validateTime();validateInvoice();
 return recordProductProviderPeriod(input);
}
export type PersonalInvoiceAuthority=z.infer<typeof personalFinalInvoiceSchema>;
