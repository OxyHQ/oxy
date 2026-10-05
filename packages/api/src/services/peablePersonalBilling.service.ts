import { Peable, type PeableConfig } from '@peable.to/sdk';
import { z } from 'zod';
import {billingNamespaceSchema} from '../config/billingNamespace';
import {createHash} from 'node:crypto';
/** Peable is the payment platform; downstream card processing is not an Oxy provider. */
export function createPeablePersonalBilling(config: PeableConfig): Peable { return new Peable(config); }
export const PEABLE_ONE_READINESS = Object.freeze({platform:'peable',primaryMethod:'faircoin',purchase:'unavailable',blockers:[
 'faircoin_recurring_payment_contract','peable_sdk_adoption_and_recurring_observation_delivery',
 'authoritative_inclusive_tax_and_seller_configuration','authoritative_expiring_faircoin_fx_quote',
] as const});
/** Review contract. Current Peable SDK does not supply complete invoice evidence.
 * No zero-tax, FX or seller defaults. Gross is the final advertised merchant total.
 * External wallet/network charges are separate from this invoice total. */
export const personalFinalInvoiceSchema=z.object({
 platform:z.literal('peable'),currency:z.literal('USD'),grossMinorUnits:z.literal(2999),
 netMinorUnits:z.number().int().nonnegative().safe(),taxMinorUnits:z.number().int().nonnegative().safe(),
 merchantFeeMinorUnits:z.literal(0),taxTreatment:z.literal('inclusive'),sellerId:z.string().min(1),invoiceIssuerId:z.string().min(1),
 taxQuoteId:z.string().min(1),customerLocationEvidenceId:z.string().min(1),taxRateEvidenceId:z.string().min(1),
 context:z.object({payerAccountId:z.string().min(1),beneficiaryAccountId:z.string().min(1),providerSubscriptionId:z.string().min(1),offerId:z.string().min(1),offerVersion:z.number().int().positive(),periodStart:z.string().datetime(),periodEnd:z.string().datetime(),mode:z.enum(['live','test']),environment:z.enum(['production','development','staging','test'])}).strict(),
 issuedAt:z.string().datetime(),expiresAt:z.string().datetime(),
 faircoinQuote:z.object({id:z.string().min(1),amountBaseUnits:z.string().regex(/^[1-9][0-9]*$/),quotedAt:z.string().datetime(),expiresAt:z.string().datetime(),roundingEvidenceId:z.string().min(1)}).strict().optional(),
}).strict().superRefine((v,c)=>{
 if(v.netMinorUnits+v.taxMinorUnits!==v.grossMinorUnits)c.addIssue({code:'custom',message:'Inclusive invoice breakdown differs from final price'});
 if(Date.parse(v.expiresAt)<=Date.parse(v.issuedAt))c.addIssue({code:'custom',message:'Tax quote expiry differs'});
 if(v.faircoinQuote&&(Date.parse(v.faircoinQuote.expiresAt)<=Date.parse(v.faircoinQuote.quotedAt)||Date.parse(v.faircoinQuote.expiresAt)>Date.parse(v.expiresAt)))c.addIssue({code:'custom',message:'Faircoin quote expiry differs'});
});
export interface PeableOwnedSubscription {payerAccountId:string;providerSubscriptionId:string;providerCustomerId:string;providerPriceId:string;storeId:string;planId:string;livemode:boolean;}
/** Bounded SDK adapter for opt-in named-source management: ownership must come from a persisted,
 * verified customer mapping. Names/metadata/browser redirects cannot supply it.
 * Cancellation schedules the existing period and never grants access. */
export async function cancelOwnedPeableSubscription(client:Pick<Peable,'billing'>,accountId:string,owned:PeableOwnedSubscription,actionId:string){
 z.string().min(8).max(160).regex(/^[a-zA-Z0-9_-]+$/).parse(actionId);
 if(accountId!==owned.payerAccountId)throw new Error('Peable payer differs');
 const check=(v:Awaited<ReturnType<Peable['billing']['retrieveSubscription']>>)=>{
  for(const key of ['providerSubscriptionId','providerCustomerId','providerPriceId','storeId','planId','livemode'] as const)if(v[key]!==owned[key])throw new Error('Peable subscription ownership differs');
  if(!['active','trialing'].includes(v.status)||!Number.isFinite(Date.parse(v.currentPeriodStart))||!Number.isFinite(Date.parse(v.currentPeriodEnd))||Date.parse(v.currentPeriodEnd)<=Date.parse(v.currentPeriodStart))throw new Error('Peable period unavailable');return v;
 };
 const current=check(await client.billing.retrieveSubscription(owned.providerSubscriptionId));if(current.cancelAtPeriodEnd)return current;
 const updated=check(await client.billing.cancelAtPeriodEnd(owned.providerSubscriptionId,{idempotencyKey:`oxy-one-cancel:${createHash('sha256').update(JSON.stringify([accountId,owned.providerSubscriptionId,actionId])).digest('hex')}`}));
 if(!updated.cancelAtPeriodEnd||updated.currentPeriodStart!==current.currentPeriodStart||updated.currentPeriodEnd!==current.currentPeriodEnd)throw new Error('Peable cancellation period differs');
 const fresh=check(await client.billing.retrieveSubscription(owned.providerSubscriptionId));
 if(!fresh.cancelAtPeriodEnd||fresh.currentPeriodStart!==updated.currentPeriodStart||fresh.currentPeriodEnd!==updated.currentPeriodEnd)throw new Error('Peable cancellation reconciliation required');return fresh;
}

/** Historical parsing above never establishes current action eligibility. This
 * checks a trusted exact context at action time; it cannot manufacture tax/FX. */
export function validatePersonalInvoiceForAction(raw:unknown,context:z.infer<typeof personalFinalInvoiceSchema>['context'],method:'faircoin'|'card',now:Date){
 const v=personalFinalInvoiceSchema.parse(raw);const n=now.getTime();
 if(!billingNamespaceSchema.safeParse({mode:context.mode,environment:context.environment}).success||!Number.isFinite(n)||Date.parse(v.issuedAt)>n||Date.parse(v.expiresAt)<=n||Object.keys(context).some(k=>v.context[k as keyof typeof context]!==context[k as keyof typeof context])||Date.parse(v.context.periodEnd)<=Date.parse(v.context.periodStart))throw new Error('Current invoice context differs');
 if(method==='faircoin'&&!v.faircoinQuote)throw new Error('Authoritative Faircoin quote required');
 if(v.faircoinQuote&&(Date.parse(v.faircoinQuote.quotedAt)>n||Date.parse(v.faircoinQuote.expiresAt)<=n))throw new Error('Current Faircoin quote unavailable');
 return v;
}
