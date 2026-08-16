/**
 * Account Billing Service — the Oxy ACCOUNT as the billable principal.
 *
 * The audit (`docs/audits/2026-08-15-account-and-application-ownership.md` §6)
 * found the gap this closes and stated it precisely: account-scoped billing
 * STORAGE already existed — `user_credits` and later `billing_profiles` are both
 * keyed on `users.id`, which is an account id of any kind — but there was no way
 * for a non-personal account to acquire a profile other than a human holding
 * `account:act_as`, switching into it, and loading a billing page. For a
 * `channel` account it was impossible outright, because switching into a channel
 * is refused while nothing stops a channel from owning an application.
 *
 * So every function here takes an `accountId` explicitly and never reads a
 * bearer's own subject. Authorization is the ROUTE's job, through
 * `resolveCallerAccountAccess`; this module only ever answers about the account
 * it was asked about.
 *
 * ## Inheritance: the nearest ancestor pays
 *
 * A project draws on the nearest ancestor (itself included) that has a billing
 * profile — the rule argued in `billingProfiles.ts` and ADR 0014, walked over
 * `user_ancestors`, the same materialised path `resolveEffectiveMembership`
 * uses. That resolution lives ONCE, in `inferenceLedger.service.ts`'s
 * `resolveBillingAccount`, and this module calls it rather than repeating the
 * walk: billing inheritance and permission inheritance must not be able to come
 * to different answers about the shape of the tree.
 *
 * `AccountBillingState.inherited` is what makes that visible to a customer. A
 * Console page that showed the organization's balance under a project's name,
 * with no indication whose money it was, would be worse than showing nothing.
 *
 * ## Where the money arithmetic happens
 *
 * In SQL, always — see `inferenceLedger.service.ts` property 1. Amounts cross
 * this module as exact decimal STRINGS and are never parsed into a JS `number`.
 * `availableToSpend` is not computed here at all: it is
 * `getAvailableToSpend`, which evaluates the SAME expression a reservation
 * decides against, so "what Console says is available" and "what the ledger will
 * actually allow" cannot diverge.
 *
 * ## Auto-recharge stakes its claim BEFORE the card is charged
 *
 * Every other idempotency guard in this schema protects a bookkeeping mistake.
 * This one protects a real-world side effect that no compensating row undoes, so
 * {@link claimAutoRecharge} writes the attempt row first and only a caller
 * holding a `claimed` result may talk to the processor.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import {
  accountBillingStateSchema,
  autoRechargeAttemptSchema,
  billingProfileSchema,
  type AccountBillingState,
  type AutoRechargeAttempt,
  type BillingMode,
  type BillingProfile,
  type BillingProfileStatus,
} from '@oxyhq/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { accountBalances } from '../db/schema/accountBalances';
import {
  AUTO_RECHARGE_WINDOW_SECONDS,
  billingAutoRechargeAttempts,
  type BillingAutoRechargeAttemptRow,
} from '../db/schema/billingAutoRechargeAttempts';
import { billingProfiles } from '../db/schema/billingProfiles';
import { users } from '../db/schema/users';
import {
  provisionBillingProfile,
  recordPromotionalGrant,
  resolveBillingAccount,
  type BillingAccount,
  type FundingResult,
} from './inferenceLedger.service';

type BillingProfileRow = typeof billingProfiles.$inferSelect;

// ===========================================================================
// Serializers
// ===========================================================================

/**
 * `.parse` rather than a typed literal, matching `toProviderConnection`: the
 * contract's account id is BRANDED, so a plain `string` is not assignable to it
 * and the only way to obtain one is through the schema. The parse is therefore
 * both the runtime guard and the construction.
 */
