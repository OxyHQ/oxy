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
  ]
);

export type InferenceProviderConnectionAuditEventRow =
  typeof inferenceProviderConnectionAuditEvents.$inferSelect;
