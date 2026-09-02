/**
 * `inference_provider_connection_audit_events` — the BYOK connection trail
 * (issue #972 workstream 10).
 *
 * Same shape and the same reasoning as `application_credential_audit_events`,
 * applied to a different subject: one append-only table, a closed vocabulary
 * rendered as a CHECK, `jsonb` detail, an entry in `db/expiry.ts`. It is not a
 * second logging system and it is not where a secret goes — see below.
 *
 * ## Why not `application_credential_audit_events`
 *
 * That table is about credentials OXY issued: `credential_id` is `NOT NULL` and
 * references `application_credentials`. A provider connection is a credential
 * the CUSTOMER issued at a third party, has no `application_credentials` row,
 * and is scoped to an ACCOUNT rather than always to an application. Widening
 * that table would mean making its `credential_id` nullable, which is the one
 * column its own volume bound depends on.
 *
 * ## `metadata` must never carry credential material
 *
 * This is the only open-shaped column on the table, so it is the only place a
 * secret could arrive. `services/inferenceProviderConnection.service.ts` is the
 * sole writer and assembles every `metadata` object itself from ids, closed
 * enums and booleans — the exported signatures take no free-form value at all,
 * so there is no parameter through which one could be passed.
 *
 * ## `used`, and why the table does not drown in it
 *
 * A BYOK connection is "used" every time Oxy hands its reference to the data
 * plane. One row per request would be metering, not audit, and would distort
 * nothing but its own size — `usage_receipts` already meters. So `used` is
 * written through the same per-instance cooldown
 * `applicationCredentialAudit.service.ts` uses: at most one row per connection
 * per minute per API instance. The signal a customer wants ("this key started
 * being used at 14:02 and was still in use at 15:30") survives that; the volume
 * does not.
 *
 * ## Who acted: a person, a customer's service credential, or nobody
 *
 * `actor_kind` + `actor_user_id` answer "was this a person or a deployment's
 * key", which #972 workstream 12 requires of every audit surface and which this
 * table could not answer at all.
 *
 * The defect was one column carrying two different things.
 * `routes/inferenceProviderConnections.ts` wrote `actor_user_id` from a helper
 * that returned the calling USER's id for a session principal and the calling
 * application's OWNING ACCOUNT id for a service-token principal — both real
 * `users.id` values, since an account IS a users row here, so nothing failed and
 * "a member rotated this connection" read identically to "an application rotated
 * it with a service token" (`docs/inference/observability.md`).
 *
 * Four states, and no two of them can be read into one another:
 *
 *   ('user',     <users.id>)  a named person acted, through a session bearer.
 *                             The id is required — a person who declines to be
 *                             named is the state this pair exists to refuse.
 *   ('service',   null)       a CUSTOMER'S SERVICE CREDENTIAL acted. No person
 *                             is behind it. The id is refused rather than
 *                             optional: the only id that lane ever had to offer
 *                             was the owning account's, which is already
 *                             `owner_account_id` on this very row — a second,
 *                             shallower copy would be a thing to keep in sync,
 *                             not a thing to read.
 *   ('platform',  null)       OXY'S OWN machinery acted, with no principal at
 *                             all: the data plane resolving a reference
 *                             (`used`), a verdict it reported (`validated`), the
 *                             automatic `disabled` that an `invalid` verdict
 *                             causes. A POSITIVE value, never an absence.
 *   (null,        null|<id>)  the row PREDATES this column. See below.
 *
 * `platform` rather than `billing_ledger_entries`' word for the same idea
 * (`machine`), deliberately: on that table there is no service-token lane, so
 * `machine` is unambiguous. Here a service credential is also a machine, and
 * that ambiguity is the whole defect — so the two machine-ish authors get two
 * names.
 *
 * **Existing rows are NOT back-filled, and cannot be.** A legacy row's
 * `actor_user_id` may be a person or an account and nothing recorded which, so
 * every possible back-fill value would be a claim the data does not support —
 * precisely the distinction the column adds. The table is also append-only by
 * trigger (below), so a back-fill would mean disabling that trigger on an audit
 * table. A null `actor_kind` therefore means "written before
 * `0049_inference_provider_connection_actor`" and means nothing else; `created_at`
 * corroborates it. No code path can produce it on a new row —
 * {@link ProviderConnectionActor} is a required field of the audit entry type in
 * `services/inferenceProviderConnection.service.ts`, which is the only writer.
 *
 * In production that legacy set is empty: a connection can only be created
 * through `createProviderConnection`, and the previous build shipped no custody
 * backend — so no
 * connection exists to have an audit row. The nullable arm is kept anyway,
 * because a development or staging database whose rows nobody can classify is
 * exactly the case a migration must not fail on.
 *
 * ## Append-only, and the ONE exception
 *
 * Nothing updates a row, and `0042_inference_provider_connection_immutability.sql`
 * enforces it with a `BEFORE UPDATE` trigger.
 *
 * DELETE is deliberately NOT guarded, unlike the financial ledger's trigger in
 * `0034`. The ledger keeps every row forever, so it can close both halves. This
 * table is swept at two years by `db/expiry.ts` — the same window
 * `security_activities` and `application_credential_audit_events` keep — and a
 * trigger refusing DELETE would make that sweep fail on every run rather than
 * make the table safer. The choice is between an unbounded audit table and an
 * un-guarded DELETE, and the transparency checkpoints
 * (`0005_transparency_immutability.sql`) already settled the same trade the same
 * way. The mutation that matters here is the EDIT: a deleted row is absent and
 * visibly so, while an edited one lies.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxyhq/db';
import { inferenceProviderConnections } from './inferenceProviderConnections';
import { users } from './users';

/**
 * The vocabulary. The epic names create, validate, rotate, use and revoke;
 * `disabled`/`enabled` are here because "immediate disable" is a deliverable of
 * its own and a disable nobody can see the timing of is not one.
 */
