/**
 * Inference Ledger Service — reserve → settle → refund, exactly.
 *
 * The implementation of ADR 0009
 * (`docs/adr/0009-usage-reservation-and-settlement.md`). Four properties hold
 * across every function here, and each is structural rather than remembered:
 *
 *  1. **Money arithmetic happens in SQL, never in JavaScript.** Every amount
 *     crosses this module as an exact decimal STRING and is bound back with an
 *     explicit `::numeric` cast. A JS `number` cannot represent `0.1 + 0.2`, and
 *     an inference ledger adds millions of small amounts. `postgres.js` decoding
 *     `numeric` as a string is a feature here: accidental float arithmetic fails
 *     loudly rather than silently losing precision.
 *
 *  2. **Every call is idempotent on a caller-supplied key**, implemented as
 *     `ON CONFLICT … DO NOTHING RETURNING` — never as catch-the-duplicate. A
 *     duplicate key and a dropped connection are indistinguishable inside a
 *     `catch`, so an exception handler would answer "already settled" to an
 *     infrastructure failure. A repeated call returns the original outcome and
 *     writes nothing new.
 *
 *  3. **`account_balances` is the serialization point.** Every mutating path
 *     opens with `SELECT … FOR UPDATE` on that row before it reads anything it
 *     will decide on. Two concurrent reserves for one account therefore queue on
 *     a row lock, and the loser re-reads the committed balance rather than
 *     deciding against a stale one.
 *
 *  4. **Settled history is append-only.** A correction is a compensating record
 *     — a `usage_refunds` row, or a supplementary receipt naming
 *     `corrects_receipt_id`. The database enforces it (`ledgerImmutability.ts`);
 *     this module never issues an UPDATE against a receipt, a refund or a ledger
 *     entry.
 *
 * ## Who calls this
 *
 * `reserve` and `settle` are called by the public API edge (#972 workstream 4,
 * `inferenceEdge.service.ts`), which reserves before forwarding and settles on
 * the usage report. `expireReservations` is called by `server.ts` on
 * `RESERVATION_EXPIRY_SWEEP_INTERVAL_MS` and by nothing else — it is the whole
 * of the release path for a hold whose request never came back, so an
 * unscheduled sweep is not untidy housekeeping but money withheld for good
 * (issue #1015).
 *
 * ## Where this module deliberately REFUSES rather than guesses
 *
 * `settle` returns `settlement-exceeds-reservation` when the exact charge comes
 * out above the hold that authorised it, and writes nothing. Both alternatives
 * are worse: capping the charge at the hold makes the receipt's own arithmetic
 * disagree with its price snapshot, and charging past the hold is precisely the
 * unreserved execution ADR 0009 exists to prevent. The hold is left `held` and
 * is released by `expireReservations` at its deadline, so the customer's money
 * comes back on its own while the discrepancy is loud.
 */

import { and, eq, lte, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { INFERENCE_MONEY_SCALE, type UsageUnit } from '@oxyhq/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { accountBalances } from '../db/schema/accountBalances';
import {
  billingLedgerEntries,
  billingLedgerPostings,
  RESERVATION_DRAW_ORDER,
  type LedgerAccount,
  type LedgerActor,
  type LedgerEntryKind,
  type StaffLedgerActor,
} from '../db/schema/billingLedgerEntries';
import { billingExternalPayments } from '../db/schema/billingExternalPayments';
import { billingProfiles, type BillingMode } from '../db/schema/billingProfiles';
import { usageUnitColumnValues } from '../db/schema/ledgerColumns';
import { priceVersions, priceVersionUnitPrices } from '../db/schema/priceVersions';
import { usageReceipts, usageReceiptUnitPrices } from '../db/schema/usageReceipts';
import { usageRefunds } from '../db/schema/usageRefunds';
import { usageReservations } from '../db/schema/usageReservations';
import {
  evaluateSpendingLimits,
  type SpendingLimitVerdict,
} from './spendingLimit.service';
import type {
  ExternalPaymentKind,
  ExternalPaymentProvider,
  InferenceEnvironment,
} from '@oxyhq/contracts';
import type { InferenceRequestOutcome, UsageSource } from '@oxyhq/contracts';
import type { UsageRefundReason } from '@oxyhq/contracts';

/** The rounding scale of every computed amount, as a SQL literal. */
const MONEY_SCALE = sql.raw(String(INFERENCE_MONEY_SCALE));

/** Millisecond-precision `now()`, matching the schema's timestamp convention. */
const NOW = sql`date_trunc('milliseconds', now())`;

/**
 * The ADR 0007 tuple, as this module needs it. `userId` is attribution and never
 * appears in a balance check — removing it from a request must not change what
 * any account is charged, which is the rule a reviewer applies here.
 */
export interface LedgerAttribution {
  /** `applications.owner_account_id`. The workload's account, not the payer's. */
  readonly accountId: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly delegatedUserId?: string;
  readonly requestId: string;
  readonly environment: InferenceEnvironment;
}

/** A per-bucket split of one amount, in {@link RESERVATION_DRAW_ORDER}. */
interface DrawSplit {
  readonly promotionalFunds: string;
  readonly purchasedFunds: string;
  readonly invoiceReceivable: string;
}

interface DrawRow extends Record<string, unknown> {
  promotional: string;
  purchased: string;
  receivable: string;
  sufficient: boolean;
  available: string;
}

// ===========================================================================
// Billing profiles and balances
// ===========================================================================

export interface BillingAccount {
  readonly accountId: string;
  readonly currency: string;
  readonly billingMode: BillingMode;
  readonly creditLimit: string;
}

export type BillingAccountResolution =
  | { readonly status: 'resolved'; readonly billingAccount: BillingAccount }
  | { readonly status: 'not-provisioned'; readonly accountId: string };

/**
 * Which account actually pays for a workload owned by `accountId`.
 *
 * The rule argued in `billingProfiles.ts`: an account draws on the NEAREST
 * ancestor (including itself) that has a billing profile, so a project shares
 * its organization's balance unless it has been given one of its own. Walked
 * over `user_ancestors`, the same materialised path `resolveEffectiveMembership`
 * uses — billing inheritance and permission inheritance read one tree.
 *
 * `not-provisioned` is a value the caller must handle, never an `undefined` that
 * reads as zero: a zero balance means "spent everything" and an absent profile
 * means "nobody has decided who pays for this account yet". That distinction is
 * the audit's §6 finding, and collapsing it is how an organization's traffic
 * gets billed to nobody.
 *
 * ## READ THIS BEFORE BUILDING A READER ON TOP OF IT
 *
 * **This walk filters `status = 'active'`, and that is correct for SPENDING and
 * wrong for READING.** A suspended profile may not be drawn from, and an account
 * must not silently start drawing on a suspended ancestor — so the filter
 * belongs here.
 *
 * But a READER that reaches for this function inherits the filter, and a
 * suspended account then comes back `not-provisioned`. Those are different facts
 * with different fixes: "you are suspended" is a state the customer can have
 * lifted, "nobody has decided who pays for you" is an account nobody has
 * provisioned. The entitlement interface turns the second into "this account
 * cannot be charged at all" and hands it to Alia across a repository boundary —
 * a wrong answer that looks exactly like a correct one.
 *
 * This is a property of the WALK, not a slip: it appeared independently in two
 * readers written by different people (`resolveAccountBillingState` and
 * `readAccountBalance`), because both did the obvious thing and called this.
 * Both now load an account's OWN profile directly, at any status, and fall back
 * to this walk only for the INHERITED case. A third reader must do the same, and
 * `accountBilling.service.test.ts` gates both existing ones.
 */
export async function resolveBillingAccount(
  db: DatabaseOrTransaction,
  accountId: string
): Promise<BillingAccountResolution> {
  if (!accountId) {
    return { status: 'not-provisioned', accountId };
  }

  const rows = await executeRows<{
    account_id: string;
    currency: string;
    billing_mode: BillingMode;
    credit_limit: string;
  }>(
    db,
    sql`
      select account_id, currency, billing_mode, credit_limit::text as credit_limit
      from (
        select bp.account_id, bp.currency, bp.billing_mode, bp.credit_limit,
               true as is_self, 0 as depth
        from ${billingProfiles} bp
        where bp.account_id = ${accountId} and bp.status = 'active'
        union all
        select bp.account_id, bp.currency, bp.billing_mode, bp.credit_limit,
               false as is_self, ua.depth
        from ${billingProfiles} bp
        join user_ancestors ua
          on ua.ancestor_id = bp.account_id and ua.user_id = ${accountId}
        where bp.status = 'active'
      ) candidate
      -- Nearest first: the account itself, then the DEEPEST ancestor, which is
      -- the immediate parent (user_ancestors is ordered root-first by depth).
      order by is_self desc, depth desc
      limit 1
    `
  );

  const row = rows[0];
  if (!row) {
    return { status: 'not-provisioned', accountId };
  }
  return {
    status: 'resolved',
    billingAccount: {
      accountId: row.account_id,
      currency: row.currency,
      billingMode: row.billing_mode,
      creditLimit: row.credit_limit,
    },
  };
}

export interface ProvisionBillingProfileInput {
  readonly accountId: string;
  readonly currency?: string;
  readonly billingMode?: BillingMode;
  /** Only meaningful for `invoiced`. Exact decimal string. */
  readonly creditLimit?: string;
}

/**
 * Give an account a billing profile and a zeroed balance, idempotently.
 *
 * This is what closes the audit's §6 gap: before it, a row could only come into
 * existence for an account somebody held a session AS, which made an
 * organization billable only by accident and a `channel` account billable never.
 * The profile and the balance are created TOGETHER, in one transaction, so
 * "has a profile" and "has a balance row to lock" can never disagree — every
 * mutating path below locks the balance row first and would otherwise have to
 * decide what an unlockable profile means.
 */
export async function provisionBillingProfile(
  input: ProvisionBillingProfileInput
): Promise<BillingAccount> {
  return getDb().transaction(async (tx) => {
    await tx
      .insert(billingProfiles)
      .values({
        accountId: input.accountId,
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.billingMode === undefined ? {} : { billingMode: input.billingMode }),
        ...(input.creditLimit === undefined ? {} : { creditLimit: input.creditLimit }),
      })
      .onConflictDoNothing();

    const [profile] = await tx
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.accountId, input.accountId))
      .limit(1);

    if (!profile) {
      throw new Error(
        `billing profile for account ${input.accountId} vanished between insert and read`
      );
    }

    await tx
      .insert(accountBalances)
      .values({ accountId: profile.accountId, currency: profile.currency })
      .onConflictDoNothing();

    return {
      accountId: profile.accountId,
      currency: profile.currency,
      billingMode: profile.billingMode,
      creditLimit: profile.creditLimit,
    };
  });
}

