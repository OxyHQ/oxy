import { isoDateTime, utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
/**
 * The platform fee Oxy charges when a customer brings their own provider key
 * (BYOK). Kaana ADR 0002: a BYOK request is exactly `platform_fee_only`.
 *
 * ## It is billing configuration, not a price list
 *
 * The provider bills the customer directly, so a BYOK request owes Oxy only a
 * fee for the platform. That fee is a concept of Oxy's BILLING — like the
 * economic relationships in `inferenceEconomicPolicy.ts` — and not a model's
 * list price: it is not in Kaana's declared catalogue (a BYOK-only model
 * declares no price) and it is not a row of `price_versions` (Oxy's old-edge
 * price tables). It lives here: explicit, typed, and versioned in code.
 *
 * ## Versioned, reviewed, and fail-closed
 *
 * {@link PLATFORM_FEE_SCHEDULES} is reviewable data. A fee is never edited: a
 * change appends a schedule with a new `feeVersionId` and a later
 * `effectiveFrom`, and a grant records the version it was rated at (its
 * `priceVersionId`, with a copy of the entries, like any other grant line).
 * There is no environment switch: a fee a deployment variable could set is one
 * nobody reviewed.
 *
 * The list is EMPTY until the owner approves an exact amount (the rule in
 * `docs/inference/billing.md`: production stays fail-closed until an exact
 * immutable fee is approved). With no effective schedule a BYOK route is not
 * admitted; it is never admitted at a fee of zero by absence.
 *
 * ## What it prices
 *
 * One flat fee per request. The provider bills every metered unit to the
 * customer, so {@link platformFeePriceList} prices each other usage unit at an
 * EXPLICIT zero — the same shape a settlement is rated against, and the reason
 * a hold can be quoted over the token scenarios of the request.
 */

import { USAGE_UNITS, type UsageUnit } from '@oxy.so/contracts';
import { z } from 'zod';
import type { PriceSnapshotInput } from '../services/inferenceLedger.service';

export const platformFeeScheduleSchema = z
  .object({
    /** Identifies this schedule forever; a new fee is a new id. */
    feeVersionId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(128)),
    /** First instant (ISO 8601) this schedule applies. */
    effectiveFrom: z.string().check(isoDateTime()),
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** The fee for one request, an exact decimal in `currency`. */
    perRequest: z.string().regex(/^\d{1,18}(\.\d{1,12})?$/),
    /** Who approved it and where, for audit; never read by billing. */
    approvedBy: z.string().check(utf16MinLength(1)),
    approvalRef: z.string().check(utf16MinLength(1)),
  })
  .strict();

export type PlatformFeeSchedule = z.infer<typeof platformFeeScheduleSchema>;

/**
 * Every approved schedule, oldest first. Empty until the owner approves an
 * amount; see the header.
 */
export const PLATFORM_FEE_SCHEDULES: readonly PlatformFeeSchedule[] = [];

/** The schedule in force at `at`, or `undefined` when none is (the fail-closed answer). */
export function activePlatformFeeSchedule(
  at: number = Date.now(),
  schedules: readonly PlatformFeeSchedule[] = PLATFORM_FEE_SCHEDULES,
): PlatformFeeSchedule | undefined {
  let active: PlatformFeeSchedule | undefined;
  for (const schedule of schedules.map((entry) => platformFeeScheduleSchema.parse(entry))) {
    if (Date.parse(schedule.effectiveFrom) > at) continue;
    if (
      active === undefined ||
      Date.parse(schedule.effectiveFrom) >= Date.parse(active.effectiveFrom)
    ) {
      active = schedule;
    }
  }
  return active;
}

/**
 * The schedule as the price list a grant is rated at: the fee on `requests`,
 * an explicit zero on every other unit (the provider bills those to the
 * customer).
 */
export function platformFeePriceList(schedule: PlatformFeeSchedule): PriceSnapshotInput {
  return {
    priceVersionId: schedule.feeVersionId,
    currency: schedule.currency,
    unitPrices: USAGE_UNITS.map((unit: UsageUnit) =>
      unit === 'requests'
        ? { unit, amount: schedule.perRequest, per: 1 }
        : { unit, amount: '0.000000000000', per: 1 },
    ),
  };
}
