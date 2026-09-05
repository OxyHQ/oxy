/**
 * `moderation_effects` — the idempotent mapping between a published moderation
 * decision and the reputation it moved.
 *
 * Ported from `models/ModerationEffect.ts`. This is the record that makes "one
 * penalty per incident" auditable rather than merely intended, and it carries
 * enough to EXPLAIN a figure — the multipliers, the severity, the policy
 * versions — so a subject can be told why a consequence is what it is without
 * the decision's contents being reopened.
 *
 * ## Two unique keys, each closing a different hole
 *
 * - `(incident_id, principal_id, effect_type, decision_revision)` — the SEMANTIC
 *   key. A hundred reports about the same material collapse into one incident
 *   and therefore one effect, whatever emitted them.
 * - `event_id` — the TRANSPORT key. A redelivery is answered from the stored
 *   effect rather than replayed.
 *
 * Both are needed: the transport key alone would let a re-emitted event with a
 * fresh id apply a second penalty, and the semantic key alone would make an
 * honest retry look like a conflict.
 *
 * ## `policyVersions` became three columns, one of them a foreign key
 *
 * The subdocument had a fully known shape, so it is real columns rather than
 * `jsonb`. `universal` and `application` are the EMITTING system's policy
 * identifiers and stay plain text — there is nothing here to reference. The
 * third names an Oxy Conduct Policy version and now references
 * `moderation_policies.policy_version` with `ON DELETE RESTRICT`, so a version
 * cannot be deleted while an effect was derived under it.
 *
 * ## Indexes that changed on port, with the query that decided each
 *
 * - Mongo's `{incidentId, createdAt: 1}` becomes `(incident_id,
 *   decision_revision)`. Both readers — `routes/moderationReputation.routes.ts:403`
 *   and `moderationReputation.service.ts:567` — sort by `decisionRevision`, which
 *   the Mongo index could not serve; it answered the equality and then sorted in
 *   memory.
 * - Mongo's standalone `{principalId}` becomes `(principal_id, applied_at desc)`.
 *   The one reader (`routes/moderationReputation.routes.ts:366`) sorts by
 *   `appliedAt desc` with a limit of 100.
 * - Mongo's `{status}` and `{applicationId}` are DROPPED. Every
 *   `ModerationEffect` query in the package is listed above plus the two unique
 *   keys; none filters on either column, and an index nobody uses still costs
 *   every write.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import {
  MODERATION_EFFECT_STATUSES,
  MODERATION_EFFECT_TYPES,
  MODERATION_SEVERITIES,
} from '@oxyhq/contracts';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { conductStrikes } from './conductStrikes';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { moderationPolicies } from './moderationPolicies';
import { reputationTransactions } from './reputationTransactions';
import { identityBindings } from './identityBindings';
import { users } from './users';

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const moderationEffects = pgTable(
  'moderation_effects',
  {
    id: generatedId(),
    /** The emitter's event id — the transport-level idempotency key. */
    eventId: text().notNull(),
    /** The cross-tenant incident. THE unit of consequence. */
    incidentId: text().notNull(),
    caseId: text().notNull(),
    decisionId: text().notNull(),
    decisionRevision: integer().notNull(),
    /**
     * The Oxy user the effect landed on. `CASCADE`: an effect names a person,
     * and an erased account leaves nobody for it to have landed on.
     */
    principalId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The binding that proved the identity. No binding, no effect.
     *
     * `ON DELETE RESTRICT`: an effect whose proof of identity vanished is
     * unauditable, so a binding cannot be deleted while an effect cites it.
     */
    bindingId: text()
      .notNull()
      .references(() => identityBindings.id, { onDelete: 'restrict' }),
    /**
     * The REPORTED application — whose report started the incident, named in the
     * decision event's body as `reportedApplicationId`.
     *
     * NOT the emitter, despite what this comment said until now. Every writer
     * has always written the reportee (`applyModerationDecision` passes
     * `reportedApplicationId` here, to `conduct_strikes.application_id`, and to
     * the ledger's `application_id`), the single reader copies it into
     * `conduct_strikes.application_id` during repair, and both sibling columns
     * document the same meaning — "Reporting application" on the ledger,
     * "Which application's report started the incident" on the strike. The
     * emitter sentence was wrong from the original Mongo model and survived the
     * port; it is corrected rather than deleted because acting on it is a
     * mistake worth naming.
     *
     * Body-supplied and therefore not authority on its own. What makes it
     * trustworthy is the BINDING PROOF checked beside it: `resolveBindingProof`
     * requires `(bindingProofId, applicationId)` to match a live binding, and a
     * binding is created only by the named application itself — `POST
     * /reputation/moderation/bindings` takes its `applicationId` from the
     * CREDENTIAL and requires the subject's own access token. Binding ids are
     * returned only to their creator and never echoed by a read path, so naming
     * another application's id here fails `no_binding_proof`.
     *
     * `RESTRICT`, as the deferred-FK ledger decided before `applications`
     * landed: the reporter is part of the provenance an effect exists to
     * record, so deleting it must FAIL rather than erase or orphan the audit
     * trail of what it caused.
     *
     * THE EMITTER IS NOT STORED HERE, OR ANYWHERE DURABLE.
     * `applyModerationDecision` validates `context.emitterApplicationId` is
     * present and then drops it; the only emitter identity that reaches a row is
     * {@link credentialId}, which is nullable and `SET NULL`. So this table
     * cannot answer "which application emitted this decision" for a rotated
     * credential or for a row predating that column — worth knowing before
     * building any authorization on emitter identity here.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    /**
     * The credential the event arrived on. `SET NULL`: which credential is
     * provenance DETAIL rather than the effect itself, NULL already means "not
     * recorded" on rows predating the field, and — unlike `application_id` — a
     * rotated-out credential may legitimately be removed without invalidating
     * the effect.
     */
    credentialId: text().references(() => applicationCredentials.id, {
      onDelete: 'set null',
    }),
    effectType: text({ enum: MODERATION_EFFECT_TYPES }).notNull(),
    status: text({ enum: MODERATION_EFFECT_STATUSES }).notNull().default('applied'),
    /** Signed points written to the ledger, already multiplied and capped. */
    points: doublePrecision().notNull(),
    /** Active risk added to conduct standing, already multiplied and capped. */
    activeRisk: doublePrecision().notNull(),
    severity: text({ enum: MODERATION_SEVERITIES }).notNull(),
    /** Conduct family of the primary finding. Never the taxonomy code. */
    family: text().notNull(),
    /** Repetition multiplier applied (1.0 for a first similar incident). */
    repetitionMultiplier: doublePrecision().notNull(),
    /** Multi-finding multiplier applied, capped by the policy version. */
    multiFindingMultiplier: doublePrecision().notNull(),
    /** The exact key the ledger transaction was written under. */
    idempotencyKey: text().notNull(),
    /**
     * The ledger row this effect wrote.
     *
     * `RESTRICT`: the ledger is append-only and REVERSES rather than deletes, so
     * a deleted transaction would mean the points moved with no record of it.
     * Measured against a real Postgres — this does NOT block the account-erasure
     * cascade, because `user_id` cascades this row away before the referenced
     * transaction's check runs, so the refusal only ever hits a bare delete of a
     * referenced ledger row, which is exactly what it is for.
     */
    transactionId: text()
      .notNull()
      .references(() => reputationTransactions.id, { onDelete: 'restrict' }),
    /**
     * The strike this effect created, when it carries risk.
     *
     * `CASCADE`, not `SET NULL`: NULL here MEANS "this effect created no
     * strike", so `SET NULL` would rewrite the record into a different, false
     * claim — the hazard `CONVENTIONS.md` flags for `push_tokens.application_id`.
     * The two rows are one decision recorded on two axes and the models state
     * they cannot disagree about how many consequences an incident produced, so
     * they go together. Nothing deletes a strike outside the erasure of its
     * subject, which cascades both anyway.
     */
    strikeId: text().references(() => conductStrikes.id, { onDelete: 'cascade' }),
    /**
     * The compensating transaction, once an appeal reversed the effect.
     *
     * `RESTRICT`, not `SET NULL`: NULL here MEANS "never reversed", so
     * `SET NULL` would rewrite a reversed effect into a false claim — a worse
     * lie than a refused delete. The ledger never deletes anyway.
     */
    reversalTransactionId: text().references(() => reputationTransactions.id, {
      onDelete: 'restrict',
    }),
    /** The emitting system's universal policy identifier. Not a row here. */
    policyVersionUniversal: text().notNull(),
    /** The emitting application's policy identifier. Not a row here. */
    policyVersionApplication: text().notNull(),
    /**
     * The Oxy Conduct Policy version — a real reference. See the header. The
     * constraint is declared in the table config below: drizzle's derived name
     * for it is 83 characters and Postgres truncates an identifier at 63.
     */
    policyVersionOxyConduct: text().notNull(),
    /** Hash of the private decision document — provenance without contents. */
    proofHash: text().notNull(),
    appliedAt: timestamptz().notNull().defaultNow(),
    reversedAt: timestamptz(),
    /** Why the effect was reversed, when it was. */
    reversalReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.policyVersionOxyConduct],
      foreignColumns: [moderationPolicies.policyVersion],
      name: 'moderation_effects_policy_version_oxy_conduct_fk',
    }).onDelete('restrict'),
    unique('moderation_effects_incident_principal_type_revision_key').on(
      t.incidentId,
      t.principalId,
      t.effectType,
      t.decisionRevision
    ),
    unique('moderation_effects_event_id_key').on(t.eventId),

    // Reversal resolves every effect a decision revision produced.
    index('moderation_effects_decision_id_decision_revision_idx').on(
      t.decisionId,
      t.decisionRevision
    ),
    // Reconciliation walks an incident's effects across revisions, in revision
    // order — see the header for why this is not `(incident_id, created_at)`.
    index('moderation_effects_incident_id_decision_revision_idx').on(
      t.incidentId,
      t.decisionRevision
    ),
    // "My own consequences", newest first.
    index('moderation_effects_principal_id_applied_at_idx').on(
      t.principalId,
      t.appliedAt.desc()
    ),

    check(
      'moderation_effects_effect_type_check',
      sql`${t.effectType} in (${sql.raw(inList(MODERATION_EFFECT_TYPES))})`
    ),
    check(
      'moderation_effects_status_check',
      sql`${t.status} in (${sql.raw(inList(MODERATION_EFFECT_STATUSES))})`
    ),
    check(
      'moderation_effects_severity_check',
      sql`${t.severity} in (${sql.raw(inList(MODERATION_SEVERITIES))})`
    ),
    check('moderation_effects_decision_revision_check', sql`${t.decisionRevision} >= 0`),
    // A reversal is whole or absent: `status = 'reversed'` and a `reversed_at`
    // cannot exist without each other. Mongo permitted either half alone, and
    // every reader had to guard for it.
    check(
      'moderation_effects_reversal_complete_check',
      sql`(${t.status} = 'reversed') = (${t.reversedAt} is not null)`
    ),
  ]
);