export interface AccountBalanceView {
  readonly accountId: string;
  readonly currency: string;
  readonly purchasedBalance: string;
  readonly promotionalBalance: string;
  readonly reservedBalance: string;
  readonly invoicedOutstanding: string;
}

/** Read an account's projected balance. Never provisions one. */
export async function getAccountBalance(
  db: DatabaseOrTransaction,
  accountId: string,
  currency: string
): Promise<AccountBalanceView | null> {
  const [row] = await db
    .select()
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, currency)))
    .limit(1);
  if (!row) return null;
  return {
    accountId: row.accountId,
    currency: row.currency,
    purchasedBalance: row.purchasedBalance,
    promotionalBalance: row.promotionalBalance,
    reservedBalance: row.reservedBalance,
    invoicedOutstanding: row.invoicedOutstanding,
  };
}

// ===========================================================================
// Funding
// ===========================================================================

/**
 * The processor charge behind a top-up, recorded in the SAME transaction as the
 * money it funded.
 *
 * Optional, because not every credit comes from a processor — a promotional
 * grant has no charge behind it, and a manual correction is booked by hand. When
 * it IS present the row is written inside this transaction rather than after it,
 * so "the balance moved" and "here is the charge that moved it" can never
 * disagree. That pairing is what a reconciliation pass compares, and a
 * reconciliation built on two writes that might not both have landed would
 * report drift it caused itself.
 */
export interface ExternalPaymentRecord {
  readonly provider: ExternalPaymentProvider;
  readonly externalKind: ExternalPaymentKind;
  /** The processor's own id — a payment intent or an invoice. */
  readonly externalRef: string;
  /** When the processor says the money moved, not when Oxy heard about it. */
  readonly occurredAt: Date;
}

export interface FundingInput {
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly currency: string;
  /** Exact decimal string, strictly positive. */
  readonly amount: string;
  readonly externalPayment?: ExternalPaymentRecord;
  /** Who authored the entry. See {@link EntryInput.actor}. */
  readonly actor: LedgerActor;
}

/**
 * A grant, whose author is narrower than a funding entry's in general.
 *
 * `actor` is a {@link StaffLedgerActor} rather than a {@link LedgerActor}: the
 * only route that issues promotional credit is staff-gated, and a grant is the
 * one entry that creates customer balance out of nothing. A machine-authored one
 * would be money appearing with nobody accountable for it, so it is refused by
 * the type rather than by review. An automated grant — a signup bonus, say — is
 * a real product decision, and widening this type is where it should have to be
 * made.
 */
export interface PromotionalGrantFundingInput extends Omit<FundingInput, 'actor'> {
  readonly actor: StaffLedgerActor;
}

export type FundingResult =
  | { readonly status: 'recorded'; readonly entryId: string }
  | { readonly status: 'already-recorded'; readonly entryId: string }
  | { readonly status: 'no-billing-profile'; readonly accountId: string };

/**
 * Money arriving from the payment processor lands in `purchased_funds`.
 *
 * Stripe reconciliation calls this; Stripe itself is never the balance
 * authority. Idempotent on the processor's own event id, which is what makes a
 * redelivered webhook a no-op rather than a second grant.
 */
export function recordTopUp(input: FundingInput): Promise<FundingResult> {
  return recordFunding(input, 'top_up', 'external_settlement', 'purchased_funds');
}

/**
 * A grant lands in `promotional_funds`, never in `purchased_funds`.
 *
 * Kept separate because the two are not the same money: granted credit may
 * expire and is never refundable, and it is spent FIRST — see
 * `RESERVATION_DRAW_ORDER`.
 */
export function recordPromotionalGrant(
  input: PromotionalGrantFundingInput
): Promise<FundingResult> {
  return recordFunding(input, 'promotional_grant', 'promotional_issuance', 'promotional_funds');
}

async function recordFunding(
  input: FundingInput,
  kind: LedgerEntryKind,
  source: LedgerAccount,
  destination: LedgerAccount
): Promise<FundingResult> {
  return getDb().transaction(async (tx) => {
    const locked = await lockBalance(tx, input.accountId, input.currency);
    if (!locked) {
      return { status: 'no-billing-profile', accountId: input.accountId };
    }

    const existing = await findEntryByKey(tx, input.idempotencyKey);
    if (existing) {
      // Self-healing rather than a bare early return: a process that crashed
      // between the journal entry and the external-payment row would otherwise
      // leave a permanent, self-inflicted reconciliation discrepancy that no
      // redelivery could repair, because the entry key is already claimed.
      await recordExternalPayment(tx, input, existing);
      return { status: 'already-recorded', entryId: existing };
    }

    const entryId = await writeEntry(tx, {
      idempotencyKey: input.idempotencyKey,
      accountId: input.accountId,
      currency: input.currency,
      kind,
      // Passed through from the caller, never chosen here: a top-up is authored
      // by the processor's webhook and a grant by a named staff member, and this
      // function serves both.
      actor: input.actor,
      postings: [{ source, destination, amount: input.amount }],
    });

    await recordExternalPayment(tx, input, entryId);

    const column =
      destination === 'purchased_funds'
        ? accountBalances.purchasedBalance
        : accountBalances.promotionalBalance;
    await tx.execute(sql`
      update ${accountBalances}
      set ${sql.raw(destination === 'purchased_funds' ? 'purchased_balance' : 'promotional_balance')}
            = ${column} + ${input.amount}::numeric,
          updated_at = ${NOW}
      where ${accountBalances.accountId} = ${input.accountId}
        and ${accountBalances.currency} = ${input.currency}
    `);

    return { status: 'recorded', entryId };
  });
}

/**
 * Link a processor charge to the journal entry it produced.
 *
 * `ON CONFLICT DO NOTHING` on `(provider, external_ref)`, never a caught
 * duplicate-key error: a duplicate key and a dropped connection are
 * indistinguishable inside a `catch`, so an exception handler would answer
 * "already linked" to an infrastructure failure.
 */
async function recordExternalPayment(
  tx: DatabaseOrTransaction,
  input: FundingInput,
  ledgerEntryId: string
): Promise<void> {
  const payment = input.externalPayment;
  if (payment === undefined) return;

  await tx
    .insert(billingExternalPayments)
    .values({
      accountId: input.accountId,
      currency: input.currency,
      provider: payment.provider,
      externalKind: payment.externalKind,
      externalRef: payment.externalRef,
      amount: input.amount,
      ledgerEntryId,
      occurredAt: payment.occurredAt,
    })
    .onConflictDoNothing();
}

// ===========================================================================
// Spendable room
// ===========================================================================

