/**
 * `inference_routing_policies` — the customer's own routing CONFIGURATION.
 *
 * A routing POLICY is not a routing PROFILE, and ADR 0008 draws the line this
 * table is on the customer side of:
 *
 *  - `inference_routing_profiles` is a CATALOGUE object. `auto`, `fast`,
 *    `quality` — a named strategy Oxy publishes and every tenant may name. It
 *    is authored by staff and shared.
 *  - `inference_routing_policies` (here) is a per-account or per-application
 *    CONSTRAINT SET. It says which providers, regions, licences, prices and
 *    fallbacks a customer will accept, and it is authored by that customer.
 *
 * The distinction is structural rather than documentary: a profile is named by
 * a slug in a namespace that cannot contain `/`, a policy is named by a row id
 * belonging to exactly one account, and a policy can SELECT a profile as its
 * default target while a profile can never reference a policy. That is why
 * `inference:routing:write` (staff-gated) governs the shared catalogue and this
 * table's writes are governed by the customer's own account RBAC — the scope
 * vocabulary's own note says these two would be own-tenant operations "if
 * routing profiles and provider connections turn out to be per-account rows",
 * and this is the object for which that turned out to be true.
 *
 * ## This row is an IDENTITY; the controls live in the versions
 *
 * Nothing configurable is stored here. Every control is on
 * `inference_routing_policy_versions`, which is append-only, so a settled
 * receipt months old can name the exact `{policy, version}` it executed under
 * and that version still says what it said then. Editing a policy appends
 * version N+1 and moves `is_current`; it never rewrites version N.
 *
 * ## Scope
 *
 * `account` policies are the floor an account's applications inherit;
 * `application` policies are the common case and win over the account's. Both
 * carry `account_id` — an application policy's account is the application's
 * OWNER account (ADR 0007's financially responsible principal), so a read never
 * has to join `applications` to find out whose policy it is looking at.
 *
 * ## Archived, never deleted
 *
 * A policy version can be named by a `usage_receipts` row, and that reference is
 * `ON DELETE RESTRICT`. So the lifecycle end state is `status = 'archived'`,
 * not a DELETE: a charge must always be able to explain itself, and a customer
 * removing a policy must not be able to make a past charge unexplainable. The
 * partial unique indexes below are scoped to `active` for the same reason — an
 * archived policy does not occupy its scope.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';
import { applications } from './applications';
import { users } from './users';

/** Which object a policy governs. Mirrors `routingPolicyScopeSchema`. */
export const ROUTING_POLICY_SCOPE_KINDS = ['account', 'application'] as const;

export type RoutingPolicyScopeKind = (typeof ROUTING_POLICY_SCOPE_KINDS)[number];

/** A policy is in force, or it is history. There is no third state. */
export const ROUTING_POLICY_STATUSES = ['active', 'archived'] as const;

export type RoutingPolicyStatus = (typeof ROUTING_POLICY_STATUSES)[number];

export const inferenceRoutingPolicies = pgTable(
  'inference_routing_policies',
  {
    id: generatedId(),

    scopeKind: text({ enum: ROUTING_POLICY_SCOPE_KINDS }).notNull(),

    /**
     * The account this policy belongs to and whose balance the requests it
     * governs are drawn from. For an application-scoped policy this is the
     * application's `owner_account_id`.
     *
     * `RESTRICT`: an account with routing configuration and settled receipts
     * against it is not an account that can be removed by a cascade.
     */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * NULL for an account-scoped policy. The CHECK below makes NULL and
     * `scope_kind` say the same thing, so no reader has to decide which of the
     * two to believe.
     *
     * `RESTRICT` rather than `CASCADE`: an application's spend history names
     * policy versions, and deleting the application must not silently take the
     * explanation of its charges with it.
     */
    applicationId: text().references(() => applications.id, { onDelete: 'restrict' }),

    status: text({ enum: ROUTING_POLICY_STATUSES }).notNull().default('active'),

    /** Who created the policy. Audit only; never an authorisation input. */
    createdByUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'inference_routing_policies_scope_kind_check',
      sql`${t.scopeKind} in (${sql.raw(inList(ROUTING_POLICY_SCOPE_KINDS))})`
    ),
    check(
      'inference_routing_policies_status_check',
      sql`${t.status} in (${sql.raw(inList(ROUTING_POLICY_STATUSES))})`
    ),

    /**
     * `scope_kind` and `application_id` are one fact written twice, so they are
     * constrained to agree. Written as a biconditional because BOTH directions
     * are wrong: an `application` policy with no application governs nothing,
     * and an `account` policy carrying an application id is an application
     * policy that every account-scoped read would pick up.
     */
    check(
      'inference_routing_policies_scope_target_check',
      sql`(${t.scopeKind} = 'application') = (${t.applicationId} is not null)`
    ),

    /**
     * One ACTIVE policy per scope. Partial, because an archived policy has
     * stopped occupying its scope while remaining readable forever — which is
     * exactly what a plain `unique` could not express.
     */
    uniqueIndex('inference_routing_policies_account_scope_key')
      .on(t.accountId)
      .where(sql`${t.scopeKind} = 'account' and ${t.status} = 'active'`),
    uniqueIndex('inference_routing_policies_application_scope_key')
      .on(t.applicationId)
      .where(sql`${t.applicationId} is not null and ${t.status} = 'active'`),

    /** "Every policy this account owns" — the Console list. */
    index('inference_routing_policies_account_id_idx').on(t.accountId),
  ]
);

export type InferenceRoutingPolicyRow = typeof inferenceRoutingPolicies.$inferSelect;
