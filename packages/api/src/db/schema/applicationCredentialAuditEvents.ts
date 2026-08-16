/**
 * `application_credential_audit_events` — the credential lifecycle trail
 * (issue #972 §2.3).
 *
 * ## Why a new table rather than an existing one
 *
 * Two audit surfaces already exist and neither fits.
 *
 * `security_activities` is the ACCOUNT's own trail: `user_id` is `not null`, it
 * cascades with the user, its vocabulary is a closed set of person-facing events
 * and `GET /security/activity` renders it to that person. A credential belongs
 * to an APPLICATION, not to a user, and the most important event recorded here —
 * a failed validation — has no user behind it at all, only a bearer someone
 * presented. Widening that table to carry an application-scoped, user-less event
 * would put rows into a user's own security feed that belong to nobody.
 *
 * `api_key_usage_events` is metering: one row per SERVED request, 90-day
 * retention, aggregated into usage and credit reports. A lifecycle event is not
 * a served request and would distort every figure computed from that table.
 *
 * So this is the smallest durable thing that fits, and deliberately not a
 * parallel logging system: it is one append-only table with the same shape as
 * `security_activities` (closed vocabulary rendered as a CHECK, `jsonb` detail,
 * an entry in `db/expiry.ts`) applied to a different subject.
 *
 * ## Append-only
 *
 * No `updated_at`, and nothing updates a row. An audit entry that can be edited
 * is not one.
 *
 * That was originally a rule with nothing behind it — no route issued an
 * `UPDATE`, which is not the same as an `UPDATE` being refused (issue #996).
 * `0043_application_credential_audit_immutability` now refuses one at the
 * database, `BEFORE UPDATE` only so the two-year sweep below still works; the
 * DDL and the reasoning live in `applicationCredentialAuditImmutability.ts`.
 *
 * ## What makes a `validation_failed` row, and why it cannot be spammed
 *
 * A row is written ONLY once the presented token has been resolved to a real
 * credential — so `application_id` always names someone answerable. An
 * unresolvable `oxy_sk_…` writes nothing and is logged only: there is no
 * application to attribute it to, and persisting it would let any anonymous
 * caller drive unbounded inserts.
 *
 * That rule is also the volume bound. Resolution matches the token's full
 * 64-bit id against a unique column, so reaching this table at all costs an
 * attacker 2^64 guesses; in practice these rows appear when a real token is
 * stale, revoked, or pointed at the wrong environment — which is exactly the
 * case worth keeping. A legitimately misconfigured client retrying a dead key
 * IS the remaining volume source, and the write-side cooldown in
 * `services/applicationCredentialAudit.service.ts` bounds that to one row per
 * credential, reason and minute per API instance.
 *
 * ## Retention
 *
 * Two years, matching `security_activities` — the other audit trail on this
 * platform — because the question these rows answer ("when was this key minted,
 * rotated, revoked, and when did it start failing") is asked long after the
 * fact. Registered in `db/expiry.ts` against `created_at`, with the bare btree
 * that sweep's range scan needs.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { users } from './users';

/**
 * The lifecycle vocabulary. The first three are administrative transitions a
 * member performed; the fourth is a bearer that was presented and refused.
 *
 * This tuple is the SINGLE declaration — it renders the CHECK below, and
 * `check-drizzle-snapshot-sync` holds that rendering against the migration the
 * database was built from.
 */
export const CREDENTIAL_AUDIT_EVENT_TYPES = [
  'created',
  'rotated',
  'revoked',
  'validation_failed',
] as const;

export type CredentialAuditEventType = (typeof CREDENTIAL_AUDIT_EVENT_TYPES)[number];

/**
 * Why a presented credential was refused. A CLOSED set, so the column can be
 * grouped and alerted on rather than grepped, and so a new refusal path has to
 * name itself here instead of inventing a string.
 *
 * - `secret_mismatch` — the prefix resolved but the token's hash did not match.
 *   The only reason that implies someone holds a partial or forged token.
 * - `not_usable` — revoked, or past its `expires_at` (an elapsed rotation grace
 *   or a configured expiry; `isCredentialUsable` does not distinguish them and
 *   neither does this).
 * - `environment_mismatch` — a credential minted for another deployment
 *   environment. Almost always a `development` key pointed at production.
 * - `application_inactive` — the owning application is suspended or deleted.
 * - `scope_missing` — the credential authenticated but does not hold the scope
 *   the route requires. Recorded because a key repeatedly asking for authority
 *   it was never granted is worth seeing.
 */
