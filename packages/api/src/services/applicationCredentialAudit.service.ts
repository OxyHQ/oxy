/**
 * The only writer of `application_credential_audit_events` (issue #972 §2.3).
 *
 * Two entry points, and they differ in a way that matters:
 *
 *   - {@link recordCredentialLifecycleEvent} takes a transaction handle and is
 *     called INSIDE the same transaction as the mutation it records. A minted
 *     credential whose audit row was lost is a credential nobody can account
 *     for, so the two land together or neither does.
 *   - {@link recordCredentialValidationFailure} is best-effort and opens its own
 *     write. It runs on the authentication path, where a database hiccup must
 *     turn a 401 into a 401 — not into a 500 that tells the caller their token
 *     might have been fine.
 *
 * Neither ever receives token material. The signatures take ids and a closed
 * reason, so there is no parameter through which a secret could arrive; the
 * `metadata` this module builds is assembled here rather than passed in.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import {
  applicationCredentialAuditEvents,
  type CredentialAuditEventType,
  type CredentialValidationFailureReason,
} from '../db/schema/applicationCredentialAuditEvents';
import type { ApplicationCredentialEnvironment } from '../db/schema/applicationCredentials';
import { logger } from '../utils/logger';

/** The drizzle handle a lifecycle write runs on — a transaction, in practice. */
type Writer = Pick<ReturnType<typeof getDb>, 'insert'>;

/**
 * How long one instance suppresses a repeat of the SAME `(credential, reason)`
 * failure.
 *
 * A deployed service pointed at a revoked key retries forever, and without this
 * every one of those retries is an insert. Sixty seconds keeps the signal —
 * "this key started failing at 14:02 and is still failing at 14:03" — while
 * turning a runaway client from thousands of rows an hour into sixty.
 *
 * Per instance, deliberately. A shared counter would need Redis on the auth
 * path's failure branch, and N instances × one row a minute is still bounded.
 */
const FAILURE_COOLDOWN_MS = 60_000;

/**
 * Hard ceiling on the cooldown map. Reached only under a distributed attack
 * against many credentials at once — exactly when unbounded growth would matter
 * — and the consequence of eviction is an extra audit row, never a missed one.
 */
const FAILURE_COOLDOWN_MAX_ENTRIES = 10_000;

/**
 * `credentialId:reason` → the epoch millisecond the suppression expires.
 *
 * A plain `Map`, swept lazily on write rather than by a timer: a module-level
 * `setInterval` in this package has to be `unref`'d or it hangs jest, and there
 * is nothing here worth that risk when the write path can do the same work.
 */
const failureCooldown = new Map<string, number>();

/**
 * True when this instance has already recorded `(credentialId, reason)` inside
 * the cooldown; otherwise records the suppression and returns false.
 *
 * Exported for the test that proves the cooldown is what bounds the table, and
 * so a test can reset it — module state shared across cases is otherwise a
 * source of order-dependent failures.
 */
export function shouldSuppressFailureAudit(
  credentialId: string,
  reason: CredentialValidationFailureReason,
  now: number = Date.now()
): boolean {
  const key = `${credentialId}:${reason}`;
  const until = failureCooldown.get(key);
  if (until !== undefined && until > now) {
    return true;
  }

  // Lazy sweep. Only when the map is at its ceiling, so the ordinary path stays
  // a single lookup and an insert.
  if (failureCooldown.size >= FAILURE_COOLDOWN_MAX_ENTRIES) {
    for (const [entryKey, entryUntil] of failureCooldown) {
      if (entryUntil <= now) {
        failureCooldown.delete(entryKey);
      }
    }
    // Still full: every entry is live. Drop the oldest insertion (Map iterates
    // in insertion order) so the map cannot grow without bound.
    if (failureCooldown.size >= FAILURE_COOLDOWN_MAX_ENTRIES) {
      const oldest = failureCooldown.keys().next();
      if (!oldest.done) {
        failureCooldown.delete(oldest.value);
      }
    }
  }

  failureCooldown.set(key, now + FAILURE_COOLDOWN_MS);
  return false;
}

/** Clear the cooldown. Tests only — production has no reason to forget. */
export function resetFailureAuditCooldown(): void {
  failureCooldown.clear();
}

