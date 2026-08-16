/**
 * Entitlement Service — the interface a product asks "what may this account do",
 * built so the answer cannot be mistaken for a balance.
 *
 * #972 section 7.5 names the failure outright: confusing a product subscription
 * (an Alia plan) with pay-as-you-go inference usage. The separation is
 * structural here rather than documented:
 *
 *  - ALLOWANCES are whole integer counts of a product entitlement. They are
 *    `number`s, in `planAllowanceSchema`.
 *  - MONEY is an exact decimal string, in `payAsYouGoEntitlementSchema`.
 *
 * Nothing in this module adds one to the other, and no shape it returns has a
 * field that is both. A consumer that wanted "how much can this account do"
 * reads two sections and presents two sections.
 *
 * ## An allowance does not change what a request COSTS
 *
 * An Alia plan may include a monthly allowance of inference. Oxy still records
 * the exact underlying cost of every request against the account's ledger — the
 * allowance decides what ALIA charges its user, not what the receipt says. That
 * is why nothing here touches pricing, and why `productPlanSchema` carries no
 * price: a plan able to restate the cost of a request would be a second pricing
 * authority, and a receipt has exactly one.
 *
 * ## One inheritance rule, not two
 *
 * A project draws on the nearest ancestor with a billing profile (ADR 0014). The
 * PLAN follows the same tree for the same reason: the payer is by definition the
 * account that bought things on behalf of this subtree, so a plan it holds
 * covers what it pays for. Two different inheritance rules over one account
 * graph is how "which org am I really under" becomes a support ticket.
 *
 * ## Cost centres are accounts
 *
 * `internal_cost_centers` labels an existing project ACCOUNT; there is no
 * parallel hierarchy and no column on any receipt. Attribution is therefore the
 * same nearest-ancestor walk again, over `user_ancestors` — three uses of one
 * materialised path rather than three ideas about the shape of the tree.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import {
  costCenterSchema,
  costCenterSpendSchema,
  LIVE_PRODUCT_PLAN_STATUSES,
  payAsYouGoEntitlementSchema,
  productEntitlementSchema,
  productPlanSchema,
  type CostCenter,
  type CostCenterSpend,
  type PlanAllowance,
  type ProductEntitlement,
  type ProductPlan,
} from '@oxyhq/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { billingSubscriptions } from '../db/schema/billingSubscriptions';
import { internalCostCenters } from '../db/schema/internalCostCenters';
import { userCredits } from '../db/schema/userCredits';
import { users } from '../db/schema/users';
import { resolveAccountBillingState } from './accountBilling.service';
import { resolveApplicationOwnerAccount } from './attribution.service';
import { resolveBillingAccount } from './inferenceLedger.service';

type InternalCostCenterRow = typeof internalCostCenters.$inferSelect;

type BillingSubscriptionRow = typeof billingSubscriptions.$inferSelect;

/**
 * The allowance keys this platform issues.
 *
 * A closed set, exported, because a product branching on an allowance key needs
 * the same vocabulary the server emits — a consumer inventing its own string
 * would silently never match.
 */
export const ALLOWANCE_KEYS = {
  /** The daily-refreshing free tier. `remaining` is metered. */
  free: 'api_credits_free',
  /** Credits a plan includes each period. Not separately metered — see below. */
  monthly: 'api_credits_monthly',
  /** A stock of purchased credits. For a stock, `included` IS what is left. */
  purchased: 'api_credits_purchased',
} as const;

// ===========================================================================
// Serializers
// ===========================================================================

export function toCostCenter(row: InternalCostCenterRow): CostCenter {
  return costCenterSchema.parse({
    schemaVersion: 1,
    accountId: row.accountId,
    slug: row.slug,
    label: row.label,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * `live` is COMPUTED from the status against `LIVE_PRODUCT_PLAN_STATUSES` rather
 * than stored, and the constant is the contract's own — so Oxy and every product
 * consuming this answer "is the plan in force" identically. A consumer deriving
 * its own list is how `past_due` comes to be honoured in one place and refused
 * in another.
 */
export function toProductPlan(row: BillingSubscriptionRow): ProductPlan {
  const live = (LIVE_PRODUCT_PLAN_STATUSES as readonly string[]).includes(row.status);
  return productPlanSchema.parse({
    id: row.id,
    name: row.planName,
    status: row.status,
    live,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    allowances: [
      {
        key: ALLOWANCE_KEYS.monthly,
        included: row.planCreditsPerMonth,
      },
    ],
  });
}

// ===========================================================================
// Plans
// ===========================================================================

/**
 * The live subscription of an account, or of the account that pays for it.
 *
 * Two point lookups rather than one query over an ancestor set: the common case
 * is a personal account with its own plan, and the second lookup only happens
 * for an account that has none — which is also the only case where the answer
 * could come from somewhere else.
 */
async function resolveLivePlan(
  db: DatabaseOrTransaction,
  accountId: string,
  payerAccountId: string | undefined
): Promise<BillingSubscriptionRow | undefined> {
  const candidates = payerAccountId === undefined || payerAccountId === accountId
    ? [accountId]
    : [accountId, payerAccountId];

  for (const candidate of candidates) {
    const [row] = await db
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.userId, candidate),
          inArray(billingSubscriptions.status, LIVE_PRODUCT_PLAN_STATUSES)
        )
      )
      .limit(1);
    if (row) return row;
  }
  return undefined;
}