/**
 * How much more this account can reserve right now — the REFERENCE answer.
 *
 * Expressed as {@link computeDraw} against a zero amount rather than as its own
 * SQL, so it IS the expression that decides whether a request is refused, read
 * for its `available` term rather than reimplemented.
 *
 * ## Its only caller is a test, and that is the job
 *
 * Two production paths spell the same rule out in their own SQL because each
 * needs a different shape of query: `findAutoRechargeCandidates` scans every
 * enabled profile in one statement, and `readAccountBalance`
 * (`inferenceReporting.service.ts`) returns a bucket per currency. Neither can
 * call this without becoming N round trips or losing its per-currency rows.
 *
 * So this exists to be the thing they are CHECKED AGAINST —
 * `accountBilling.service.test.ts` asserts all three agree, on a fixture that
 * exercises the invoiced branch where the credit line is the whole difference.
 * Deleting it as unused would delete the gate, and the drift it guards
 * (a customer refused with money apparently in hand) is invisible until it
 * happens.
 */
export async function getAvailableToSpend(
  db: DatabaseOrTransaction,
  billing: BillingAccount
): Promise<string> {
  const draw = await computeDraw(db, billing, '0');
  return draw.available;
}

// ===========================================================================
// Quoting
// ===========================================================================

export type QuoteResult =
  | { readonly status: 'quoted'; readonly amount: string; readonly currency: string }
  | { readonly status: 'unknown-price-version'; readonly priceVersionId: string }
  | {
      readonly status: 'unpriced-units';
      readonly priceVersionId: string;
      readonly unpricedUnits: number;
    };

/**
 * What a set of metered units costs under one price version.
 *
 * Exposed so the public edge can size a HOLD with the same arithmetic
 * {@link settle} charges with — the ceiling and the eventual bill are then two
 * evaluations of one expression rather than two implementations that agree until
 * a price shape changes. It performs no write and takes no lock; it is a read,
 * and a reservation still has to be taken through {@link reserve}.
 *
 * `unpriced-units` is returned rather than a silently-dropped term, exactly as
 * in `settle`: a unit the request can consume but the version does not price is
 * a hold that under-covers the charge, which is the one direction that lets a
 * request execute unreserved.
 */
export async function quoteUnits(
  priceVersionId: string,
  units: Partial<Record<UsageUnit, number>>
): Promise<QuoteResult> {
  const db = getDb();

  const [version] = await db
    .select({ currency: priceVersions.currency })
    .from(priceVersions)
    .where(eq(priceVersions.id, priceVersionId))
    .limit(1);
  if (!version) {
    return { status: 'unknown-price-version', priceVersionId };
  }

  const charge = await computeCharge(db, priceVersionId, units);
  if (charge.unpricedUnits > 0) {
    return { status: 'unpriced-units', priceVersionId, unpricedUnits: charge.unpricedUnits };
  }
  return { status: 'quoted', amount: charge.amount, currency: version.currency };
}

// ===========================================================================
// Reserve
// ===========================================================================

export interface ReserveInput {
  readonly idempotencyKey: string;
  readonly attribution: LedgerAttribution;
  /** Units already determined by the request itself, e.g. input tokens. */
  readonly knownUnits?: Partial<Record<UsageUnit, number>>;
  readonly maxOutputTokens?: number;
  /** The price version of the most expensive route the policy permits. */
  readonly ceilingPriceVersionId: string;
  /** The ceiling. Exact decimal string, strictly positive. */
  readonly maxAmount: string;
  readonly currency: string;
  readonly expiresInSeconds: number;
}

export interface ReservationView {
  readonly reservationId: string;
  readonly billingAccountId: string;
  readonly reservedAmount: string;
  readonly currency: string;
  readonly expiresAt: Date;
}

export type ReserveResult =
  | {
      readonly status: 'reserved';
      readonly reservation: ReservationView;
      readonly softStopsPassed: readonly SpendingLimitVerdict[];
    }
  | { readonly status: 'already-reserved'; readonly reservation: ReservationView }
  | { readonly status: 'no-billing-profile'; readonly accountId: string }
  | { readonly status: 'currency-mismatch'; readonly expected: string; readonly received: string }
  | {
      readonly status: 'insufficient-funds';
      readonly available: string;
      readonly required: string;
      readonly currency: string;
    }
  | { readonly status: 'spending-limit-exceeded'; readonly limit: SpendingLimitVerdict };

/**
 * Hold the maximum a request could cost, before anything is forwarded.
 *
 * The order of the steps inside the transaction is load-bearing:
 *
 *  1. lock the balance row — the serialization point;
 *  2. only THEN look for an existing reservation with this key, so the read is
 *     fresh. Checking before the lock would let a retry arriving while the
 *     original is still committing be answered `insufficient-funds`, which is a
 *     wrong answer to a request that IS reserved;
 *  3. evaluate spending limits;
 *  4. compute the draw and refuse if it does not cover the hold;
 *  5. write the reservation, the journal entry and the projection.
 */
export async function reserve(input: ReserveInput): Promise<ReserveResult> {
  return getDb().transaction(async (tx): Promise<ReserveResult> => {
    const resolution = await resolveBillingAccount(tx, input.attribution.accountId);
    if (resolution.status === 'not-provisioned') {
      return { status: 'no-billing-profile', accountId: input.attribution.accountId };
    }
    const billing = resolution.billingAccount;

    if (billing.currency !== input.currency) {
      return { status: 'currency-mismatch', expected: billing.currency, received: input.currency };
    }

    const locked = await lockBalance(tx, billing.accountId, billing.currency);
    if (!locked) {
      return { status: 'no-billing-profile', accountId: billing.accountId };
    }

    const existing = await findReservationByKey(tx, input.idempotencyKey);
    if (existing) {
      return { status: 'already-reserved', reservation: existing };
    }

    const limits = await evaluateSpendingLimits(
      tx,
      {
        accountId: input.attribution.accountId,
        applicationId: input.attribution.applicationId,
        applicationCredentialId: input.attribution.applicationCredentialId,
      },
      billing.currency,
      input.maxAmount
    );
    if (limits.status === 'exceeded') {
      return { status: 'spending-limit-exceeded', limit: limits.limit };
    }

    const draw = await computeDraw(tx, billing, input.maxAmount);
    if (!draw.sufficient) {
      return {
        status: 'insufficient-funds',
        available: draw.available,
        required: input.maxAmount,
        currency: billing.currency,
      };
    }

    const [reservation] = await tx
      .insert(usageReservations)
      .values({
        idempotencyKey: input.idempotencyKey,
        accountId: billing.accountId,
        applicationId: input.attribution.applicationId,
        applicationCredentialId: input.attribution.applicationCredentialId,
        delegatedUserId: input.attribution.delegatedUserId,
        requestId: input.attribution.requestId,
        environment: input.attribution.environment,
        reservedAmount: input.maxAmount,
        currency: billing.currency,
        ceilingPriceVersionId: input.ceilingPriceVersionId,
        maxOutputTokens: input.maxOutputTokens,
        ...usageUnitColumnValues(input.knownUnits ?? {}),
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      })
      .onConflictDoNothing()
      .returning();

    if (!reservation) {
      // Lost a race against an identical key on ANOTHER account's balance row,
      // which this transaction's lock does not cover. Nothing was written.
      const raced = await findReservationByKey(tx, input.idempotencyKey);
      if (!raced) {
        throw new Error(
          `reservation ${input.idempotencyKey} conflicted but could not be read back`
        );
      }
      return { status: 'already-reserved', reservation: raced };
    }

    await writeEntry(tx, {
      idempotencyKey: `reserve:${input.idempotencyKey}`,
      accountId: billing.accountId,
      currency: billing.currency,
      kind: 'reservation_hold',
      reservationId: reservation.id,
      // No person authors a hold: the inference edge places it while forwarding
      // a request. Whose workload it was is on the reservation itself, which
      // this entry names.
      actor: { kind: 'machine' },
      postings: drawPostings(draw.split, 'hold'),
    });

    await tx.execute(sql`
      update ${accountBalances}
      set promotional_balance = ${accountBalances.promotionalBalance} - ${draw.split.promotionalFunds}::numeric,
          purchased_balance = ${accountBalances.purchasedBalance} - ${draw.split.purchasedFunds}::numeric,
          invoiced_outstanding = ${accountBalances.invoicedOutstanding} + ${draw.split.invoiceReceivable}::numeric,
          reserved_balance = ${accountBalances.reservedBalance} + ${input.maxAmount}::numeric,
          updated_at = ${NOW}
      where ${accountBalances.accountId} = ${billing.accountId}
        and ${accountBalances.currency} = ${billing.currency}
    `);

    return {
      status: 'reserved',
      reservation: {
        reservationId: reservation.id,
        billingAccountId: billing.accountId,
        reservedAmount: reservation.reservedAmount,
        currency: reservation.currency,
        expiresAt: reservation.expiresAt,
      },
      softStopsPassed: limits.softStopsPassed,
    };
  });
}