export const PROVIDER_CONNECTION_AUDIT_EVENT_TYPES = [
  'created',
  'validated',
  'rotated',
  'used',
  'disabled',
  'enabled',
  'revoked',
] as const;

export type ProviderConnectionAuditEventType =
  (typeof PROVIDER_CONNECTION_AUDIT_EVENT_TYPES)[number];

/**
 * What kind of principal wrote a row. See "Who acted" in the header for why
 * there are three, and why `platform` is a value rather than a blank.
 *
 * This tuple is the SINGLE declaration: the CHECK below names each value as a
 * literal, and `check-drizzle-snapshot-sync` holds that rendering against the
 * migration the database was built from.
 */
export const PROVIDER_CONNECTION_ACTOR_KINDS = ['user', 'service', 'platform'] as const;

export type ProviderConnectionActorKind = (typeof PROVIDER_CONNECTION_ACTOR_KINDS)[number];

/** A named person, acting through their own session bearer. */
export interface UserProviderConnectionActor {
  readonly kind: 'user';
  /** `users.id`. Required BY THE TYPE — a person who is not named is unwritable. */
  readonly userId: string;
}

/**
 * A customer's service credential. No person is behind it, and it carries no id:
 * the account it acts for is the row's own `owner_account_id`.
 */
export interface ServiceProviderConnectionActor {
  readonly kind: 'service';
}

/** Oxy's own machinery, with no principal: the data plane, or an automatic transition. */
export interface PlatformProviderConnectionActor {
  readonly kind: 'platform';
}

/**
 * Who wrote an audit row, as every writer must state it.
 *
 * A discriminated union rather than an optional id beside an optional kind: the
 * two incoherent rows the CHECK refuses — a `user` with no id, a `service` or
 * `platform` carrying one — are then not expressible in TypeScript either, so the
 * database constraint is the second line of defence rather than the only one.
 */
export type ProviderConnectionActor =
  | UserProviderConnectionActor
  | ServiceProviderConnectionActor
  | PlatformProviderConnectionActor;

/** Two years, matching `security_activities` and the credential trail. */
export const PROVIDER_CONNECTION_AUDIT_RETENTION_SECONDS = 730 * 24 * 60 * 60;

