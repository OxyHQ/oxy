/**
 * Suppression list: the addresses this platform must not send to, and why.
 *
 * A bounce or a complaint is only useful if the next send is refused. Provider
 * suppression alone is not enough — SES will silently drop the message, but the
 * ATTEMPT still counts toward the bounce rate that gets a domain suspended, and
 * the sender is told nothing. Checking here means the user finds out at compose
 * time, in words they can act on.
 *
 * Scope rules (see the table's docblock for why):
 *  - `user_id IS NULL` — the address itself is bad, nobody may send to it.
 *  - `user_id = X`     — a complaint against X only; other senders are unaffected.
 */

import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import {
  emailSuppressions,
  type EmailSuppressionReason,
  type EmailSuppressionSource,
} from '../db/schema/emailSuppressions';
import { logger } from '../utils/logger';

/** How long a transient bounce holds an address back before it is retried. */
const TRANSIENT_BOUNCE_TTL_MS = 24 * 60 * 60 * 1000;

const DIAGNOSTIC_MAX_LENGTH = 500;

/** Addresses are compared case-insensitively; store and query the same form. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export interface SuppressionHit {
  address: string;
  reason: EmailSuppressionReason;
  diagnostic: string | null;
  reportedAt: Date;
}

/**
 * Which of `addresses` this user may not send to right now.
 *
 * One query for the whole recipient list — a per-recipient round trip would put
 * N queries on the compose path. Expired transient rows are filtered in SQL, so
 * a lapsed backoff needs no sweep to become sendable again.
 */
export async function findSuppressed(
  userId: string,
  addresses: readonly string[],
): Promise<SuppressionHit[]> {
  const normalized = [...new Set(addresses.map(normalizeAddress))].filter((a) => a.length > 0);
  if (normalized.length === 0) return [];

  const rows = await getDb()
    .select({
      address: emailSuppressions.address,
      reason: emailSuppressions.reason,
      diagnostic: emailSuppressions.diagnostic,
      reportedAt: emailSuppressions.reportedAt,
    })
    .from(emailSuppressions)
    .where(
      and(
        // `inArray`, not `= any(${array})`: a JS array interpolated into a
        // `sql` template binds as a TUPLE and Postgres answers
        // "malformed array literal" — the trap CONVENTIONS.md names.
        inArray(emailSuppressions.address, normalized),
        // Global rows bind everyone; scoped rows bind only their own sender.
        or(isNull(emailSuppressions.userId), eq(emailSuppressions.userId, userId)),
        or(isNull(emailSuppressions.expiresAt), gt(emailSuppressions.expiresAt, new Date())),
      ),
    );

  return rows;
}

export interface RecordSuppressionInput {
  address: string;
  reason: EmailSuppressionReason;
  source: EmailSuppressionSource;
  /** Required for `complaint`; the table refuses a global complaint row. */
  userId?: string | null;
  diagnostic?: string | null;
  reportedAt?: Date;
}

/**
 * Record one suppression, replacing any previous verdict for the same scope.
 *
 * Upsert rather than insert: a permanent bounce arriving after a transient one
 * must REPLACE it (and clear its expiry), not collide. The unique constraint is
 * `NULLS NOT DISTINCT`, so the global and scoped rows for an address are two
 * separate rows and neither overwrites the other.
 */
export async function recordSuppression(input: RecordSuppressionInput): Promise<void> {
  const address = normalizeAddress(input.address);
  if (!address) return;

  const expiresAt = input.reason === 'bounce_transient'
    ? new Date(Date.now() + TRANSIENT_BOUNCE_TTL_MS)
    : null;

  await getDb()
    .insert(emailSuppressions)
    .values({
      userId: input.userId ?? null,
      address,
      reason: input.reason,
      source: input.source,
      diagnostic: input.diagnostic?.slice(0, DIAGNOSTIC_MAX_LENGTH) ?? null,
      reportedAt: input.reportedAt ?? new Date(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [emailSuppressions.userId, emailSuppressions.address],
      set: {
        reason: input.reason,
        source: input.source,
        diagnostic: input.diagnostic?.slice(0, DIAGNOSTIC_MAX_LENGTH) ?? null,
        reportedAt: input.reportedAt ?? new Date(),
        expiresAt,
        updatedAt: new Date(),
      },
    });

  logger.info('Email address suppressed', {
    reason: input.reason,
    source: input.source,
    scoped: Boolean(input.userId),
  });
}

/**
 * Lift a suppression. Used when the account holder says the address is fine
 * after all (a typo they have since corrected on the far end, a mailbox that
 * was full). Never called automatically for a permanent bounce.
 */
export async function liftSuppression(userId: string | null, address: string): Promise<boolean> {
  const normalized = normalizeAddress(address);
  const result = await getDb()
    .delete(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.address, normalized),
        userId === null ? isNull(emailSuppressions.userId) : eq(emailSuppressions.userId, userId),
      ),
    )
    .returning({ id: emailSuppressions.id });
  return result.length > 0;
}

/** Every suppression that currently binds this user, newest first. */
export async function listSuppressions(userId: string, limit = 100): Promise<SuppressionHit[]> {
  return getDb()
    .select({
      address: emailSuppressions.address,
      reason: emailSuppressions.reason,
      diagnostic: emailSuppressions.diagnostic,
      reportedAt: emailSuppressions.reportedAt,
    })
    .from(emailSuppressions)
    .where(
      and(
        or(isNull(emailSuppressions.userId), eq(emailSuppressions.userId, userId)),
        or(isNull(emailSuppressions.expiresAt), gt(emailSuppressions.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(emailSuppressions.reportedAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}