// ===========================================================================
// Settle
// ===========================================================================

export interface SettleInput {
  readonly idempotencyKey: string;
  /** Absent for a charge with no hold — shadow metering, or a BYOK fee. */
  readonly reservationId?: string;
  readonly attribution: LedgerAttribution;
  readonly generationId?: string;
  readonly outcome: InferenceRequestOutcome;
  readonly usageSource: UsageSource;
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly resolvedModelReference: string;
  readonly servingProvider: string;
  /** The version the charge is computed from AND snapshotted onto the receipt. */
  readonly priceVersionId: string;
  /**
   * The routing policy revision this request executed under (#972 workstream 6).
   *
   * OPTIONAL, because the caller that always has one is the public inference
   * edge, which does not exist yet; today's callers are ledger and
   * shadow-metering paths with no request envelope to read it from. It is
   * threaded here rather than added later because `usage_receipts` is
   * append-only — a receipt written without it can never be corrected to carry
   * one, so the parameter has to exist before the first real receipt does.
   */
  readonly routingPolicyVersionId?: string;
  readonly platformFeeOnly?: boolean;
  readonly settledAt?: Date;
  /** A supplementary receipt correcting an earlier one upward. */
  readonly correctsReceiptId?: string;
}

export interface ReceiptView {
  readonly receiptId: string;
  readonly billedAmount: string;
  readonly currency: string;
}

export type SettleResult =
  | {
      readonly status: 'settled';
      readonly receipt: ReceiptView;
      readonly releasedAmount: string;
      readonly refundId: string | null;
    }
  | { readonly status: 'already-settled'; readonly receipt: ReceiptView }
  | { readonly status: 'unknown-reservation'; readonly reservationId: string }
  | { readonly status: 'reservation-not-held'; readonly reservationId: string; readonly reservationStatus: string }
  | { readonly status: 'no-billing-profile'; readonly accountId: string }
  | {
      readonly status: 'unpriced-units';
      readonly priceVersionId: string;
      readonly unpricedUnits: number;
    }
  | {
      readonly status: 'settlement-exceeds-reservation';
      readonly billedAmount: string;
      readonly reservedAmount: string;
    }
  | {
      /**
       * A `completed` request that metered nothing (#972 §7.3). REFUSED, never
       * estimated — see {@link settle}'s "A completed request consumed something".
       */
      readonly status: 'zero-usage';
      /**
       * How many unit keys the report carried, every one of them zero.
       *
       * `0` means the report named no units at all; a positive number means it
       * named units and reported zero for each. Both are refused, and the
       * difference is what tells an operator whether the provider omitted the
       * usage block or filled it with zeros — two different upstream bugs with
       * the same effect on a bill.
       */
      readonly reportedUnitKeys: number;
    }
  | {
      readonly status: 'insufficient-funds';
      readonly available: string;
      readonly required: string;
      readonly currency: string;
    };

/**
 * Settle a request against its exact normalized usage, and release the rest of
 * its hold in the SAME transaction.
 *
 * ADR 0009: "a settlement that does not also release the remainder of its
 * reservation is an incomplete write, not a partial success". The release is
 * therefore not a later step that could be missed — it is written here or the
 * settlement does not commit at all.
 *
 * The charge is computed IN SQL from the price version's unit prices, and a unit
 * that was metered but has no price in that version is refused rather than
 * silently dropped by the join. A join that quietly omits an unpriced unit
 * undercharges, and undercharging is the failure that looks like everything
 * working.
 *
 * ## A completed request consumed something: refuse, never estimate (#972 §7.3)
 *
 * A `completed` outcome carrying no metered units is refused with
 * `zero-usage`. Nothing is written — no receipt, no refund, no journal entry —
 * so the hold stands and the sweeper returns the customer's money on its own,
 * while the caller's existing loud branch makes the provider bug visible.
 *
 * The alternative was to estimate and charge, and the trade is not symmetric.
 * Refusing costs OXY the upstream spend on a rare provider bug. Estimating costs
 * the CUSTOMER money nobody can reconcile afterwards, which is the case
 * `usageReceipts`' own header already refuses: "an estimate indistinguishable
 * from a reported figure is one nobody can reconcile". So the loss is taken on
 * the side that can absorb it and can see it.
 *
 * **`failed`, `cancelled` and `partial` with zero units still settle at zero, and
 * must keep doing so.** Nothing was delivered, so zero is the correct charge, and
 * a zero-unit receipt is how ADR 0009 records an upstream failure that produced
 * nothing. The bug is specifically a request that claims to have COMPLETED and
 * accounts for nothing.
 *
 * This is the api-side half of a guarantee whose other half is on the wire.
 * `inferenceUsageReportSchema` now refuses `completed` with an EMPTY unit array,
 * so that shape is unrepresentable — but `usageQuantitySchema` allows
 * `quantity: 0`, so `[{ unit: 'input_tokens', quantity: 0 }]` still validates and
 * still arrives here as zero usage. The schema closes "no units"; this closes
 * "units that sum to zero", and only the pair closes the free request.
 */