// ===========================================================================
// Cost centres
// ===========================================================================

/**
 * The nearest cost centre at or above an account, or `undefined`.
 *
 * `order by is_self desc, depth desc` — the account itself first, then the
 * DEEPEST ancestor, which is the immediate parent, because `user_ancestors` is
 * ordered root-first by depth. Byte-for-byte the ordering `resolveBillingAccount`
 * uses, deliberately: three different walks of one path that disagreed about
 * "nearest" would be three different trees.
 */
export async function resolveCostCenterForAccount(
  accountId: string
): Promise<CostCenter | undefined> {
  if (!accountId) return undefined;

  const rows = await executeRows<{
    account_id: string;
    slug: string;
    label: string;
    status: 'active' | 'retired';
    created_at: Date;
    updated_at: Date;
  }>(
    getDb(),
    sql`
      select account_id, slug, label, status, created_at, updated_at
      from (
        select c.*, true as is_self, 0 as depth
        from ${internalCostCenters} c
        where c.account_id = ${accountId} and c.status = 'active'
        union all
        select c.*, false as is_self, ua.depth
        from ${internalCostCenters} c
        join user_ancestors ua on ua.ancestor_id = c.account_id and ua.user_id = ${accountId}
        where c.status = 'active'
      ) candidate
      order by is_self desc, depth desc
      limit 1
    `
  );

  const row = rows[0];
  if (!row) return undefined;
  return costCenterSchema.parse({
    schemaVersion: 1,
    accountId: row.account_id,
    slug: row.slug,
    label: row.label,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

/**
 * The cost centre an APPLICATION's spend is booked to.
 *
 * Composed rather than joined: the application → owner account hop is
 * `resolveApplicationOwnerAccount`, the one direction ADR 0007 fixes attribution
 * as travelling, and re-implementing it here as a join would be a fifth copy of
 * exactly the chain `attribution.service.ts` exists to stop multiplying.
 */
export async function resolveCostCenterForApplication(
  applicationId: string
): Promise<CostCenter | undefined> {
  const resolved = await resolveApplicationOwnerAccount(applicationId);
  if (resolved.status === 'unknown-application') return undefined;
  return resolveCostCenterForAccount(resolved.application.ownerAccountId);
}

export async function listCostCenters(includeRetired = false): Promise<CostCenter[]> {
  const rows = await getDb()
    .select()
    .from(internalCostCenters)
    .where(includeRetired ? undefined : eq(internalCostCenters.status, 'active'))
    .orderBy(asc(internalCostCenters.slug));
  return rows.map(toCostCenter);
}

export interface RegisterCostCenterInput {
  readonly accountId: string;
  readonly slug: string;
  readonly label: string;
}

export type RegisterCostCenterResult =
  | { readonly status: 'registered'; readonly costCenter: CostCenter }
  | { readonly status: 'unknown-account'; readonly accountId: string }
  | { readonly status: 'slug-taken'; readonly slug: string };

/**
 * Label an account as a cost centre, idempotently on the account.
 *
 * Re-registering the same account updates its label; re-using a slug for a
 * DIFFERENT account is refused, because a slug is how historical reports address
 * a centre and silently re-pointing one would re-attribute every report that
 * names it.
 */
export async function registerCostCenter(
  input: RegisterCostCenterInput
): Promise<RegisterCostCenterResult> {
  const db = getDb();

  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.accountId))
    .limit(1);
  if (!account) {
    return { status: 'unknown-account', accountId: input.accountId };
  }

  const [holder] = await db
    .select({ accountId: internalCostCenters.accountId })
    .from(internalCostCenters)
    .where(eq(internalCostCenters.slug, input.slug))
    .limit(1);
  if (holder && holder.accountId !== input.accountId) {
    return { status: 'slug-taken', slug: input.slug };
  }

  const [row] = await db
    .insert(internalCostCenters)
    .values({ accountId: input.accountId, slug: input.slug, label: input.label })
    .onConflictDoUpdate({
      target: internalCostCenters.accountId,
      // `excluded.<col>` spelled out: interpolating the column object emits the
      // JS PROPERTY name, so camelCase becomes `excluded.costcenterslug` and the
      // statement fails at runtime with 42703.
      set: {
        slug: sql`excluded.slug`,
        label: sql`excluded.label`,
        status: sql`'active'`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return { status: 'registered', costCenter: toCostCenter(row) };
}

export type RetireCostCenterResult =
  | { readonly status: 'retired'; readonly costCenter: CostCenter }
  | { readonly status: 'unknown-cost-center'; readonly slug: string };

/**
 * Take a cost centre out of the picker without making past reports unreadable.
 *
 * There is deliberately no delete. A retired centre still names the account past
 * spend was booked to, and `resolveCostCenterForAccount` filters on `active`, so
 * new spend stops being attributed to it while historical queries that name it
 * by slug keep resolving.
 */
export async function retireCostCenter(slug: string): Promise<RetireCostCenterResult> {
  const [row] = await getDb()
    .update(internalCostCenters)
    .set({ status: 'retired', updatedAt: new Date() })
    .where(eq(internalCostCenters.slug, slug))
    .returning();
  return row === undefined
    ? { status: 'unknown-cost-center', slug }
    : { status: 'retired', costCenter: toCostCenter(row) };
}

export interface CostCenterSpendQuery {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly currency: string;
}

interface CostCenterSpendRow extends Record<string, unknown> {
  account_id: string;
  slug: string;
  label: string;
  status: 'active' | 'retired';
  created_at: Date;
  updated_at: Date;
  billed_amount: string;
  request_count: string;
}

/**
 * What each cost centre spent over a window, from the FINANCIAL ledger.
 *
 * `usage_receipts.billed_amount`, never a telemetry sum — #972 workstream 8 is
 * explicit that the exact billed amount comes from the ledger, and telemetry is
 * a 90-day stream with float credits that must never become the financial
 * record. `request_count` counts the same receipts, so the two numbers are
 * always about one set of rows.
 *
 * ## Attributed through the APPLICATION's owner, not through `receipt.account_id`
 *
 * This is the one place the two account ids on a request genuinely differ, and
 * picking the wrong one silently rolls every project's spend up to its parent.
 * `usage_receipts.account_id` is the account whose BOOKS the charge lands in —
 * the payer, resolved through the billing-profile inheritance walk. A cost
 * centre asks a different question: which internal workload incurred it. That is
 * `applications.owner_account_id`, which ADR 0007 fixes as the canonical
 * attribution account, and it is why this joins through `applications` rather
 * than reading the column already sitting on the receipt.
 *
 * With one organization paying for five project accounts — exactly the shape
 * #972 workstream 14 describes — reading `receipt.account_id` would attribute
 * all five workloads to the organization and every per-team report would be the
 * same number.
 *
 * The LATERAL then picks the NEAREST cost centre above that account, which is
 * what lets a nested centre (say `codea` under `alia`) keep its own spend.
 * Retired centres are included as targets here, unlike in
 * `resolveCostCenterForAccount`: a report over a past window has to be able to
 * name a centre that has since been retired, or last quarter's spend silently
 * rolls up to its parent.
 *
 * Timestamps are bound as ISO strings with an explicit cast. A bare `Date` fails
 * at SERIALISATION in the driver, and this is a raw `execute`, so drizzle's
 * result mapper and its parameter handling are both out of the picture.
 */
export async function costCenterSpend(query: CostCenterSpendQuery): Promise<CostCenterSpend[]> {
  const rows = await executeRows<CostCenterSpendRow>(
    getDb(),
    sql`
      select
        cc.account_id,
        cc.slug,
        cc.label,
        cc.status,
        cc.created_at,
        cc.updated_at,
        round(sum(r.billed_amount), 12)::text as billed_amount,
        count(*)::text as request_count
      from usage_receipts r
      join applications app on app.id = r.application_id
      join lateral (
        select candidate.*
        from (
          select c.*, true as is_self, 0 as depth
          from ${internalCostCenters} c
          where c.account_id = app.owner_account_id
          union all
          select c.*, false as is_self, ua.depth
          from ${internalCostCenters} c
          join user_ancestors ua
            on ua.ancestor_id = c.account_id and ua.user_id = app.owner_account_id
        ) candidate
        order by candidate.is_self desc, candidate.depth desc
        limit 1
      ) cc on true
      where r.currency = ${query.currency}
        and r.settled_at >= ${query.periodStart.toISOString()}::timestamptz
        and r.settled_at < ${query.periodEnd.toISOString()}::timestamptz
      group by cc.account_id, cc.slug, cc.label, cc.status, cc.created_at, cc.updated_at
      order by cc.slug
    `
  );

  return rows.map((row) =>
    costCenterSpendSchema.parse({
      schemaVersion: 1,
      costCenter: {
        schemaVersion: 1,
        accountId: row.account_id,
        slug: row.slug,
        label: row.label,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      },
      currency: query.currency,
      periodStart: query.periodStart.toISOString(),
      periodEnd: query.periodEnd.toISOString(),
      billedAmount: row.billed_amount,
      // `count(*)` is a bigint, which postgres.js decodes as a STRING while
      // drizzle would type it `number`. Cast to text in SQL and parse here, so
      // the conversion is visible rather than a silent string in a number field.
      requestCount: Number(row.request_count),
    })
  );
}

// ===========================================================================
// The interface Alia queries
// ===========================================================================

export type ProductEntitlementResolution =
  | { readonly status: 'resolved'; readonly entitlement: ProductEntitlement }
  | { readonly status: 'unknown-account'; readonly accountId: string };

/**
 * Everything a product needs to decide what an account may do, in one read.
 *
 * `payAsYouGo` is `null` when no account up the ancestry has a billing profile.
 * That is a REAL state, distinct from a zero balance, and the distinction is the
 * audit's §6 finding: zero means "spent everything", `null` means "nobody has
 * decided who pays for this account yet". A consumer that treated them alike
 * would refuse a customer who has simply never been provisioned, or — worse —
 * serve one who can never be charged.
 */
export async function resolveProductEntitlement(
  accountId: string
): Promise<ProductEntitlementResolution> {
  const db = getDb();

  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  if (!account) {
    return { status: 'unknown-account', accountId };
  }

  const billingResolution = await resolveBillingAccount(db, accountId);
  const payerAccountId =
    billingResolution.status === 'resolved'
      ? billingResolution.billingAccount.accountId
      : undefined;

  const [planRow, credits, billingState, costCenter] = await Promise.all([
    resolveLivePlan(db, accountId, payerAccountId),
    loadAccountCredits(db, accountId),
    resolveAccountBillingState(accountId),
    resolveCostCenterForAccount(accountId),
  ]);

  const plan = planRow === undefined ? null : toProductPlan(planRow);

  const allowances: PlanAllowance[] = [];
  if (credits !== undefined) {
    allowances.push({
      key: ALLOWANCE_KEYS.free,
      included: credits.creditsFreeLimit,
      remaining: credits.creditsFree,
    });
    if (credits.creditsPaid > 0) {
      // A STOCK, not a per-period grant: for a stock the entitlement's size and
      // what is left are the same number, and reporting `included: 0` beside a
      // non-zero remainder would read as an exhausted allowance.
      allowances.push({
        key: ALLOWANCE_KEYS.purchased,
        included: credits.creditsPaid,
        remaining: credits.creditsPaid,
      });
    }
  }
  if (plan !== null) {
    // The plan's own monthly grant. No `remaining`: the platform credits it into
    // the same purchased balance on renewal rather than metering it separately,
    // so a `remaining` here would be an invented number.
    allowances.push(...plan.allowances);
  }

  const payAsYouGo =
    billingState.status === 'resolved'
      ? payAsYouGoEntitlementSchema.parse({
          billingAccountId: billingState.state.billingAccountId,
          currency: billingState.state.balance.currency,
          billingMode: billingState.state.profile.billingMode,
          purchasedBalance: billingState.state.balance.purchasedBalance,
          promotionalBalance: billingState.state.balance.promotionalBalance,
          availableToSpend: billingState.state.balance.availableToSpend,
          canSpend:
            billingState.state.profile.status === 'active' &&
            Number(billingState.state.balance.availableToSpend) > 0,
        })
      : null;

  return {
    status: 'resolved',
    entitlement: productEntitlementSchema.parse({
      schemaVersion: 1,
      accountId,
      plan,
      allowances,
      payAsYouGo,
      costCenter: costCenter ?? null,
      resolvedAt: new Date().toISOString(),
    }),
  };
}

async function loadAccountCredits(
  db: DatabaseOrTransaction,
  accountId: string
): Promise<
  | {
      creditsFree: number;
      creditsFreeLimit: number;
      creditsPaid: number;
    }
  | undefined
> {
  const [row] = await db
    .select({
      creditsFree: userCredits.creditsFree,
      creditsFreeLimit: userCredits.creditsFreeLimit,
      creditsPaid: userCredits.creditsPaid,
    })
    .from(userCredits)
    .where(eq(userCredits.userId, accountId))
    .limit(1);
  return row;
}

/** The most recently registered cost centres, for a staff listing. */
export async function recentCostCenters(limit = 50): Promise<CostCenter[]> {
  const rows = await getDb()
    .select()
    .from(internalCostCenters)
    .orderBy(desc(internalCostCenters.createdAt))
    .limit(limit);
  return rows.map(toCostCenter);
}
