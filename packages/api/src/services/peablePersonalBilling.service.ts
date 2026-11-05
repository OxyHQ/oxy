import { integerCheck, safeNumberCheck, utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import type { Peable } from '@peable.to/sdk';
import { z } from 'zod';
import { createHash } from 'node:crypto';

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
/** A Peable amount: a base-unit integer string (ADR 0014). */
export const peableAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** An expandable Peable reference: the id, or the object carrying it. */
export function peableReference(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.id;
}

export type PeableSubscription = Awaited<ReturnType<Peable['subscriptions']['retrieve']>>;
/** One native Orbit subscription as Oxy's access ledger reads it. A personal
 * plan subscription has exactly ONE item of quantity one; anything else is not
 * one Oxy sold and is refused rather than interpreted. */
export interface PeableNativeSubscription {
  id: string;
  customerId: string;
  priceId: string;
  status: PeableSubscription['status'];
  livemode: boolean;
  interval: 'month' | 'year';
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  trialEnd: number | null;
  latestInvoiceId: string | null;
  checkoutSessionId: string | null;
}
export function readNativeSubscription(value: PeableSubscription): PeableNativeSubscription {
  const items = value.items.data;
  const item = items[0];
  const customerId = peableReference(value.customer);
  if (
    items.length !== 1 ||
    value.items.has_more ||
    !item ||
    item.quantity !== 1 ||
    !customerId ||
    item.price.recurring === null ||
    item.price.recurring.interval_count !== 1 ||
    (item.price.recurring.interval !== 'month' && item.price.recurring.interval !== 'year') ||
    !peableUnixSecondsSchema.safeParse(value.current_period_start).success ||
    !peableUnixSecondsSchema.safeParse(value.current_period_end).success ||
    value.current_period_end <= value.current_period_start
  )
    throw new Error('Peable subscription is not a personal plan subscription');
  return {
    id: value.id,
    customerId,
    priceId: item.price.id,
    status: value.status,
    livemode: value.livemode,
    interval: item.price.recurring.interval,
    currentPeriodStart: value.current_period_start,
    currentPeriodEnd: value.current_period_end,
    cancelAtPeriodEnd: value.cancel_at_period_end,
    trialEnd: value.trial_end,
    latestInvoiceId: peableReference(value.latest_invoice),
    checkoutSessionId: value.metadata.checkout_session ?? null,
  };
}

export interface PeableOwnedSubscription {
  payerAccountId: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerPriceId: string;
  livemode: boolean;
}
/** Named-source cancellation on the native subscription. Ownership comes from
 * the persisted source and its verified customer; names, metadata and browser
 * redirects cannot supply it. Cancellation schedules the existing period and
 * never grants access. */
export async function cancelOwnedPeableSubscription(
  client: Pick<Peable, 'subscriptions'>,
  accountId: string,
  owned: PeableOwnedSubscription,
  actionId: string,
): Promise<PeableNativeSubscription> {
  z.string()
    .check(utf16MinLength(8))
    .check(utf16MaxLength(160))
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(actionId);
  if (accountId !== owned.payerAccountId) throw new Error('Peable payer differs');
  const check = (raw: PeableSubscription) => {
    const v = readNativeSubscription(raw);
    if (
      v.id !== owned.providerSubscriptionId ||
      v.customerId !== owned.providerCustomerId ||
      v.priceId !== owned.providerPriceId ||
      v.livemode !== owned.livemode
    )
      throw new Error('Peable subscription ownership differs');
    if (!['active', 'trialing', 'past_due', 'unpaid'].includes(v.status))
      throw new Error('Peable period unavailable');
    return v;
  };
  const current = check(await client.subscriptions.retrieve(owned.providerSubscriptionId));
  if (current.cancelAtPeriodEnd) return current;
  const updated = check(
    await client.subscriptions.update(
      owned.providerSubscriptionId,
      { cancel_at_period_end: true },
      {
        idempotencyKey: `oxy-personal-cancel:${createHash('sha256')
          .update(JSON.stringify([accountId, owned.providerSubscriptionId, actionId]))
          .digest('hex')}`,
      },
    ),
  );
  if (
    !updated.cancelAtPeriodEnd ||
    updated.currentPeriodStart !== current.currentPeriodStart ||
    updated.currentPeriodEnd !== current.currentPeriodEnd
  )
    throw new Error('Peable cancellation period differs');
  const fresh = check(await client.subscriptions.retrieve(owned.providerSubscriptionId));
  if (
    !fresh.cancelAtPeriodEnd ||
    fresh.currentPeriodStart !== updated.currentPeriodStart ||
    fresh.currentPeriodEnd !== updated.currentPeriodEnd
  )
    throw new Error('Peable cancellation reconciliation required');
  return fresh;
}
