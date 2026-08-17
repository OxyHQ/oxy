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

import { and, desc, eq, sql } from 'drizzle-orm';
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
 * One audit event as `GET /applications/:appId/credentials/:credId/audit`
 * returns it.
 *
 * Declared explicitly, and `metadata` is NOT a member of it. That column is the
 * table's one open-shaped surface: several code paths write it, the writers above
 * are what keep token material out of it, and a wire type with no such property
 * is a stronger guarantee than a serializer that remembers to drop it — a
 * projection that tried to include it would have to change this type first. It is
 * the same argument `CREDENTIAL_COLUMNS` in `routes/applications.ts` makes about
 * the two hash columns, and the same conclusion the Console reached from the
 * other end for the BYOK trail (`use-provider-connections.ts` projects
 * `metadata` away rather than merely not rendering it).
 *
 * Nothing readable is lost with it: a rotation's counterpart is on the
 * credential row as `rotated_from_credential_id`, a credential's type and scopes
 * are on the credential row, and a configured grace deadline is
 * {@link CredentialAuditTrailEntry.effectiveUntil}. The one key that lives
 * nowhere else is `requiredScope` on a `scope_missing` refusal, and if a surface
 * needs it, it arrives as its own typed column or field — deliberately, not by
 * opening a jsonb blob onto the wire.
 */
export interface CredentialAuditTrailEntry {
  readonly eventType: CredentialAuditEventType;
  /** Why a `validation_failed` event happened; null on the three transitions. */
  readonly reason: CredentialValidationFailureReason | null;
  /** The member who performed a transition; null on `validation_failed`. */
  readonly actorUserId: string | null;
  readonly environment: string | null;
  readonly createdAt: string;
  /** A deadline the event established — a rotation grace end. */
  readonly effectiveUntil: string | null;
}

/**
 * One credential's trail as the route serves it, newest first.
 *
 * Reads the compound index on `(credential_id, created_at desc)`. The caller has
 * already established that the credential belongs to the application it asked
 * under — this function authorises nothing.
 *
 * `id` is a secondary sort so a page is stable across reads, not because it
 * orders anything: a rotation writes the `rotated` row and the replacement's
 * `created` row in ONE transaction, so they share an instant (`now()` is the
 * transaction's start time) and uuid v7 is not monotone within a millisecond.
 * Their relative order is arbitrary and must not be read as a sequence.
 */
export async function listCredentialAuditTrail(
  credentialId: string,
  limit: number
): Promise<readonly CredentialAuditTrailEntry[]> {
  const rows = await getDb()
    .select({
      eventType: applicationCredentialAuditEvents.eventType,
      reason: applicationCredentialAuditEvents.reason,
      actorUserId: applicationCredentialAuditEvents.actorUserId,
      environment: applicationCredentialAuditEvents.environment,
      createdAt: applicationCredentialAuditEvents.createdAt,
      effectiveUntil: applicationCredentialAuditEvents.effectiveUntil,
    })
    .from(applicationCredentialAuditEvents)
    .where(eq(applicationCredentialAuditEvents.credentialId, credentialId))
    .orderBy(
      desc(applicationCredentialAuditEvents.createdAt),
      desc(applicationCredentialAuditEvents.id)
    )
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
  }));
}

/**
 * Every audit event for one credential, newest first, as stored — every column,
 * `metadata` included. Reads the same compound index as
 * {@link listCredentialAuditTrail}.
 *
 * The full row, for the tests that assert what a writer put in `metadata`. No
 * route uses it, and none should: the wire shape is
 * {@link CredentialAuditTrailEntry}.
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