export async function settle(input: SettleInput): Promise<SettleResult> {
  return getDb().transaction(async (tx): Promise<SettleResult> => {
    const resolution = await resolveBillingAccount(tx, input.attribution.accountId);
    if (resolution.status === 'not-provisioned') {
      return { status: 'no-billing-profile', accountId: input.attribution.accountId };
    }
    const billing = resolution.billingAccount;

    const locked = await lockBalance(tx, billing.accountId, billing.currency);
    if (!locked) {
      return { status: 'no-billing-profile', accountId: billing.accountId };
    }

    const existing = await findReceiptByKey(tx, input.idempotencyKey);
    if (existing) {
      return { status: 'already-settled', receipt: existing };
    }

    /*
     * Ordered deliberately: AFTER the idempotency read, so a retry of a
     * settlement that already succeeded still answers `already-settled` rather
     * than re-litigating its usage, and BEFORE `computeCharge`, because a refusal
     * that needs no query should not run one.
     */
    if (input.outcome === 'completed' && totalMeteredUnits(input.units) === 0) {
      return { status: 'zero-usage', reportedUnitKeys: Object.keys(input.units).length };
    }

    const charge = await computeCharge(tx, input.priceVersionId, input.units);
    if (charge.unpricedUnits > 0) {
      return {
        status: 'unpriced-units',
        priceVersionId: input.priceVersionId,
        unpricedUnits: charge.unpricedUnits,
      };
    }

    let reservation: typeof usageReservations.$inferSelect | undefined;
    let heldSplit: DrawSplit | undefined;

    if (input.reservationId !== undefined) {
      const [row] = await tx
        .select()
        .from(usageReservations)
        .where(eq(usageReservations.id, input.reservationId))
        .limit(1);
      if (!row) {
        return { status: 'unknown-reservation', reservationId: input.reservationId };
      }
      if (row.status !== 'held') {
        return {
          status: 'reservation-not-held',
          reservationId: row.id,
          reservationStatus: row.status,
        };
      }
      reservation = row;
      heldSplit = await readHoldSplit(tx, row.id);

      if (await exceedsHold(tx, charge.amount, row.reservedAmount)) {
        return {
          status: 'settlement-exceeds-reservation',
          billedAmount: charge.amount,
          reservedAmount: row.reservedAmount,
        };
      }
    }

    // With no hold, the charge is drawn straight from the balance and has to
    // clear the same sufficiency test a reservation would have applied.
    let directDraw: DrawSplit | undefined;
    if (reservation === undefined) {
      const draw = await computeDraw(tx, billing, charge.amount);
      if (!draw.sufficient) {
        return {
          status: 'insufficient-funds',
          available: draw.available,
          required: charge.amount,
          currency: billing.currency,
        };
      }
      directDraw = draw.split;
    }

    const [receipt] = await tx
      .insert(usageReceipts)
      .values({
        idempotencyKey: input.idempotencyKey,
        reservationId: reservation?.id,
        correctsReceiptId: input.correctsReceiptId,
        accountId: billing.accountId,
        applicationId: input.attribution.applicationId,
        applicationCredentialId: input.attribution.applicationCredentialId,
        delegatedUserId: input.attribution.delegatedUserId,
        requestId: input.attribution.requestId,
        generationId: input.generationId,
        environment: input.attribution.environment,
        outcome: input.outcome,
        usageSource: input.usageSource,
        ...usageUnitColumnValues(input.units),
        resolvedModelReference: input.resolvedModelReference,
        servingProvider: input.servingProvider,
        routingPolicyVersionId: input.routingPolicyVersionId,
        priceVersionId: input.priceVersionId,
        billedAmount: charge.amount,
        currency: billing.currency,
        platformFeeOnly: input.platformFeeOnly ?? false,
        settledAt: input.settledAt ?? new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (!receipt) {
      const raced = await findReceiptByKey(tx, input.idempotencyKey);
      if (!raced) {
        throw new Error(`receipt ${input.idempotencyKey} conflicted but could not be read back`);
      }
      return { status: 'already-settled', receipt: raced };
    }

    // The price SNAPSHOT: a copy, so the receipt's arithmetic is checkable
    // without the price version still existing.
    await tx.execute(sql`
      insert into ${usageReceiptUnitPrices} (receipt_id, unit, amount, per, created_at)
      select ${receipt.id}, p.unit, p.amount, p.per, ${NOW}
      from ${priceVersionUnitPrices} p
      where p.price_version_id = ${input.priceVersionId}
    `);

    if (reservation !== undefined && heldSplit !== undefined) {
      const split = await splitHold(tx, heldSplit, charge.amount);
      const releasedAmount = await subtract(tx, reservation.reservedAmount, charge.amount);

      await writeEntry(tx, {
        idempotencyKey: `settle:${input.idempotencyKey}`,
        accountId: billing.accountId,
        currency: billing.currency,
        kind: 'settlement',
        reservationId: reservation.id,
        receiptId: receipt.id,
        // The usage report settles it, not a person. The receipt carries the
        // application, credential and request the charge came from.
        actor: { kind: 'machine' },
        postings:
          charge.amount === '0' || (await isZero(tx, charge.amount))
            ? []
            : [
                {
                  source: 'reserved_funds',
                  destination: 'platform_revenue',
                  amount: charge.amount,
                },
              ],
      });

      let refundId: string | null = null;
      if (!(await isZero(tx, releasedAmount))) {
        const [refund] = await tx
          .insert(usageRefunds)
          .values({
            idempotencyKey: `release:${input.idempotencyKey}`,
            accountId: billing.accountId,
            requestId: input.attribution.requestId,
            subjectKind: 'reservation',
            reservationId: reservation.id,
            reason: releaseReason(input.outcome, input.usageSource),
            amount: releasedAmount,
            currency: billing.currency,
          })
          .returning();
        refundId = refund.id;

        await writeEntry(tx, {
          idempotencyKey: `release:${input.idempotencyKey}`,
          accountId: billing.accountId,
          currency: billing.currency,
          kind: 'reservation_release',
          reservationId: reservation.id,
          refundId: refund.id,
          // The unused half of a hold, returned by the same settlement.
          actor: { kind: 'machine' },
          postings: releasePostings(split.released),
        });
      }

      await tx
        .update(usageReservations)
        .set({ status: 'settled' })
        .where(eq(usageReservations.id, reservation.id));

      await applySettlementBalance(tx, billing, {
        reservedDelta: reservation.reservedAmount,
        released: split.released,
      });

      return {
        status: 'settled',
        receipt: {
          receiptId: receipt.id,
          billedAmount: receipt.billedAmount,
          currency: receipt.currency,
        },
        releasedAmount,
        refundId,
      };
    }

    // No reservation: the charge leaves the customer's buckets directly.
    const draw = directDraw ?? { promotionalFunds: '0', purchasedFunds: '0', invoiceReceivable: '0' };
    await writeEntry(tx, {
      idempotencyKey: `settle:${input.idempotencyKey}`,
      accountId: billing.accountId,
      currency: billing.currency,
      kind: 'settlement',
      receiptId: receipt.id,
      // Same author as the held settlement above — shadow metering or a BYOK
      // fee, reported by the edge rather than decided by anyone.
      actor: { kind: 'machine' },
      postings: drawPostings(draw, 'revenue'),
    });

    await tx.execute(sql`
      update ${accountBalances}
      set promotional_balance = ${accountBalances.promotionalBalance} - ${draw.promotionalFunds}::numeric,
          purchased_balance = ${accountBalances.purchasedBalance} - ${draw.purchasedFunds}::numeric,
          invoiced_outstanding = ${accountBalances.invoicedOutstanding} + ${draw.invoiceReceivable}::numeric,
          updated_at = ${NOW}
      where ${accountBalances.accountId} = ${billing.accountId}
        and ${accountBalances.currency} = ${billing.currency}
    `);

    return {
      status: 'settled',
      receipt: {
        receiptId: receipt.id,
        billedAmount: receipt.billedAmount,
        currency: receipt.currency,
      },
      releasedAmount: '0',
      refundId: null,
    };
  });
}

// ===========================================================================
// Expiry
// ===========================================================================

export interface ExpiredReservation {
  readonly reservationId: string;
  readonly releasedAmount: string;
}

/**
 * Release every hold whose deadline has passed.
 *
 * ADR 0009: an expiry IS a refund with a reason, never a silent release. Each
 * one writes a `usage_refunds` row and a `reservation_expiry` journal entry, so
 * a released hold is as visible in the ledger as a settled charge.
 *
 * Deliberately NOT an entry in `db/expiry.ts`. Deleting the row would release
 * the money with no record that it happened AND leave
 * `account_balances.reserved_balance` permanently overstated, because the
 * projection is only ever moved by a journal entry.
 *
 * ## Safe to overlap itself
 *
 * `server.ts` schedules this on a fixed interval, so a run slower than the
 * interval is overtaken by the next one and two passes can select the same due
 * hold. Releasing it twice would credit the customer twice, so the guarantee is
 * structural rather than a matter of the runs not colliding — three layers, in
 * the order `expireOne` reaches them:
 *
 *  1. `lockBalance` takes `SELECT … FOR UPDATE` on the account's balance row
 *     BEFORE any decision is read, so the second pass blocks until the first
 *     commits rather than deciding against a stale status.
 *  2. The status is re-read under that lock and anything not still `held` stops
 *     — which is what the second pass now sees, and is also what stops an
 *     expiry racing a `settle` into refunding a charge.
 *  3. The refund is keyed `expire:<reservationId>` on a UNIQUE column with
 *     `ON CONFLICT DO NOTHING RETURNING`, and a conflict returns before the
 *     journal entry and the balance move. Layer 1 makes this unreachable today;
 *     it is what stops a future reordering from turning a lock into the only
 *     thing between a customer and a double credit.
 *
 * All three are exercised in `inferenceLedger.service.test.ts`, and a fourth
 * sits under them: `account_balances_reserved_check` (`>= 0`) means a second
 * release of one hold drives `reserved_balance` negative and the statement is
 * REFUSED. Measured, by defeating layers 2 and 3 together — so the worst case
 * of this whole path is a failed transaction and a logged error, never a silent
 * double credit.
 */
export async function expireReservations(limit = 100): Promise<ExpiredReservation[]> {
  const due = await getDb()
    .select({ id: usageReservations.id })
    .from(usageReservations)
    .where(and(eq(usageReservations.status, 'held'), lte(usageReservations.expiresAt, new Date())))
    .orderBy(usageReservations.expiresAt)
    .limit(limit);

  const released: ExpiredReservation[] = [];
  for (const row of due) {
    const outcome = await expireOne(row.id);
    if (outcome) released.push(outcome);
  }
  return released;
}

async function expireOne(reservationId: string): Promise<ExpiredReservation | null> {
  return getDb().transaction(async (tx) => {
    const [reservation] = await tx
      .select()
      .from(usageReservations)
      .where(eq(usageReservations.id, reservationId))
      .limit(1);
    if (!reservation) return null;

    const locked = await lockBalance(tx, reservation.accountId, reservation.currency);
    if (!locked) return null;

    // Re-read under the lock: a settle may have taken this hold between the
    // scan and here, and expiring a settled reservation would refund a charge.
    const [current] = await tx
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.id, reservationId))
      .limit(1);
    if (!current || current.status !== 'held') return null;

    const heldSplit = await readHoldSplit(tx, reservationId);

    const [refund] = await tx
      .insert(usageRefunds)
      .values({
        idempotencyKey: `expire:${reservationId}`,
        accountId: reservation.accountId,
        requestId: reservation.requestId,
        subjectKind: 'reservation',
        reservationId,
        reason: 'unused_reservation',
        amount: reservation.reservedAmount,
        currency: reservation.currency,
      })
      .onConflictDoNothing()
      .returning();

    if (!refund) return null;

    await writeEntry(tx, {
      idempotencyKey: `expire:${reservationId}`,
      accountId: reservation.accountId,
      currency: reservation.currency,
      kind: 'reservation_expiry',
      reservationId,
      refundId: refund.id,
      // The expiry sweep, on a timer. Nobody decides that a deadline passed,
      // which is exactly why this must not be an absent actor: an unauthored
      // release and an unrecorded one would then read identically.
      actor: { kind: 'machine' },
      postings: releasePostings(heldSplit),
    });

    await tx
      .update(usageReservations)
      .set({ status: 'expired' })
      .where(eq(usageReservations.id, reservationId));

    await applySettlementBalance(
      tx,
      { accountId: reservation.accountId, currency: reservation.currency },
      { reservedDelta: reservation.reservedAmount, released: heldSplit }
    );

    return { reservationId, releasedAmount: reservation.reservedAmount };
  });
}