/** An administrative transition someone performed on a credential. */
export interface CredentialLifecycleEvent {
  applicationId: string;
  credentialId: string;
  eventType: Extract<CredentialAuditEventType, 'created' | 'rotated' | 'revoked'>;
  /** The member who performed it. Required — these events always have an actor. */
  actorUserId: string;
  environment: ApplicationCredentialEnvironment;
  /** Event-specific detail. Assembled by the caller from ids and flags only. */
  metadata?: Record<string, unknown>;
  /** A deadline the event establishes — a rotation grace end. */
  effectiveUntil?: Date | null;
}

/**
 * Record an administrative transition, on the caller's transaction.
 *
 * Takes the writer rather than reaching for `getDb()` so the row cannot land
 * without the mutation it describes. It deliberately does NOT catch: a failure
 * here must roll the whole transaction back.
 */
export async function recordCredentialLifecycleEvent(
  writer: Writer,
  event: CredentialLifecycleEvent
): Promise<void> {
  await writer.insert(applicationCredentialAuditEvents).values({
    applicationId: event.applicationId,
    credentialId: event.credentialId,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    environment: event.environment,
    metadata: event.metadata ?? {},
    effectiveUntil: event.effectiveUntil ?? null,
  });
}

/** A bearer that resolved to a real credential and was still refused. */
export interface CredentialValidationFailure {
  applicationId: string;
  credentialId: string;
  reason: CredentialValidationFailureReason;
  environment: ApplicationCredentialEnvironment;
  /** Detail: the scope a request wanted, the environment it arrived at. */
  metadata?: Record<string, unknown>;
}

/**
 * Record a refused bearer. Best-effort by design — see the module header.
 *
 * Returns whether a row was written, so a caller (and the gate on the cooldown)
 * can tell "suppressed" from "failed to write", which the void return of a
 * fire-and-forget would flatten into one.
 */
export async function recordCredentialValidationFailure(
  failure: CredentialValidationFailure
): Promise<boolean> {
  if (shouldSuppressFailureAudit(failure.credentialId, failure.reason)) {
    return false;
  }

  try {
    await getDb().insert(applicationCredentialAuditEvents).values({
      applicationId: failure.applicationId,
      credentialId: failure.credentialId,
      eventType: 'validation_failed',
      reason: failure.reason,
      // Never an actor: a refused bearer has nobody behind it, and the table's
      // own CHECK refuses one anyway.
      actorUserId: null,
      environment: failure.environment,
      metadata: failure.metadata ?? {},
    });
    return true;
  } catch (error) {
    logger.error(
      'Failed to record credential validation failure',
      error instanceof Error ? error : new Error(String(error)),
      {
        component: 'applicationCredentialAudit',
        credentialId: failure.credentialId,
        reason: failure.reason,
      }
    );
    return false;
  }
}

/**
 * Every audit event for one credential, newest first. Reads the compound index
 * on `(credential_id, created_at desc)`.
 *
 * Exists for tests and for whatever surface renders the trail; there is no route
 * on it yet, and adding one is a Console question rather than a schema one.
 */
export async function listCredentialAuditEvents(
  credentialId: string,
  limit = 50
): Promise<(typeof applicationCredentialAuditEvents.$inferSelect)[]> {
  return getDb()
    .select()
    .from(applicationCredentialAuditEvents)
    .where(eq(applicationCredentialAuditEvents.credentialId, credentialId))
    .orderBy(sql`${applicationCredentialAuditEvents.createdAt} desc`)
    .limit(limit);
}

/**
 * The audit events of one credential narrowed to one type. Separate from
 * {@link listCredentialAuditEvents} because the assertion "exactly one `created`
 * row exists" is the one a test wants, and filtering in the caller would make it
 * pass on an empty read.
 */
export async function listCredentialAuditEventsOfType(
  credentialId: string,
  eventType: CredentialAuditEventType
): Promise<(typeof applicationCredentialAuditEvents.$inferSelect)[]> {
  return getDb()
    .select()
    .from(applicationCredentialAuditEvents)
    .where(
      and(
        eq(applicationCredentialAuditEvents.credentialId, credentialId),
        eq(applicationCredentialAuditEvents.eventType, eventType)
      )
    )
    .orderBy(sql`${applicationCredentialAuditEvents.createdAt} desc`);
}
