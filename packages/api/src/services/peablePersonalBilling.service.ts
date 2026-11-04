import { integerCheck, safeNumberCheck, utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import type { Peable } from '@peable.to/sdk';
import { z } from 'zod';
import { billingNamespaceSchema } from '../config/billingNamespace';
import { createHash } from 'node:crypto';
export const PEABLE_ONE_READINESS = Object.freeze({
  platform: 'peable',
  primaryMethod: 'faircoin',
  purchase: 'unavailable',
  blockers: [
    'configured_watch_only_merchant_and_verified_chain_access',
    'authoritative_inclusive_tax_and_seller_configuration',
    'live_faircoin_fx_provider_access',
  ] as const,
});
/** Peable instants are integer Unix seconds (ADR 0014); a fractional, negative
 * or unsafe number is refused rather than rounded. */
export const peableUnixSecondsSchema = z
  .number()
  .check(integerCheck())
  .nonnegative()
  .check(safeNumberCheck());
/** Oxy's access ledger keeps ISO instants; this is the one conversion from Peable's wire. */
export function peableInstantToIso(seconds: number): string {
  return new Date(peableUnixSecondsSchema.parse(seconds) * 1000).toISOString();
}
/** A Peable amount: a base-unit integer string (ADR 0014 D1, authority schema 3). */
const peableAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
/** Verified signed invoice contract supplied by the configured Peable SDK.
 * No zero-tax, FX or seller defaults. Gross is the final advertised merchant total.
 * External wallet/network charges are separate from this invoice total. */
export const personalFinalInvoiceSchema = z
  .object({
    platform: z.literal('peable'),
    currency: z.literal('USD'),
    gross_minor_units: peableAmountSchema.refine((value) => value !== '0'),
    net_minor_units: peableAmountSchema,
    tax_minor_units: peableAmountSchema,
    merchant_fee_minor_units: z.literal('0'),
    tax_treatment: z.literal('inclusive'),
    seller_id: z.string().check(utf16MinLength(1)),
    invoice_issuer_id: z.string().check(utf16MinLength(1)),
    tax_quote_id: z.string().check(utf16MinLength(1)),
    customer_location_evidence_id: z.string().check(utf16MinLength(1)),
    tax_rate_evidence_id: z.string().check(utf16MinLength(1)),
    context: z
      .object({
        payer_account_id: z.string().check(utf16MinLength(1)),
        beneficiary_account_id: z.string().check(utf16MinLength(1)),
        provider_subscription_id: z.string().check(utf16MinLength(1)),
        offer_id: z.string().check(utf16MinLength(1)),
        offer_version: z.number().check(integerCheck()).positive(),
        period_start: peableUnixSecondsSchema,
        period_end: peableUnixSecondsSchema,
        mode: z.enum(['live', 'test']),
        environment: z.enum(['production', 'development', 'staging', 'test']),
      })
      .strict(),
    issued_at: peableUnixSecondsSchema,
    expires_at: peableUnixSecondsSchema,
    faircoin_quote: z
      .object({
        id: z.string().check(utf16MinLength(1)),
        amount_base_units: z.string().regex(/^[1-9][0-9]*$/),
        quoted_at: peableUnixSecondsSchema,
        expires_at: peableUnixSecondsSchema,
        rounding_evidence_id: z.string().check(utf16MinLength(1)),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (BigInt(v.net_minor_units) + BigInt(v.tax_minor_units) !== BigInt(v.gross_minor_units))
      c.addIssue({
        code: 'custom',
        message: 'Inclusive invoice breakdown differs from final price',
      });
    if (v.expires_at <= v.issued_at)
      c.addIssue({ code: 'custom', message: 'Tax quote expiry differs' });
    if (
      v.faircoin_quote &&
      (v.faircoin_quote.expires_at <= v.faircoin_quote.quoted_at ||
        v.faircoin_quote.expires_at > v.expires_at)
    )
      c.addIssue({ code: 'custom', message: 'Faircoin quote expiry differs' });
  });
export interface PeableOwnedSubscription {
  payerAccountId: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerPriceId: string;
  storeId: string;
  planId: string;
  livemode: boolean;
}
/** Bounded SDK adapter for opt-in named-source management: ownership must come from a persisted,
 * verified customer mapping. Names/metadata/browser redirects cannot supply it.
 * Cancellation schedules the existing period and never grants access. */
export async function cancelOwnedPeableSubscription(
  client: Pick<Peable, 'billing'>,
  accountId: string,
  owned: PeableOwnedSubscription,
  actionId: string,
) {
  z.string()
    .check(utf16MinLength(8))
    .check(utf16MaxLength(160))
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(actionId);
  if (accountId !== owned.payerAccountId) throw new Error('Peable payer differs');
  const check = (v: Awaited<ReturnType<Peable['billing']['retrieveSubscription']>>) => {
    if (
      v.provider_subscription_id !== owned.providerSubscriptionId ||
      v.provider_customer_id !== owned.providerCustomerId ||
      v.provider_price_id !== owned.providerPriceId ||
      v.store_id !== owned.storeId ||
      v.plan_id !== owned.planId ||
      v.livemode !== owned.livemode
    )
      throw new Error('Peable subscription ownership differs');
    if (
      !['active', 'trialing', 'past_due', 'unpaid'].includes(v.status) ||
      !peableUnixSecondsSchema.safeParse(v.current_period_start).success ||
      !peableUnixSecondsSchema.safeParse(v.current_period_end).success ||
      v.current_period_end <= v.current_period_start
    )
      throw new Error('Peable period unavailable');
    return v;
  };
  const current = check(await client.billing.retrieveSubscription(owned.providerSubscriptionId));
  if (current.cancel_at_period_end) return current;
  const updated = check(
    await client.billing.cancelAtPeriodEnd(
      owned.providerSubscriptionId,
      {},
      {
        idempotencyKey: `oxy-one-cancel:${createHash('sha256')
          .update(JSON.stringify([accountId, owned.providerSubscriptionId, actionId]))
          .digest('hex')}`,
      },
    ),
  );
  if (
    !updated.cancel_at_period_end ||
    updated.current_period_start !== current.current_period_start ||
    updated.current_period_end !== current.current_period_end
  )
    throw new Error('Peable cancellation period differs');
  const fresh = check(await client.billing.retrieveSubscription(owned.providerSubscriptionId));
  if (
    !fresh.cancel_at_period_end ||
    fresh.current_period_start !== updated.current_period_start ||
    fresh.current_period_end !== updated.current_period_end
  )
    throw new Error('Peable cancellation reconciliation required');
  return fresh;
}

/** Historical parsing above never establishes current action eligibility. This
 * checks a trusted exact context at action time; it cannot manufacture tax/FX. */
export function validatePersonalInvoiceForAction(
  raw: unknown,
  context: z.infer<typeof personalFinalInvoiceSchema>['context'],
  method: 'faircoin' | 'card',
  now: Date,
  paidAt?: Date,
  expectedAmountMinorUnits = 2999,
) {
  const v = personalFinalInvoiceSchema.parse(raw);
  if (v.gross_minor_units !== String(expectedAmountMinorUnits))
    throw new Error('Invoice differs from the declared commercial price');
  // Signed instants are whole Unix seconds; compare them on the millisecond clock.
  const n = now.getTime();
  if (
    !billingNamespaceSchema.safeParse({ mode: context.mode, environment: context.environment })
      .success ||
    !Number.isFinite(n) ||
    v.issued_at * 1000 > n ||
    v.expires_at * 1000 <= n ||
    Object.keys(context).some(
      (k) => v.context[k as keyof typeof context] !== context[k as keyof typeof context],
    ) ||
    v.context.period_end <= v.context.period_start
  )
    throw new Error('Current invoice context differs');
  if (method === 'faircoin' && !v.faircoin_quote)
    throw new Error('Authoritative Faircoin quote required');
  // New payment actions require a current quote; paid-evidence recovery binds
  // the original quote to the verified payment instant instead of delivery time.
  const quoteInstant = paidAt?.getTime() ?? n;
  if (
    v.faircoin_quote &&
    (!Number.isFinite(quoteInstant) ||
      quoteInstant > n ||
      v.faircoin_quote.quoted_at * 1000 > quoteInstant ||
      v.faircoin_quote.expires_at * 1000 <= quoteInstant)
  )
    throw new Error('Current Faircoin quote unavailable');
  return v;
}