// ===========================================================================
// Reversal of a settled charge
// ===========================================================================

export interface ReverseReceiptInput {
  readonly idempotencyKey: string;
  readonly receiptId: string;
  readonly reason: Extract<UsageRefundReason, 'billing_correction' | 'duplicate_charge'>;
  /** Absent means the whole charge. Exact decimal string when partial. */
  readonly amount?: string;
  /**
   * Who decided to reverse the charge. Carried up to the CALLER rather than
   * fixed here: a `billing_correction` is a person's judgement, while an
   * automated duplicate-charge detector would legitimately be machine-authored,
   * and this function has no way to tell the two apart from the inside.
   */
  readonly actor: LedgerActor;
}

export type ReverseReceiptResult =
  | { readonly status: 'reversed'; readonly refundId: string; readonly amount: string }
  | { readonly status: 'already-reversed'; readonly refundId: string }
  | { readonly status: 'unknown-receipt'; readonly receiptId: string }
  | {
      readonly status: 'exceeds-settled-amount';
      readonly requested: string;
      readonly settled: string;
    };

/**
 * Reverse a settled charge by APPENDING a compensating record.
 *
 * The receipt is never touched — it cannot be, the trigger refuses. The money
 * returns to the buckets the settlement consumed, unwound in REVERSE
 * consumption order, so a partial reversal reduces what an invoiced account owes
 * before it credits back prepaid money and credits back promotional money last.
 * Unwinding in the same order it was consumed would inflate the promotional
 * bucket, which is the one that can expire and can never be paid out.
 */
export async function reverseReceipt(
  input: ReverseReceiptInput
): Promise<ReverseReceiptResult> {
  return getDb().transaction(async (tx): Promise<ReverseReceiptResult> => {
    const [receipt] = await tx
      .select()
      .from(usageReceipts)
      .where(eq(usageReceipts.id, input.receiptId))
      .limit(1);
    if (!receipt) {
      return { status: 'unknown-receipt', receiptId: input.receiptId };
    }

    const locked = await lockBalance(tx, receipt.accountId, receipt.currency);
    if (!locked) {
      return { status: 'unknown-receipt', receiptId: input.receiptId };
    }

    const existing = await findRefundByKey(tx, input.idempotencyKey);
    if (existing) {
      return { status: 'already-reversed', refundId: existing };
    }

    const amount = input.amount ?? receipt.billedAmount;
    if (await greaterThan(tx, amount, receipt.billedAmount)) {
      return {
        status: 'exceeds-settled-amount',
        requested: amount,
        settled: receipt.billedAmount,
      };
    }

    const consumed = await readSettlementConsumption(tx, receipt.id, receipt.billedAmount);
    const returned = await splitReverse(tx, consumed, amount);

    const [refund] = await tx
      .insert(usageRefunds)
      .values({
        idempotencyKey: input.idempotencyKey,
        accountId: receipt.accountId,
        requestId: receipt.requestId,
        subjectKind: 'receipt',
        receiptId: receipt.id,
        reason: input.reason,
        amount,
        currency: receipt.currency,
      })
      .returning();

    await writeEntry(tx, {
      idempotencyKey: `reverse:${input.idempotencyKey}`,
      accountId: receipt.accountId,
      currency: receipt.currency,
      kind: 'settlement_reversal',
      receiptId: receipt.id,
      refundId: refund.id,
      actor: input.actor,
      postings: reversalPostings(returned),
    });

    await tx.execute(sql`
      update ${accountBalances}
      set promotional_balance = ${accountBalances.promotionalBalance} + ${returned.promotionalFunds}::numeric,
          purchased_balance = ${accountBalances.purchasedBalance} + ${returned.purchasedFunds}::numeric,
          invoiced_outstanding = ${accountBalances.invoicedOutstanding} - ${returned.invoiceReceivable}::numeric,
          updated_at = ${NOW}
      where ${accountBalances.accountId} = ${receipt.accountId}
        and ${accountBalances.currency} = ${receipt.currency}
    `);

    return { status: 'reversed', refundId: refund.id, amount };
  });
}

// ===========================================================================
// Internals
// ===========================================================================

/**
 * `SELECT … FOR UPDATE` on the balance row — the serialization point every
 * mutating path opens with. Returns false when the account has no balance row,
 * which (because `provisionBillingProfile` writes both together) means it has no
 * billing profile either.
 */
export async function lockBalance(
  tx: DatabaseOrTransaction,
  accountId: string,
  currency: string
): Promise<boolean> {
  const rows = await executeRows<{ account_id: string }>(
    tx,
    sql`
      select account_id
      from ${accountBalances}
      where ${accountBalances.accountId} = ${accountId}
        and ${accountBalances.currency} = ${currency}
      for update
    `
  );
  return rows.length > 0;
}

async function findReservationByKey(
  tx: DatabaseOrTransaction,
  idempotencyKey: string
): Promise<ReservationView | undefined> {
  const [row] = await tx
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!row) return undefined;
  return {
    reservationId: row.id,
    billingAccountId: row.accountId,
    reservedAmount: row.reservedAmount,
    currency: row.currency,
    expiresAt: row.expiresAt,
  };
}

async function findReceiptByKey(
  tx: DatabaseOrTransaction,
  idempotencyKey: string
): Promise<ReceiptView | undefined> {
  const [row] = await tx
    .select()
    .from(usageReceipts)
    .where(eq(usageReceipts.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!row) return undefined;
  return { receiptId: row.id, billedAmount: row.billedAmount, currency: row.currency };
}

async function findRefundByKey(
  tx: DatabaseOrTransaction,
  idempotencyKey: string
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: usageRefunds.id })
    .from(usageRefunds)
    .where(eq(usageRefunds.idempotencyKey, idempotencyKey))
    .limit(1);
  return row?.id;
}

async function findEntryByKey(
  tx: DatabaseOrTransaction,
  idempotencyKey: string
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: billingLedgerEntries.id })
    .from(billingLedgerEntries)
    .where(eq(billingLedgerEntries.idempotencyKey, idempotencyKey))
    .limit(1);
  return row?.id;
}

/** One movement of value, as {@link writeEntry} takes it. */
export interface PostingInput {
  readonly source: LedgerAccount;
  readonly destination: LedgerAccount;
  readonly amount: string;
}

export interface EntryInput {
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly currency: string;
  readonly kind: LedgerEntryKind;
  readonly reservationId?: string;
  readonly receiptId?: string;
  readonly refundId?: string;
  readonly invoiceId?: string;
  /**
   * Who authored this entry (issue #1023). REQUIRED, and required is the whole
   * point: this is the only insert into `billing_ledger_entries` in the package,
   * so a writer that forgets authorship does not compile. Optional-with-a-
   * default would put the machine representation on a staff grant by silence,
   * which is the exact failure the column pair exists to prevent.
   */
  readonly actor: LedgerActor;
  readonly postings: readonly PostingInput[];
}

/**
 * Write one journal entry and its postings.
 *
 * Zero-amount postings are DROPPED rather than written: a posting of nothing
 * moves nothing while inflating both sides of every sum computed over the
 * table, which is why the column also carries a `> 0` CHECK.
 *
 * EXPORTED, and it is the only journal writer in this package. The invoicing
 * path (`accountInvoicing.service.ts`) needs to book `invoice_rounding` and
 * `invoice_payment` entries, and the alternative to exporting this was a second
 * function that inserts into `billing_ledger_entries` — two writers for one
 * journal, free to diverge on the idempotency read-back and on the zero-amount
 * rule. A wider export surface is the cheaper of the two risks.
 */
export async function writeEntry(
  tx: DatabaseOrTransaction,
  input: EntryInput
): Promise<string> {
  const [entry] = await tx
    .insert(billingLedgerEntries)
    .values({
      idempotencyKey: input.idempotencyKey,
      accountId: input.accountId,
      currency: input.currency,
      kind: input.kind,
      reservationId: input.reservationId,
      receiptId: input.receiptId,
      refundId: input.refundId,
      invoiceId: input.invoiceId,
      // The one place the union becomes two columns. `machine` carries no id by
      // construction, which is the half of the CHECK a type cannot state.
      actorKind: input.actor.kind,
      actorUserId: input.actor.kind === 'staff' ? input.actor.userId : null,
    })
    .onConflictDoNothing()
    .returning();

  if (!entry) {
    const existing = await findEntryByKey(tx, input.idempotencyKey);
    if (!existing) {
      throw new Error(`ledger entry ${input.idempotencyKey} conflicted but could not be read back`);
    }
    return existing;
  }

  const rows = input.postings
    .map((posting, index) => ({ ...posting, sequence: index }))
    .filter((posting) => !isZeroLiteral(posting.amount));

  if (rows.length > 0) {
    await tx.insert(billingLedgerPostings).values(
      rows.map((posting) => ({
        entryId: entry.id,
        sequence: posting.sequence,
        sourceAccount: posting.source,
        destinationAccount: posting.destination,
        amount: posting.amount,
      }))
    );
  }

  return entry.id;
}

