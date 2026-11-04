/**
 * Registered-account ledger and its bounded aggregate for one first-party
 * deployment. See `db/schema/applicationAccountRegistrations.ts` for why the
 * ledger exists and why the total is a snapshot.
 *
 * ## Cost model
 *
 * - A public/read request does ONE primary-key read of `application_account_totals`.
 *   It never counts, never lists accounts and never calls another service.
 * - A recount touches only that application's ledger rows (index range on the
 *   primary key, one primary-key probe of `users` per row), runs under a 10 s
 *   `statement_timeout`, and happens at most once per `MAX_AGE` per application
 *   cluster-wide: a transaction-scoped advisory lock makes concurrent API
 *   instances skip instead of stacking, and the winner re-reads the snapshot under
 *   the lock before counting.
 * - A stale snapshot is served while one background refresh runs; a failed
 *   refresh leaves the last good row untouched. With no snapshot at all the first
 *   reader counts synchronously, and everyone else gets `Unavailable` rather than a
 *   made-up zero.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  APPLICATION_ACCOUNT_TOTAL_MAX_AGE_SECONDS,
  type ApplicationAccountTotal,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import {
  applicationAccountRegistrations,
  applicationAccountTotals,
} from '../db/schema/applicationAccountRegistrations';
import { users } from '../db/schema/users';
import { ServiceUnavailableError } from '../utils/error';
import { logger } from '../utils/logger';

const MAX_AGE_MS = APPLICATION_ACCOUNT_TOTAL_MAX_AGE_SECONDS * 1000;
const REFRESH_STATEMENT_TIMEOUT_MS = 10_000;

/** One in-process refresh per application; the advisory lock covers other instances. */
const refreshing = new Map<string, Promise<void>>();

/**
 * Register accounts as users of `applicationId`. Unknown and ineligible ids are
 * skipped silently. Returns how many rows were newly inserted.
 */
export async function registerApplicationAccounts(
  applicationId: string,
  accountIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return 0;
  const inserted = await getDb()
    .insert(applicationAccountRegistrations)
    .select(
      getDb()
        .select({
          applicationId: sql<string>`${applicationId}`.as('application_id'),
          userId: users.id,
          createdAt: sql`date_trunc('milliseconds', now())`.as('created_at'),
        })
        .from(users)
        .where(and(eligibleAccount(), sql`${users.id} = any(${sql.param(ids)}::text[])`)),
    )
    .onConflictDoNothing()
    .returning({ userId: applicationAccountRegistrations.userId });
  return inserted.length;
}

/** A local, personal, active account that is not being closed. */
function eligibleAccount() {
  return and(
    eq(users.type, 'local'),
    eq(users.kind, 'personal'),
    eq(users.accountStatus, 'active'),
    sql`not exists (select 1 from ${accountClosureFences} where ${accountClosureFences.accountId} = ${users.id})`,
  );
}

function toTotal(
  applicationId: string,
  row: { total: number; computedAt: Date },
  now: number,
): ApplicationAccountTotal {
  return {
    schemaVersion: 1,
    applicationId,
    total: row.total,
    exact: true,
    computedAt: row.computedAt.toISOString(),
    maxAgeSeconds: APPLICATION_ACCOUNT_TOTAL_MAX_AGE_SECONDS,
    stale: now - row.computedAt.getTime() > MAX_AGE_MS,
  };
}

async function readSnapshot(applicationId: string) {
  const [row] = await getDb()
    .select({
      total: applicationAccountTotals.total,
      computedAt: applicationAccountTotals.computedAt,
    })
    .from(applicationAccountTotals)
    .where(eq(applicationAccountTotals.applicationId, applicationId));
  return row;
}

/**
 * Recount under the cluster-wide lock. Returns without writing when another
 * instance holds the lock or already refreshed within `MAX_AGE`.
 */
async function refresh(applicationId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`set local statement_timeout = ${sql.raw(String(REFRESH_STATEMENT_TIMEOUT_MS))}`,
    );
    const locked = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`application-account-total:${applicationId}`}, 0)) as locked`,
    );
    if (!locked[0]?.locked) return;
    const [current] = await tx
      .select({ computedAt: applicationAccountTotals.computedAt })
      .from(applicationAccountTotals)
      .where(eq(applicationAccountTotals.applicationId, applicationId));
    if (current && Date.now() - current.computedAt.getTime() <= MAX_AGE_MS) return;
    const [counted] = await tx
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(applicationAccountRegistrations)
      .innerJoin(users, eq(users.id, applicationAccountRegistrations.userId))
      .where(
        and(eq(applicationAccountRegistrations.applicationId, applicationId), eligibleAccount()),
      );
    const total = counted?.total ?? 0;
    await tx
      .insert(applicationAccountTotals)
      .values({ applicationId, total, computedAt: sql`now()` })
      .onConflictDoUpdate({
        target: applicationAccountTotals.applicationId,
        set: { total, computedAt: sql`now()` },
      });
  });
}

function refreshOnce(applicationId: string): Promise<void> {
  const existing = refreshing.get(applicationId);
  if (existing) return existing;
  const pending = refresh(applicationId).finally(() => refreshing.delete(applicationId));
  refreshing.set(applicationId, pending);
  return pending;
}

/**
 * The deployment's eligible registered-account total. Serves the stored snapshot;
 * a stale one triggers a single background refresh and is flagged `stale`.
 * Throws {@link ServiceUnavailableError} when no snapshot exists and none can be
 * produced now (never a zero).
 */
export async function readApplicationAccountTotal(
  applicationId: string,
): Promise<ApplicationAccountTotal> {
  const snapshot = await readSnapshot(applicationId);
  const now = Date.now();
  if (snapshot) {
    const total = toTotal(applicationId, snapshot, now);
    if (total.stale) {
      refreshOnce(applicationId).catch((error: unknown) =>
        logger.warn('Application account total refresh failed; serving last good value', {
          applicationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return total;
  }
  try {
    await refreshOnce(applicationId);
  } catch (error) {
    logger.warn('Application account total cold refresh failed', {
      applicationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const computed = await readSnapshot(applicationId);
  if (!computed)
    throw new ServiceUnavailableError('The registered-account total is not available yet');
  return toTotal(applicationId, computed, Date.now());
}