export const CREDENTIAL_VALIDATION_FAILURE_REASONS = [
  'secret_mismatch',
  'not_usable',
  'environment_mismatch',
  'application_inactive',
  'scope_missing',
] as const;

export type CredentialValidationFailureReason =
  (typeof CREDENTIAL_VALIDATION_FAILURE_REASONS)[number];

/** Two years, matching `security_activities`. See the header. */
export const CREDENTIAL_AUDIT_RETENTION_SECONDS = 730 * 24 * 60 * 60;

export const applicationCredentialAuditEvents = pgTable(
  'application_credential_audit_events',
  {
    id: generatedId(),
    /**
     * The application the event is attributed to. `CASCADE` — the trail belongs
     * to the application and goes with it, exactly as `security_activities`
     * goes with its user.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * The credential the event is ABOUT. `not null`: every row here names a
     * resolved credential, which is what makes the volume bound in the header
     * true rather than aspirational.
     *
     * `CASCADE` rather than `SET NULL` because NULL would mean nothing here —
     * there is no "event about no credential" — and a credential row only ever
     * disappears together with its application, which cascades anyway.
     */
    credentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'cascade' }),
    eventType: text({ enum: CREDENTIAL_AUDIT_EVENT_TYPES }).notNull(),
    /**
     * Why a `validation_failed` event happened. NULL on the three
     * administrative events, which have no failure to explain.
     */
    reason: text({ enum: CREDENTIAL_VALIDATION_FAILURE_REASONS }),
    /**
     * The member who performed an administrative transition. NULL on
     * `validation_failed` — a refused bearer has no authenticated actor, and
     * inventing one would be the single most misleading thing this table could
     * do. `SET NULL` on user deletion for the same reason
     * `applications.created_by_user_id` is: losing the attribution is better
     * than losing the event.
     */
    actorUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /**
     * Per-event detail — the rotation counterpart's id, a grace deadline, the
     * scope a request asked for. Genuinely shape-less, one key set per event
     * type, which is what `jsonb` is for. `{}` is a VALUE ("no detail").
     *
     * It must never carry token material: this is the one open surface on the
     * table, and `services/applicationCredentialAudit.service.ts` is the only
     * writer precisely so that rule has one place to hold.
     */
    metadata: jsonb().notNull().default({}),
    /**
     * The credential's own environment at the time of the event, denormalised
     * so a trail survives the credential being rotated to another one and so an
     * `environment_mismatch` row states both sides (the expected side lives in
     * `metadata`).
     */
    environment: text(),
    /** When the event happened. Swept two years later — see the header. */
    createdAt: createdAt(),
    /**
     * Kept for symmetry with the credential row's own clock when a lifecycle
     * event carries a deadline (a rotation grace). NULL otherwise.
     */
    effectiveUntil: timestamptz(),
  },
  (t) => [
    // "This application's credential trail, newest first" — the only read shape
    // an operator or a future Console surface wants.
    index('application_credential_audit_events_application_id_created_at_idx').on(
      t.applicationId,
      t.createdAt.desc()
    ),
    // …narrowed to one credential, which is the shape an incident starts from.
    index('application_credential_audit_events_credential_id_created_at_idx').on(
      t.credentialId,
      t.createdAt.desc()
    ),
    // Supports the expiry sweep in `db/expiry.ts`. Neither compound above LEADS
    // with this column, and the sweep is a bare range scan.
    index('application_credential_audit_events_created_at_idx').on(t.createdAt),
    check(
      'application_credential_audit_events_event_type_check',
      sql`${t.eventType} in (${sql.raw(inList(CREDENTIAL_AUDIT_EVENT_TYPES))})`
    ),
    check(
      'application_credential_audit_events_reason_check',
      sql`${t.reason} is null or ${t.reason} in (${sql.raw(inList(CREDENTIAL_VALIDATION_FAILURE_REASONS))})`
    ),
    // One direction only. A `validation_failed` row MUST say why — a refusal
    // with no reason is the row that makes the whole table unactionable. The
    // converse is not asserted here because it is already covered: `reason` is
    // constrained to failure reasons, and none of them is meaningful on an
    // administrative event, so the writer never sets one.
    check(
      'application_credential_audit_events_failure_reason_check',
      sql`${t.eventType} <> 'validation_failed' or ${t.reason} is not null`
    ),
    // A refused bearer has no authenticated actor. Recording one would turn "we
    // do not know who presented this token" into "this member did", which is a
    // false accusation an audit table must not be able to make.
    check(
      'application_credential_audit_events_no_actor_on_failure_check',
      sql`${t.eventType} <> 'validation_failed' or ${t.actorUserId} is null`
    ),
  ]
);
