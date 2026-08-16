/**
 * `inference_route_switch_events` — the customer-visible record that an allowed
 * route switch happened, and under which policy version it was allowed.
 *
 * The stream contract already emits `route_switch` in-band
 * (`inferenceStreamRouteSwitchEventSchema`), because a customer comparing two
 * answers needs to know the second came from somewhere else while they are
 * reading it. This table is the PERSISTED half of the same fact, so the switch
 * is still explainable after the stream has closed — a receipt says what was
 * charged, and this says why the route that produced it was not the first one.
 *
 * The persisted side is deliberately CONSISTENT with the stream event rather
 * than a second, differently-shaped record: same two scopes, same closed reason
 * set, same `(requestId, sequence)` identity, and the same two rules about what
 * a model switch may say. Where they differ is that the wire expresses those
 * rules with a discriminated union and a `z.literal(true)`, and this expresses
 * them with CHECK constraints and a foreign key — the same statements in the
 * language each side can enforce.
 *
 * ## The three things a model switch cannot be
 *
 * **It cannot be unauthorised.** `authorization_id` is required for
 * `scope = 'model'` and points at the exact
 * `inference_routing_policy_fallbacks` row the customer wrote. There is no
 * "allowed cross-model fallback" boolean anywhere to be true; the authorisation
 * IS a row, and a switch that cannot name one cannot be recorded.
 *
 * **It cannot cite a different policy version than the one in force.**
 * `(authorization_id, routing_policy_version_id)` is a COMPOSITE foreign key
 * into `(id, version_id)` on that table, so the authorisation and the recorded
 * version are checked to belong together. Two separate single-column keys would
 * each be satisfied while naming two different policies.
 *
 * **It cannot have been asked for by exact revision.** `requested_model_id` is
 * constrained to {@link MODEL_ID_CHECK_PATTERN} — `<publisher>/<model>`, with no
 * `@<revision>` alternative in the grammar. A request that pinned a revision
 * asked for exactly those weights and is served or refused, never substituted;
 * for such a request there is no value this column accepts, so the row cannot be
 * constructed. That is the structural form of the epic's invariant, and it holds
 * against a writer that never sees the wire schema.
 *
 * ## A deployment switch is not a model switch
 *
 * `scope = 'deployment'` is same-model failover: the same weights served from
 * somewhere else. The CHECK below requires `from_model_reference` and
 * `to_model_reference` to be EQUAL for those rows, which is what makes
 * "same-model deployment failover is distinct from cross-model fallback" a
 * property of the data rather than a claim in a comment.
 *
 * ## Append-only
 *
 * A customer-visible notice that is editable afterwards is not a notice. The
 * same `BEFORE UPDATE` guard the policy versions carry covers this table; see
 * `inferenceRoutingPolicyVersions.ts` for why `DELETE` is left to the foreign
 * keys instead.
 */

import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxyhq/db';
import { inferenceRouteSwitchReasonSchema } from '@oxyhq/contracts';
import { applications } from './applications';
import { inferenceRoutingPolicyFallbacks } from './inferenceRoutingPolicyFallbacks';
import { inferenceRoutingPolicyVersions } from './inferenceRoutingPolicyVersions';
import { MODEL_ID_CHECK_PATTERN, MODEL_REFERENCE_CHECK_PATTERN } from './inferenceSlug';
import { INFERENCE_ENVIRONMENTS } from './usageReservations';
import { users } from './users';

/**
 * `deployment` is same-model failover; `model` is a substitution. Mirrors the
 * discriminant of `inferenceRouteSwitchDetailSchema`.
 */
export const ROUTE_SWITCH_SCOPES = ['deployment', 'model'] as const;

export type RouteSwitchScope = (typeof ROUTE_SWITCH_SCOPES)[number];

/**
 * Why a route changed mid-request, taken from the wire contract's own enum
 * rather than restated, so the persisted vocabulary cannot drift from the one
 * customers are streamed.
 */
export const ROUTE_SWITCH_REASONS = inferenceRouteSwitchReasonSchema.options;

export type RouteSwitchReason = (typeof ROUTE_SWITCH_REASONS)[number];