export const inferenceProviderConnectionAuditEvents = pgTable(
  'inference_provider_connection_audit_events',
  {
    id: generatedId(),

    /**
     * The connection the event is about. `RESTRICT`, matching the connection
     * row's own refusal to be deleted out from under a live secret: a connection
     * is revoked, never deleted, so nothing legitimate ever needs this to
     * cascade. It is also what stops "delete the connection" becoming a way to
     * erase its trail.
     */
    connectionId: text()
      .notNull()
      .references(() => inferenceProviderConnections.id, { onDelete: 'restrict' }),

    /**
     * The account the connection belongs to, denormalised so the trail can be
     * read and authorised without joining a row that a later revoke may have
     * changed under it. `RESTRICT` for the same reason as the connection's own.
     */
    ownerAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    eventType: text({ enum: PROVIDER_CONNECTION_AUDIT_EVENT_TYPES }).notNull(),

    /**
     * The member who performed an administrative transition.
     *
     * NULL on `used`, which has no person behind it — it is the data plane
     * resolving a reference — and NULL on a `validated` verdict reported by the
     * data plane. Inventing an actor for either would turn "we do not know who"
     * into "this member did", which is the single most misleading thing an audit
     * table can do; the CHECK below refuses it. `SET NULL` on user deletion:
     * losing the attribution is better than losing the event.
     */
    actorUserId: text().references(() => users.id, { onDelete: 'set null' }),

    /**
     * WHAT KIND of principal acted — see "Who acted" in the header.
     *
     * Nullable only for rows written before this column existed. Every writer
     * states it, because {@link ProviderConnectionActor} is a required field of
     * the audit entry type, and the CHECK below refuses every pairing with
     * `actor_user_id` that would mean two things at once.
     */
    actorKind: text({ enum: PROVIDER_CONNECTION_ACTOR_KINDS }),

    /**
     * Per-event detail — the fingerprint a rotation replaced, the validation
     * verdict, whether a revoke managed to destroy the stored secret. Assembled
     * by the writer from ids and closed values; NEVER credential material. `{}`
     * is a VALUE ("no detail"), not a missing one.
     */
    metadata: jsonb().notNull().default({}),

    /** The connection's environment at the time, so the trail survives nothing. */
    environment: text().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // "This connection's trail, newest first" — where an incident starts.
    index('inference_provider_connection_audit_events_connection_created_idx').on(
      t.connectionId,
      t.createdAt.desc()
    ),
    // …and the same question asked of a whole account.
    index('inference_provider_connection_audit_events_owner_created_idx').on(
      t.ownerAccountId,
      t.createdAt.desc()
    ),
    // Supports the expiry sweep's bare range scan; neither compound leads with it.
    index('inference_provider_connection_audit_events_created_at_idx').on(t.createdAt),

    check(
      'inference_provider_connection_audit_events_event_type_check',
      sql`${t.eventType} in (${sql.raw(inList(PROVIDER_CONNECTION_AUDIT_EVENT_TYPES))})`
    ),

    /**
     * A `used` event has no authenticated person behind it — it is the data
     * plane resolving a reference — so recording one would be a false
     * attribution. Refused here rather than left to the writer, because a
     * writer's discipline is exactly what an audit table must not depend on.
     */
    check(
      'inference_provider_connection_audit_events_no_actor_on_use',
      sql`${t.eventType} <> 'used' or ${t.actorUserId} is null`
    ),

    /**
     * The four states of "who acted", enumerated rather than implied. See "Who
     * acted" in the header for what each one means; this is what makes the other
     * combinations unrepresentable:
     *
     *   ('user', null)      a person acted and declines to be named.
     *   ('service', <id>)   nobody was behind it, and here is their id.
     *   ('platform', <id>)  the same, about Oxy's own machinery.
     *
     * Vocabulary is enforced by the same expression — each branch names its kind
     * as a literal, so a value outside {@link PROVIDER_CONNECTION_ACTOR_KINDS}
     * satisfies no branch and the row is refused.
     *
     * `is not distinct from`, NOT `=`, and that is load-bearing rather than
     * stylistic: a CHECK rejects only FALSE, and `null = 'user'` is NULL. Written
     * with `=`, a row whose `actor_kind` is null would make every later branch
     * NULL and the whole disjunction NULL — accepted, which happens to be the
     * legacy state we want accepted, but the same trap bites in the other
     * direction the moment a branch is added. `billing_ledger_entries_actor_check`
     * was measured failing exactly this way (`0046`), so this is written the way
     * that survived.
     */
    check(
      'inference_provider_connection_audit_events_actor_check',
      sql`${t.actorKind} is null
        or (${t.actorKind} is not distinct from 'user' and ${t.actorUserId} is not null)
        or (${t.actorKind} is not distinct from 'service' and ${t.actorUserId} is null)
        or (${t.actorKind} is not distinct from 'platform' and ${t.actorUserId} is null)`
    ),
  ]
);

export type InferenceProviderConnectionAuditEventRow =
  typeof inferenceProviderConnectionAuditEvents.$inferSelect;