/**
 * A cheap textual zero test, for deciding whether to WRITE a posting at all.
 *
 * Never used to decide an AMOUNT — every arithmetic comparison in this module
 * goes through Postgres. This one only has to be conservative: a value it
 * wrongly calls non-zero is written and then rejected by the `> 0` CHECK, which
 * is loud.
 */
function isZeroLiteral(amount: string): boolean {
  return /^0(?:\.0*)?$/.test(amount);
}

async function isZero(tx: DatabaseOrTransaction, amount: string): Promise<boolean> {
  const [row] = await executeRows<{ zero: boolean }>(
    tx,
    sql`select (${amount}::numeric = 0) as zero`
  );
  return row?.zero === true;
}

async function greaterThan(
  tx: DatabaseOrTransaction,
  left: string,
  right: string
): Promise<boolean> {
  const [row] = await executeRows<{ greater: boolean }>(
    tx,
    sql`select (${left}::numeric > ${right}::numeric) as greater`
  );
  return row?.greater === true;
}

async function exceedsHold(
  tx: DatabaseOrTransaction,
  billed: string,
  reserved: string
): Promise<boolean> {
  return greaterThan(tx, billed, reserved);
}

async function subtract(
  tx: DatabaseOrTransaction,
  left: string,
  right: string
): Promise<string> {
  const [row] = await executeRows<{ result: string }>(
    tx,
    sql`select round(${left}::numeric - ${right}::numeric, ${MONEY_SCALE})::text as result`
  );
  if (!row) throw new Error('subtraction returned no row');
  return row.result;
}

/**
 * Split an amount across the customer's buckets in {@link RESERVATION_DRAW_ORDER}.
 *
 * Three explicit terms rather than a window function over the order tuple: the
 * order has exactly three entries, the expression reads as the rule it
 * implements, and `schema/__tests__/inferenceLedger.test.ts` asserts the tuple's
 * LENGTH so a fourth account cannot be added without this being revisited.
 */
async function computeDraw(
  tx: DatabaseOrTransaction,
  billing: BillingAccount,
  amount: string
): Promise<{ sufficient: boolean; available: string; split: DrawSplit }> {
  const [row] = await executeRows<DrawRow>(
    tx,
    sql`
      with hold as (select ${amount}::numeric as amount),
      bal as (
        select ab.promotional_balance, ab.purchased_balance, ab.invoiced_outstanding,
               case when bp.billing_mode = 'invoiced'
                    then greatest(0::numeric, bp.credit_limit - ab.invoiced_outstanding)
                    else 0::numeric
               end as credit_room
        from ${accountBalances} ab
        join ${billingProfiles} bp on bp.account_id = ab.account_id
        where ab.account_id = ${billing.accountId} and ab.currency = ${billing.currency}
      ),
      d1 as (
        select bal.*, hold.amount, least(bal.promotional_balance, hold.amount) as promotional
        from bal, hold
      ),
      d2 as (
        select d1.*,
               least(d1.purchased_balance, greatest(0::numeric, d1.amount - d1.promotional)) as purchased
        from d1
      ),
      d3 as (
        select d2.*,
               least(d2.credit_room,
                     greatest(0::numeric, d2.amount - d2.promotional - d2.purchased)) as receivable
        from d2
      )
      select
        round(promotional, ${MONEY_SCALE})::text as promotional,
        round(purchased, ${MONEY_SCALE})::text as purchased,
        round(receivable, ${MONEY_SCALE})::text as receivable,
        (promotional + purchased + receivable >= amount) as sufficient,
        round(promotional_balance + purchased_balance + credit_room, ${MONEY_SCALE})::text as available
      from d3
    `
  );

  if (!row) {
    return {
      sufficient: false,
      available: '0',
      split: { promotionalFunds: '0', purchasedFunds: '0', invoiceReceivable: '0' },
    };
  }

  return {
    sufficient: row.sufficient,
    available: row.available,
    split: {
      promotionalFunds: row.promotional,
      purchasedFunds: row.purchased,
      invoiceReceivable: row.receivable,
    },
  };
}

/**
 * The exact charge, computed in SQL from the price version's unit prices.
 *
 * One price applied to every reported unit, summed. That arithmetic is only the
 * request's cost because the contract's units PARTITION it: `cached_input_tokens`
 * is a sibling of `input_tokens` and not a detail inside it, and the same for
 * `reasoning_tokens` and `output_tokens` (`@oxyhq/contracts`' `USAGE_UNITS`). A
 * report normalized the other way — the way every OpenAI-compatible provider
 * emits one — would be charged twice for its cached and reasoning tokens here,
 * with no symptom: the receipt would still be internally consistent and every
 * total would still look plausible.
 */
async function computeCharge(
  tx: DatabaseOrTransaction,
  priceVersionId: string,
  units: Partial<Record<UsageUnit, number>>
): Promise<{ amount: string; unpricedUnits: number }> {
  const metered = Object.entries(units).filter(
    (entry): entry is [UsageUnit, number] => typeof entry[1] === 'number' && entry[1] > 0
  );

  if (metered.length === 0) {
    return { amount: '0', unpricedUnits: 0 };
  }

  const values = sql.join(
    metered.map(([unit, quantity]) => sql`(${unit}::text, ${quantity}::bigint)`),
    sql`, `
  );

  const [row] = await executeRows<{ amount: string; unpriced: number }>(
    tx,
    sql`
      select
        round(
          coalesce(sum(p.amount * q.quantity::numeric / p.per::numeric), 0),
          ${MONEY_SCALE}
        )::text as amount,
        -- A metered unit with no price in this version would be silently
        -- dropped by an inner join, and dropping it UNDERCHARGES. Counted here
        -- so the caller refuses rather than bills the wrong number.
        count(*) filter (where p.unit is null)::int as unpriced
      from (values ${values}) as q(unit, quantity)
      left join ${priceVersionUnitPrices} p
        on p.price_version_id = ${priceVersionId} and p.unit = q.unit
    `
  );

  if (!row) throw new Error('charge computation returned no row');
  return { amount: row.amount, unpricedUnits: row.unpriced };
}

/** What a hold drew, per bucket, read back from its own journal entry. */
async function readHoldSplit(
  tx: DatabaseOrTransaction,
  reservationId: string
): Promise<DrawSplit> {
  const rows = await executeRows<{ source_account: string; amount: string }>(
    tx,
    sql`
      select p.source_account, round(sum(p.amount), ${MONEY_SCALE})::text as amount
      from ${billingLedgerPostings} p
      join ${billingLedgerEntries} e on e.id = p.entry_id
      where e.reservation_id = ${reservationId}
        and e.kind = 'reservation_hold'
        and p.destination_account = 'reserved_funds'
      group by p.source_account
    `
  );
  return bucketsFrom(rows.map((row) => [row.source_account, row.amount]));
}

/** What a settlement consumed, per bucket, for a reversal to unwind. */
async function readSettlementConsumption(
  tx: DatabaseOrTransaction,
  receiptId: string,
  billedAmount: string
): Promise<DrawSplit> {
  const rows = await executeRows<{ source_account: string; amount: string }>(
    tx,
    sql`
      select p.source_account, round(sum(p.amount), ${MONEY_SCALE})::text as amount
      from ${billingLedgerPostings} p
      join ${billingLedgerEntries} e on e.id = p.entry_id
      where e.receipt_id = ${receiptId}
        and e.kind = 'settlement'
        and p.destination_account = 'platform_revenue'
      group by p.source_account
    `
  );

  const direct = bucketsFrom(rows.map((row) => [row.source_account, row.amount]));
  // A settlement against a HOLD posts `reserved_funds → platform_revenue`, so
  // the customer bucket it ultimately came from is the hold's own draw. Fall
  // back to it, consumed in the same order the hold was drawn.
  const fromReserved = rows.find((row) => row.source_account === 'reserved_funds');
  if (!fromReserved) return direct;

  const [entry] = await executeRows<{ reservation_id: string | null }>(
    tx,
    sql`
      select e.reservation_id
      from ${billingLedgerEntries} e
      where e.receipt_id = ${receiptId} and e.kind = 'settlement'
      limit 1
    `
  );
  if (!entry?.reservation_id) return direct;

  const held = await readHoldSplit(tx, entry.reservation_id);
  return (await splitHold(tx, held, billedAmount)).consumed;
}