export const inferenceRouteSwitchEvents = pgTable(
  'inference_route_switch_events',
  {
    id: generatedId(),

    /** The edge's correlation key. Joins this to `usage_receipts.request_id`. */
    requestId: text().notNull(),

    /** The stream sequence number the same event carried in-band. */
    sequence: integer().notNull(),

    // ---- attribution (ADR 0007) --------------------------------------------
    //
    // Account and application only. A route switch is a fact about the request,
    // not a charge, so it needs to be readable by whoever may read the
    // application's usage — and the credential that happened to authenticate the
    // request adds nothing to that question while making the row harder to write.

    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),

    /**
     * The exact policy revision this request executed under.
     *
     * `RESTRICT`: a switch that cannot name the configuration that allowed it is
     * not an explanation of anything, so the version outlives the event.
     */
    routingPolicyVersionId: text()
      .notNull()
      .references(() => inferenceRoutingPolicyVersions.id, { onDelete: 'restrict' }),

    scope: text({ enum: ROUTE_SWITCH_SCOPES }).notNull(),
    reason: text({ enum: ROUTE_SWITCH_REASONS }).notNull(),

    /** Equal to `to_model_reference` for a deployment switch, by CHECK. */
    fromModelReference: text().notNull(),
    toModelReference: text().notNull(),
    toProvider: text().notNull(),

    /** The data plane's endpoint identity, when it named one. */
    toDeploymentId: text(),

    /**
     * What the caller ASKED for, present only on a model switch, and only ever
     * an unpinned `<publisher>/<model>`. See the header.
     */
    requestedModelId: text(),

    /**
     * The customer's own authorisation for this substitution. NULL on a
     * deployment switch, required on a model switch.
     */
    authorizationId: text(),

    occurredAt: timestamptz().notNull(),

    /** No `updated_at`: the notice is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    /** One event per position in a request's stream. Makes a redelivery a no-op. */
    unique('inference_route_switch_events_sequence_key').on(t.requestId, t.sequence),

    /**
     * The authorisation and the version it belongs to, checked together. A pair
     * of single-column keys would let a switch cite version 4's authorisation
     * while claiming to have run under version 7.
     *
     * MATCH SIMPLE (the default) is what makes this work for both scopes: a
     * deployment switch leaves `authorization_id` NULL and the constraint is
     * satisfied without a lookup, while a model switch has both columns set and
     * must find the pair.
     */
    foreignKey({
      name: 'inference_route_switch_events_authorization_fk',
      columns: [t.authorizationId, t.routingPolicyVersionId],
      foreignColumns: [
        inferenceRoutingPolicyFallbacks.id,
        inferenceRoutingPolicyFallbacks.versionId,
      ],
    }).onDelete('restrict'),

    check(
      'inference_route_switch_events_scope_check',
      sql`${t.scope} in (${sql.raw(inList(ROUTE_SWITCH_SCOPES))})`
    ),
    check(
      'inference_route_switch_events_reason_check',
      sql`${t.reason} in (${sql.raw(inList(ROUTE_SWITCH_REASONS))})`
    ),
    check(
      'inference_route_switch_events_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`
    ),
    check('inference_route_switch_events_sequence_range', sql`${t.sequence} >= 0`),

    check(
      'inference_route_switch_events_from_format',
      sql`${t.fromModelReference} ~ ${sql.raw(MODEL_REFERENCE_CHECK_PATTERN)}`
    ),
    check(
      'inference_route_switch_events_to_format',
      sql`${t.toModelReference} ~ ${sql.raw(MODEL_REFERENCE_CHECK_PATTERN)}`
    ),

    /**
     * The pinned-revision refusal, and the reason this column exists separately
     * from the two references above: `MODEL_ID_CHECK_PATTERN` has no
     * `@<revision>` alternative, so a substitution of an exactly-pinned request
     * is not a row anything can write.
     */
    check(
      'inference_route_switch_events_requested_format',
      sql`${t.requestedModelId} is null or ${t.requestedModelId} ~ ${sql.raw(MODEL_ID_CHECK_PATTERN)}`
    ),

    check('inference_route_switch_events_request_id_check', sql`length(${t.requestId}) > 0`),
    check('inference_route_switch_events_provider_check', sql`length(${t.toProvider}) > 0`),

    /**
     * A deployment switch keeps the model. Anything else is a substitution
     * wearing a failover's name, and the two must stay distinguishable in the
     * stored record for the same reason they are distinguishable on the wire.
     */
    check(
      'inference_route_switch_events_deployment_shape',
      sql`${t.scope} <> 'deployment' or (
        ${t.fromModelReference} = ${t.toModelReference}
        and ${t.requestedModelId} is null
        and ${t.authorizationId} is null
      )`
    ),

    /**
     * A model switch names what was asked for, names the authorisation that
     * permitted it, and actually changes the model. The last clause is not
     * pedantry: a `scope = 'model'` row whose references are equal would be a
     * deployment failover recorded as a substitution, which reads to a customer
     * as a model change that never happened.
     */
    check(
      'inference_route_switch_events_model_shape',
      sql`${t.scope} <> 'model' or (
        ${t.requestedModelId} is not null
        and ${t.authorizationId} is not null
        and ${t.fromModelReference} <> ${t.toModelReference}
      )`
    ),

    /** "Every switch on this account, newest first" — the customer's own read. */
    index('inference_route_switch_events_account_id_occurred_at_idx').on(
      t.accountId,
      t.occurredAt.desc()
    ),
    index('inference_route_switch_events_application_id_occurred_at_idx').on(
      t.applicationId,
      t.occurredAt.desc()
    ),
    /** Correlating one request's switches with its receipt. */
    index('inference_route_switch_events_request_id_idx').on(t.requestId),
  ]
);

export type InferenceRouteSwitchEventRow = typeof inferenceRouteSwitchEvents.$inferSelect;
