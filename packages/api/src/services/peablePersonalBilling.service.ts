import { Peable, type PeableConfig } from '@peable.to/sdk';
import { z } from 'zod';
/** Peable is the payment platform; downstream card processing is not an Oxy provider. */
export function createPeablePersonalBilling(config: PeableConfig): Peable { return new Peable(config); }
export const PEABLE_ONE_READINESS = Object.freeze({platform:'peable',primaryMethod:'faircoin',purchase:'unavailable',blockers:[
 'faircoin_recurring_payment_contract','recurring_paid_period_evidence','checkout_completion_identity',
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
 issuedAt:z.string().datetime(),expiresAt:z.string().datetime(),
 faircoinQuote:z.object({id:z.string().min(1),amountBaseUnits:z.string().regex(/^[1-9][0-9]*$/),quotedAt:z.string().datetime(),expiresAt:z.string().datetime(),roundingEvidenceId:z.string().min(1)}).strict().optional(),
}).strict().superRefine((v,c)=>{
 if(v.netMinorUnits+v.taxMinorUnits!==v.grossMinorUnits)c.addIssue({code:'custom',message:'Inclusive invoice breakdown differs from final price'});
 if(Date.parse(v.expiresAt)<=Date.parse(v.issuedAt))c.addIssue({code:'custom',message:'Tax quote expiry differs'});
 if(v.faircoinQuote&&(Date.parse(v.faircoinQuote.expiresAt)<=Date.parse(v.faircoinQuote.quotedAt)||Date.parse(v.faircoinQuote.expiresAt)>Date.parse(v.expiresAt)))c.addIssue({code:'custom',message:'Faircoin quote expiry differs'});
});
export interface PeableOwnedSubscription {payerAccountId:string;providerSubscriptionId:string;providerCustomerId:string;providerPriceId:string;storeId:string;planId:string;livemode:boolean;}
/** Bounded SDK adapter, not enabled in HTTP: ownership must come from a persisted,
 * verified customer mapping. Names/metadata/browser redirects cannot supply it.
 * Cancellation schedules the existing period and never grants access. */
export async function cancelOwnedPeableSubscription(client:Pick<Peable,'billing'>,accountId:string,owned:PeableOwnedSubscription){
 if(accountId!==owned.payerAccountId)throw new Error('Peable payer differs');
 const check=(v:Awaited<ReturnType<Peable['billing']['retrieveSubscription']>>)=>{
  for(const key of ['providerSubscriptionId','providerCustomerId','providerPriceId','storeId','planId','livemode'] as const)if(v[key]!==owned[key])throw new Error('Peable subscription ownership differs');
  if(!['active','trialing'].includes(v.status)||!Number.isFinite(Date.parse(v.currentPeriodStart))||!Number.isFinite(Date.parse(v.currentPeriodEnd))||Date.parse(v.currentPeriodEnd)<=Date.parse(v.currentPeriodStart))throw new Error('Peable period unavailable');return v;
 };
 const current=check(await client.billing.retrieveSubscription(owned.providerSubscriptionId));if(current.cancelAtPeriodEnd)return current;
 const updated=check(await client.billing.cancelAtPeriodEnd(owned.providerSubscriptionId,{idempotencyKey:`oxy-one-cancel:${owned.providerSubscriptionId}`}));
 if(!updated.cancelAtPeriodEnd||updated.currentPeriodStart!==current.currentPeriodStart||updated.currentPeriodEnd!==current.currentPeriodEnd)throw new Error('Peable cancellation period differs');return updated;
}