export function toBillingProfile(row: BillingProfileRow): BillingProfile {
  return billingProfileSchema.parse({
    schemaVersion: 1,
    accountId: row.accountId,
    currency: row.currency,
    billingMode: row.billingMode,
    status: row.status,
    creditLimit: row.creditLimit,
    autoRecharge: {
      enabled: row.autoRechargeEnabled,
      threshold: row.autoRechargeThreshold ?? undefined,
      amount: row.autoRechargeAmount ?? undefined,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toAutoRechargeAttempt(
  row: BillingAutoRechargeAttemptRow
): AutoRechargeAttempt {
  return autoRechargeAttemptSchema.parse({
    schemaVersion: 1,
    id: row.id,
    accountId: row.accountId,
    currency: row.currency,
    requestedAmount: row.requestedAmount,
    balanceAtTrigger: row.balanceAtTrigger,
    status: row.status,
    externalRef: row.externalRef ?? undefined,
    failureCode: row.failureCode ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

// ===========================================================================
// Billing state
// ===========================================================================

export type AccountBillingResolution =
  | { readonly status: 'resolved'; readonly state: AccountBillingState }
  | { readonly status: 'not-provisioned'; readonly accountId: string }
  | { readonly status: 'unknown-account'; readonly accountId: string };

/**
 * Who pays for this account, on what terms, and whether it is their own money.
 *
 * ## The BALANCE is deliberately not here
 *
 * `readAccountBalance` (`inferenceReporting.service.ts`, #972 workstream 8) is
 * the one reader of `account_balances`, and `GET
 * /inference/reporting/accounts/:accountId/balance` is the one endpoint that
 * publishes it. A second one would be a second answer to one question, and the
 * pair would disagree the day one of them stopped accounting for an invoiced
 * account's unused credit line.
 *
 * What this adds instead is what nothing else carries: the TERMS (mode, credit
 * limit, auto-recharge, status) and the inheritance facts (`billingAccountId`,
 * `inherited`).
 *
 * ## An account's OWN profile is shown whatever its status
 *
 * `resolveBillingAccount` — the ledger's inheritance walk — filters on
 * `status = 'active'`, correctly: a suspended profile may not be SPENT from, and
 * an account must not silently start drawing on a suspended ancestor either.
 *
 * But this is a READ, and applying that filter here would report a suspended
 * account as `not-provisioned`, which collapses "you are suspended" into
 * "nobody has decided who pays for you" — the exact distinction the audit's §6
 * finding turns on, and the one a customer most needs to see. So an account's
 * own profile is loaded directly first, at any status, and only the INHERITED
 * case goes through the active-filtered walk.
 *
 * The two arms therefore agree with spending in both directions: a suspended own
 * profile is displayed with `canSpend` false and refuses reservations, and a
 * suspended ancestor is neither displayed nor spent from.
 *
 * The two absent arms are distinguished by a second query rather than inferred
 * from the first, because they are not the same fact and the safe handling
 * differs: an unknown account is a stale id in the caller, while an
 * unprovisioned one is the ordinary state of most organization accounts and is
 * fixed by provisioning one.
 */
export async function resolveAccountBillingState(
  accountId: string
): Promise<AccountBillingResolution> {
  const db = getDb();

  const [own] = await db
    .select()
    .from(billingProfiles)
    .where(eq(billingProfiles.accountId, accountId))
    .limit(1);

  if (own) {
    const state = await loadBillingState(db, accountId, {
      accountId: own.accountId,
      currency: own.currency,
      billingMode: own.billingMode,
      creditLimit: own.creditLimit,
    });
    if (state !== undefined) {
      return { status: 'resolved', state };
    }
  }

  const resolution = await resolveBillingAccount(db, accountId);
  if (resolution.status === 'not-provisioned') {
    const [account] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);
    return account
      ? { status: 'not-provisioned', accountId }
      : { status: 'unknown-account', accountId };
  }

  const state = await loadBillingState(db, accountId, resolution.billingAccount);
  return state === undefined
    ? { status: 'not-provisioned', accountId }
    : { status: 'resolved', state };
}

async function loadBillingState(
  db: DatabaseOrTransaction,
  requestedAccountId: string,
  billing: BillingAccount
): Promise<AccountBillingState | undefined> {
  const [profile] = await db
    .select()
    .from(billingProfiles)
    .where(eq(billingProfiles.accountId, billing.accountId))
    .limit(1);
  if (!profile) return undefined;

  return accountBillingStateSchema.parse({
    schemaVersion: 1,
    accountId: requestedAccountId,
    billingAccountId: billing.accountId,
    inherited: billing.accountId !== requestedAccountId,
    profile: toBillingProfile(profile),
  });
}

export interface ProvisionAccountBillingInput {
  readonly accountId: string;
  readonly currency?: string;
  readonly billingMode?: BillingMode;
  /** Exact decimal string. Only meaningful for `invoiced`. */
  readonly creditLimit?: string;
}

export type ProvisionAccountBillingResult =
  | { readonly status: 'provisioned'; readonly state: AccountBillingState }
  | { readonly status: 'unknown-account'; readonly accountId: string };

/**
 * Give an account a billing profile and a zeroed balance of its OWN.
 *
 * Idempotent, and deliberately not "provision if inherited": an account that
 * currently draws on its parent gets its own profile here and stops inheriting,
 * which is a real decision with a real consequence and belongs to whoever calls
 * this. Resolving a state first and short-circuiting on `resolved` would make
 * the call silently do nothing for every project.
 *
 * The account is checked to exist FIRST, because the alternative is a foreign
 * key violation surfacing as a 500 on a typo'd id.
 */
export async function provisionAccountBilling(
  input: ProvisionAccountBillingInput
): Promise<ProvisionAccountBillingResult> {
  const db = getDb();
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.accountId))
    .limit(1);
  if (!account) {
    return { status: 'unknown-account', accountId: input.accountId };
  }

  const billing = await provisionBillingProfile(input);
  const state = await loadBillingState(db, input.accountId, billing);
  if (state === undefined) {
    throw new Error(
      `billing profile for account ${input.accountId} vanished immediately after provisioning`
    );
  }
  return { status: 'provisioned', state };
}

/**
 * The fields a profile update may touch.
 *
 * An explicit whitelist type, never a spread of `req.body`: this record decides
 * whether an account is invoiced and how far it may draw, and a mass-assignment
 * here is a customer granting themselves a credit limit. The ROUTE narrows it
 * further — `billingMode` and `creditLimit` are staff-gated there — but the
 * shape is closed at both layers.
 *
 * `null` on the two auto-recharge amounts means "clear it"; `undefined` means
 * "leave it alone". They are different requests and collapsing them would make
 * turning auto-recharge off impossible without also re-sending the amounts.
 */
export interface BillingProfilePatch {
  readonly status?: BillingProfileStatus;
  readonly billingMode?: BillingMode;
  readonly creditLimit?: string;
  readonly autoRechargeEnabled?: boolean;
  readonly autoRechargeThreshold?: string | null;
  readonly autoRechargeAmount?: string | null;
}

export type UpdateBillingProfileResult =
  | { readonly status: 'updated'; readonly profile: BillingProfile }
  | { readonly status: 'not-provisioned'; readonly accountId: string }
  | { readonly status: 'incomplete-auto-recharge' };

/**
 * Update an account's OWN billing profile. Never an inherited one.
 *
 * Editing the profile an account merely draws on would let a project silently
 * change its organization's credit limit, so this addresses
 * `billing_profiles.account_id` directly and answers `not-provisioned` for an
 * account that has none of its own — even when it happily spends an ancestor's.
 */
export async function updateBillingProfile(
  accountId: string,
  patch: BillingProfilePatch
): Promise<UpdateBillingProfileResult> {
  return getDb().transaction(async (tx): Promise<UpdateBillingProfileResult> => {
    const [current] = await tx
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.accountId, accountId))
      .limit(1);
    if (!current) {
      return { status: 'not-provisioned', accountId };
    }

    const next = {
      status: patch.status ?? current.status,
      billingMode: patch.billingMode ?? current.billingMode,
      creditLimit: patch.creditLimit ?? current.creditLimit,
      autoRechargeEnabled: patch.autoRechargeEnabled ?? current.autoRechargeEnabled,
      autoRechargeThreshold:
        patch.autoRechargeThreshold === undefined
          ? current.autoRechargeThreshold
          : patch.autoRechargeThreshold,
      autoRechargeAmount:
        patch.autoRechargeAmount === undefined
          ? current.autoRechargeAmount
          : patch.autoRechargeAmount,
      updatedAt: new Date(),
    };

    // Checked here so the caller gets a named refusal rather than a constraint
    // violation. The column CHECK is still the second line — this is the
    // readable failure, not the guarantee.
    if (
      next.autoRechargeEnabled &&
      (next.autoRechargeThreshold === null || next.autoRechargeAmount === null)
    ) {
      return { status: 'incomplete-auto-recharge' };
    }

    const [updated] = await tx
      .update(billingProfiles)
      .set(next)
      .where(eq(billingProfiles.accountId, accountId))
      .returning();

    return { status: 'updated', profile: toBillingProfile(updated) };
  });
}

// ===========================================================================
// Promotional grants
// ===========================================================================

export interface PromotionalGrantInput {
  readonly accountId: string;
  readonly currency: string;
  readonly amount: string;
  readonly idempotencyKey: string;
}

/**
 * Credit an account with money it did not pay for.
 *
 * A thin pass-through to the ledger's `recordPromotionalGrant`, and thin on
 * purpose: the grant lands in `promotional_funds`, never in `purchased_funds`,
 * and there must be exactly one function in the codebase that can put money in
 * either bucket. A second one here that "helpfully" chose a bucket would be the
 * end of the distinction between granted and purchased money.
 */
export function grantPromotionalCredit(input: PromotionalGrantInput): Promise<FundingResult> {
  return recordPromotionalGrant(input);
}

// ===========================================================================
// Auto-recharge
// ===========================================================================

/** An account whose spendable room has fallen below its configured threshold. */
export interface AutoRechargeCandidate {
  readonly accountId: string;
  readonly currency: string;
  readonly threshold: string;
  readonly amount: string;
  readonly availableToSpend: string;
}

interface AutoRechargeCandidateRow extends Record<string, unknown> {
  account_id: string;
  currency: string;
  threshold: string;
  amount: string;
  available: string;
}

/**
 * Accounts due an automatic top-up.
 *
 * The availability expression is written out here rather than calling
 * `getAvailableToSpend` per account, because this is a SCAN: one query over
 * every enabled profile, not N round trips. It is the same arithmetic — prepaid
 * buckets plus, for an `invoiced` account, the unused part of the credit limit —
 * and `accountBilling.service.test.ts` asserts the two agree on a fixture that
 * exercises both billing modes, so the duplication is gated rather than trusted.
 *
 * A `suspended` or `closed` profile is skipped: recharging an account that may
 * not spend would charge a card for money that cannot be used.
 */
export async function findAutoRechargeCandidates(limit = 50): Promise<AutoRechargeCandidate[]> {
  const rows = await executeRows<AutoRechargeCandidateRow>(
    getDb(),
    sql`
      select
        bp.account_id,
        bp.currency,
        bp.auto_recharge_threshold::text as threshold,
        bp.auto_recharge_amount::text as amount,
        round(
          ab.promotional_balance + ab.purchased_balance
            + case when bp.billing_mode = 'invoiced'
                   then greatest(0::numeric, bp.credit_limit - ab.invoiced_outstanding)
                   else 0::numeric
              end,
          12
        )::text as available
      from ${billingProfiles} bp
      join ${accountBalances} ab
        on ab.account_id = bp.account_id and ab.currency = bp.currency
      where bp.auto_recharge_enabled
        and bp.status = 'active'
        and bp.auto_recharge_threshold is not null
        and bp.auto_recharge_amount is not null
        and ab.promotional_balance + ab.purchased_balance
              + case when bp.billing_mode = 'invoiced'
                     then greatest(0::numeric, bp.credit_limit - ab.invoiced_outstanding)
                     else 0::numeric
                end
            < bp.auto_recharge_threshold
      order by ab.purchased_balance asc
      limit ${limit}
    `
  );

  return rows.map((row) => ({
    accountId: row.account_id,
    currency: row.currency,
    threshold: row.threshold,
    amount: row.amount,
    availableToSpend: row.available,
  }));
}

/**
 * The start of the window an auto-recharge claim covers, as epoch milliseconds.
 *
 * Exported so a test can address the same window the sweep will, without
 * reproducing the arithmetic — a test that computed its own window would pass
 * whether or not the sweep's matched.
 */
export function autoRechargeWindowStart(now: Date): number {
  const windowMs = AUTO_RECHARGE_WINDOW_SECONDS * 1000;
  return Math.floor(now.getTime() / windowMs) * windowMs;
}

export type ClaimAutoRechargeResult =
  | { readonly status: 'claimed'; readonly attempt: BillingAutoRechargeAttemptRow }
  | { readonly status: 'already-claimed' };

/**
 * Stake the claim on one automatic top-up, BEFORE the processor is called.
 *
 * `ON CONFLICT … DO NOTHING RETURNING`, never a caught duplicate-key error: a
 * duplicate key and a dropped connection are indistinguishable inside a `catch`,
 * so an exception handler would answer "somebody else is charging this card"
 * to an infrastructure failure — and the caller would skip a top-up that never
 * happened.
 *
 * A caller that does not receive `claimed` MUST NOT talk to the processor.
 */
export async function claimAutoRecharge(
  candidate: AutoRechargeCandidate,
  now = new Date()
): Promise<ClaimAutoRechargeResult> {
  const idempotencyKey = `recharge:${candidate.accountId}:${candidate.currency}:${autoRechargeWindowStart(now)}`;

  const [row] = await getDb()
    .insert(billingAutoRechargeAttempts)
    .values({
      idempotencyKey,
      accountId: candidate.accountId,
      currency: candidate.currency,
      requestedAmount: candidate.amount,
      balanceAtTrigger: candidate.availableToSpend,
      status: 'pending',
    })
    .onConflictDoNothing()
    .returning();

  return row === undefined ? { status: 'already-claimed' } : { status: 'claimed', attempt: row };
}

/**
 * Mark a claimed attempt as having produced a charge.
 *
 * This records only that the processor accepted it. The MONEY arrives
 * separately, through the webhook that calls `recordTopUp` with the same payment
 * intent — deliberately, so that a balance is only ever credited by the
 * processor's own confirmation and never by this optimistic path.
 */
export async function settleAutoRecharge(
  attemptId: string,
  externalRef: string
): Promise<void> {
  await getDb()
    .update(billingAutoRechargeAttempts)
    .set({ status: 'succeeded', externalRef, updatedAt: new Date() })
    .where(
      and(
        eq(billingAutoRechargeAttempts.id, attemptId),
        eq(billingAutoRechargeAttempts.status, 'pending')
      )
    );
}

/**
 * Mark a claimed attempt as refused.
 *
 * The claim is NOT released. A declined card declines again, and releasing the
 * window would retry it every sweep — which reads to the customer's bank as
 * card-testing and to the customer as a wall of decline notifications. The next
 * window is soon enough.
 */
export async function failAutoRecharge(
  attemptId: string,
  failureCode?: string
): Promise<void> {
  await getDb()
    .update(billingAutoRechargeAttempts)
    .set({
      status: 'failed',
      failureCode: failureCode?.slice(0, 64),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(billingAutoRechargeAttempts.id, attemptId),
        eq(billingAutoRechargeAttempts.status, 'pending')
      )
    );
}

/** An account's recent automatic top-ups, newest first. */
export async function listAutoRechargeAttempts(
  accountId: string,
  limit = 20
): Promise<BillingAutoRechargeAttemptRow[]> {
  return getDb()
    .select()
    .from(billingAutoRechargeAttempts)
    .where(eq(billingAutoRechargeAttempts.accountId, accountId))
    .orderBy(desc(billingAutoRechargeAttempts.createdAt))
    .limit(limit);
}