function bucketsFrom(pairs: readonly (readonly [string, string])[]): DrawSplit {
  const lookup = new Map(pairs);
  return {
    promotionalFunds: lookup.get('promotional_funds') ?? '0',
    purchasedFunds: lookup.get('purchased_funds') ?? '0',
    invoiceReceivable: lookup.get('invoice_receivable') ?? '0',
  };
}

/**
 * Consume `settled` from a hold's draw, in {@link RESERVATION_DRAW_ORDER}, and
 * report what is left to release.
 */
async function splitHold(
  tx: DatabaseOrTransaction,
  held: DrawSplit,
  settled: string
): Promise<{ consumed: DrawSplit; released: DrawSplit }> {
  const [row] = await executeRows<{
    consumed_promotional: string;
    consumed_purchased: string;
    consumed_receivable: string;
    released_promotional: string;
    released_purchased: string;
    released_receivable: string;
  }>(
    tx,
    sql`
      with h as (
        select ${held.promotionalFunds}::numeric as promotional,
               ${held.purchasedFunds}::numeric as purchased,
               ${held.invoiceReceivable}::numeric as receivable,
               ${settled}::numeric as settled
      ),
      c1 as (select h.*, least(h.promotional, h.settled) as consumed_promotional from h),
      c2 as (
        select c1.*,
               least(c1.purchased,
                     greatest(0::numeric, c1.settled - c1.consumed_promotional)) as consumed_purchased
        from c1
      ),
      c3 as (
        select c2.*,
               least(c2.receivable,
                     greatest(0::numeric,
                              c2.settled - c2.consumed_promotional - c2.consumed_purchased)) as consumed_receivable
        from c2
      )
      select
        round(consumed_promotional, ${MONEY_SCALE})::text as consumed_promotional,
        round(consumed_purchased, ${MONEY_SCALE})::text as consumed_purchased,
        round(consumed_receivable, ${MONEY_SCALE})::text as consumed_receivable,
        round(promotional - consumed_promotional, ${MONEY_SCALE})::text as released_promotional,
        round(purchased - consumed_purchased, ${MONEY_SCALE})::text as released_purchased,
        round(receivable - consumed_receivable, ${MONEY_SCALE})::text as released_receivable
      from c3
    `
  );

  if (!row) throw new Error('hold split returned no row');
  return {
    consumed: {
      promotionalFunds: row.consumed_promotional,
      purchasedFunds: row.consumed_purchased,
      invoiceReceivable: row.consumed_receivable,
    },
    released: {
      promotionalFunds: row.released_promotional,
      purchasedFunds: row.released_purchased,
      invoiceReceivable: row.released_receivable,
    },
  };
}

/**
 * Unwind `amount` from a settlement's consumption, in REVERSE draw order.
 *
 * Receivable first, then purchased, then promotional — see `reverseReceipt`'s
 * doc comment for why the promotional bucket is credited last.
 */
async function splitReverse(
  tx: DatabaseOrTransaction,
  consumed: DrawSplit,
  amount: string
): Promise<DrawSplit> {
  const [row] = await executeRows<{
    promotional: string;
    purchased: string;
    receivable: string;
  }>(
    tx,
    sql`
      with c as (
        select ${consumed.promotionalFunds}::numeric as promotional,
               ${consumed.purchasedFunds}::numeric as purchased,
               ${consumed.invoiceReceivable}::numeric as receivable,
               ${amount}::numeric as amount
      ),
      r1 as (select c.*, least(c.receivable, c.amount) as ret_receivable from c),
      r2 as (
        select r1.*,
               least(r1.purchased, greatest(0::numeric, r1.amount - r1.ret_receivable)) as ret_purchased
        from r1
      ),
      r3 as (
        select r2.*,
               least(r2.promotional,
                     greatest(0::numeric, r2.amount - r2.ret_receivable - r2.ret_purchased)) as ret_promotional
        from r2
      )
      select
        round(ret_promotional, ${MONEY_SCALE})::text as promotional,
        round(ret_purchased, ${MONEY_SCALE})::text as purchased,
        round(ret_receivable, ${MONEY_SCALE})::text as receivable
      from r3
    `
  );

  if (!row) throw new Error('reversal split returned no row');
  return {
    promotionalFunds: row.promotional,
    purchasedFunds: row.purchased,
    invoiceReceivable: row.receivable,
  };
}

/** Postings for a draw: each non-zero bucket into `reserved_funds` or revenue. */
function drawPostings(split: DrawSplit, destination: 'hold' | 'revenue'): PostingInput[] {
  const target: LedgerAccount = destination === 'hold' ? 'reserved_funds' : 'platform_revenue';
  return [
    { source: 'promotional_funds', destination: target, amount: split.promotionalFunds },
    { source: 'purchased_funds', destination: target, amount: split.purchasedFunds },
    { source: 'invoice_receivable', destination: target, amount: split.invoiceReceivable },
  ];
}

/** Postings for a reversal: `platform_revenue` back into each non-zero bucket. */
function reversalPostings(split: DrawSplit): PostingInput[] {
  return [
    { source: 'platform_revenue', destination: 'promotional_funds', amount: split.promotionalFunds },
    { source: 'platform_revenue', destination: 'purchased_funds', amount: split.purchasedFunds },
    { source: 'platform_revenue', destination: 'invoice_receivable', amount: split.invoiceReceivable },
  ];
}

/** Postings for a release: `reserved_funds` back into each non-zero bucket. */
function releasePostings(split: DrawSplit): PostingInput[] {
  return [
    { source: 'reserved_funds', destination: 'promotional_funds', amount: split.promotionalFunds },
    { source: 'reserved_funds', destination: 'purchased_funds', amount: split.purchasedFunds },
    { source: 'reserved_funds', destination: 'invoice_receivable', amount: split.invoiceReceivable },
  ];
}

/**
 * Move the projection for a settlement or an expiry: the whole hold leaves
 * `reserved_balance`, and the released part returns to the buckets it came from.
 */
async function applySettlementBalance(
  tx: DatabaseOrTransaction,
  billing: Pick<BillingAccount, 'accountId' | 'currency'>,
  movement: { reservedDelta: string; released: DrawSplit }
): Promise<void> {
  await tx.execute(sql`
    update ${accountBalances}
    set reserved_balance = ${accountBalances.reservedBalance} - ${movement.reservedDelta}::numeric,
        promotional_balance = ${accountBalances.promotionalBalance} + ${movement.released.promotionalFunds}::numeric,
        purchased_balance = ${accountBalances.purchasedBalance} + ${movement.released.purchasedFunds}::numeric,
        invoiced_outstanding = ${accountBalances.invoicedOutstanding} - ${movement.released.invoiceReceivable}::numeric,
        updated_at = ${NOW}
    where ${accountBalances.accountId} = ${billing.accountId}
      and ${accountBalances.currency} = ${billing.currency}
  `);
}

/**
 * Everything the report says was consumed, as one number.
 *
 * Sums the VALUES rather than counting the keys, because a report that names
 * eleven units and reports zero for each has metered nothing — and it is the
 * shape the wire schema still admits, since `usageQuantitySchema` allows
 * `quantity: 0`. Counting keys would read that as usage.
 *
 * A negative quantity cannot reach here (the contract's `nonnegative()`, and the
 * table's own CHECK), so a total of zero means every unit is zero rather than
 * some cancelling out.
 */
function totalMeteredUnits(units: Partial<Record<UsageUnit, number>>): number {
  return Object.values(units).reduce((total, quantity) => total + (quantity ?? 0), 0);
}

/**
 * The customer-facing reason a hold's remainder came back.
 *
 * `usage_unavailable` wins over the outcome: a provider that returned no usage
 * at all is the fact worth recording, because it is the one that makes a receipt
 * reconcilable later. Everything else maps straight from ADR 0009's own table.
 *
 * There is deliberately no reason here for a `completed` report that metered
 * nothing: `settle` refuses that with `zero-usage` before anything is written, so
 * no refund row exists to carry a reason. The hold's remainder comes back through
 * the expiry sweep instead — see `settle`'s own "A completed request consumed
 * something".
 */
function releaseReason(outcome: InferenceRequestOutcome, usageSource: UsageSource): UsageRefundReason {
  if (usageSource === 'estimated') return 'usage_unavailable';
  switch (outcome) {
    case 'cancelled':
      return 'client_cancelled';
    case 'failed':
      return 'upstream_failure';
    case 'partial':
      return 'partial_stream';
    case 'completed':
      return 'unused_reservation';
  }
}
