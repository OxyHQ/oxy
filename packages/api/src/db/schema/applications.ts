/**
 * `applications` — a registered application: its OAuth client identity, its
 * staff-controlled trust classification, and the account that owns it.
 *
 * Ported from `models/Application.ts`. This is the hub of the developer surface:
 * credentials, grants, API keys, usage, OTA channels/updates, cross-app signals
 * and moderation standing all hang off it.
 *
 * ## The three string arrays
 *
 * All three stay NATIVE `text[]` rather than becoming child tables, but for
 * three different reasons — the decision is per array, not per shape:
 *
 * - **`redirect_uris`** is ORDER-SENSITIVE and read whole. `resolveRedirectUris`
 *   (`routes/applications.ts:145`) de-duplicates while preserving the author's
 *   order, and every consumer reads the entire list and matches in application
 *   code (`applicationAllowsOrigin`, `routes/auth.ts:1980`; the origin registry,
 *   `config/dynamicOriginRegistry.ts:216`). No query filters by element. A child
 *   table would add a join to every OAuth authorize and force an explicit
 *   ordinal to preserve what the array gives for free.
 * - **`scopes`** is a closed value set, so it carries the array analogue of the
 *   `text` + CHECK rule: `scopes <@ array[…]`, derived from the SAME
 *   `APPLICATION_SCOPES` tuple the routes and the service-token mint use. The
 *   tuple is imported rather than copied — `utils/applicationScopes.ts` is
 *   deliberately dependency-free (no mongoose), so `drizzle.config.ts` can load
 *   this file without dragging a model in.
 * - **`capabilities`** IS queried by element —
 *   `Application.find({ status: 'active', capabilities: 'identity:approval' })`
 *   (`services/authSessionDelivery.service.ts:81`) runs on every push-delivery
 *   request and is a collection scan under Mongo, which declared no index for
 *   it. Here it gets a GIN index and the query becomes
 *   `capabilities @> array['identity:approval']`. Deliberately NOT
 *   CHECK-constrained: the Mongoose field declares no enum, and the vocabulary
 *   is staff-controlled and meant to grow without a migration.
 *
 * ## What `ON DELETE` says about ownership
 *
 * `owner_account_id` CASCADEs and `created_by_user_id` does not, because they
 * are different relations wearing the same shape. See each column.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { APPLICATION_SCOPES } from '../../utils/applicationScopes';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * Trust/classification of an application. Staff-only — the Console update path
 * silently drops it for a non-staff caller (`routes/applications.ts`), so a
 * self-service third-party app can never promote itself.
 *
 * This tuple is the SINGLE declaration — the Mongoose model that carried the
 * other copy is gone. It renders the CHECK below, and `check-drizzle-snapshot-sync`
 * holds that rendering against the migration the database was actually built
 * from, so editing it without regenerating a migration fails CI.
 */
export const APPLICATION_TYPES = [
  'first_party',
  'third_party',
  'internal',
  'system',
] as const;

export type ApplicationType = (typeof APPLICATION_TYPES)[number];

/** Lifecycle. `deleted` is a soft delete — the row and its OAuth history stay. */
export const APPLICATION_STATUSES = [
  'active',
  'suspended',
  'deleted',
  'pending_review',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const applications = pgTable(
  'applications',
  {
    id: generatedId(),

    // ---- presentation ------------------------------------------------------
    name: text().notNull(),
    description: text(),
    websiteUrl: text(),
    /** Rendered as a legal link on the OAuth consent screen. */
    privacyPolicyUrl: text(),
    /** Rendered as a legal link on the OAuth consent screen. */
    termsUrl: text(),
    /** File id of the application's logo in the assets collection. */
    icon: text(),

    // ---- classification (staff-only) --------------------------------------
    type: text({ enum: APPLICATION_TYPES }).notNull().default('third_party'),
    status: text({ enum: APPLICATION_STATUSES }).notNull().default('active'),
    /** Surfaced as an "official" badge, and part of `isTrustedApplication()`. */
    isOfficial: boolean().notNull().default(false),
    /** Gates service-token issuance and internal-only endpoints. */
    isInternal: boolean().notNull().default(false),
    /** Opaque platform capability flags — see the header. */
    capabilities: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    // ---- OAuth -------------------------------------------------------------
    /**
     * Exact-match allowlist for the authorization-code flow. Order is the
     * author's and is preserved; matching happens in application code.
     */
    redirectUris: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Granted scopes. CHECK-constrained to `APPLICATION_SCOPES` — see header. */
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * Lexicon namespace PREFIXES this application may append records under, on
     * any person's chain — e.g. `app.mention.` for Mention.
     *
     * This is the write-side counterpart of `redirectUris`, which is what
     * `routes/federation.ts` already reads to decide the domains a credential
     * may sign for. The same reasoning applies and is why the claim lives on the
     * Application rather than in a committed file: an application id is
     * environment-specific, so a checked-in map could not name one portably.
     *
     * Empty by default, and an empty list authorizes NOTHING. An app that has
     * not been granted a namespace cannot write to anybody's chain, which is the
     * safe direction: the failure of a missing grant is a refused write, never a
     * record appearing under a namespace its owner never claimed.
     *
     * A prefix, not an exact NSID, because an app adds collections over its own
     * lifetime (`app.mention.feed.post`, `app.mention.feed.like`, …) and should
     * not need a grant edit for each. The boundary that matters is between APPS,
     * and a prefix expresses exactly that. Whether a collection may then be
     * READ by others is a separate decision that lives in
     * `config/chainCollectionPolicy.ts` — writing under your namespace does not
     * make a collection publishable.
     */
    chainNamespaces: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    // ---- webhooks ----------------------------------------------------------
    webhookUrl: text(),
    webhookSecret: text(),
    devWebhookUrl: text(),

    // ---- ownership ---------------------------------------------------------
    /**
     * The account (a User in the account graph) that owns this application. The
     * caller's effective `AccountMember` role over this account is what grants
     * RBAC access — there is no per-app member table.
     *
     * `CASCADE`, and it is a FIX rather than a translation: `ownerAccountId` is
     * `required`, so there is no ownerless state, and under Mongo a deleted
     * owner left the row — and therefore its OAuth client and every service
     * credential under it — working forever with nobody able to administer or
     * revoke it. The GDPR delete path (`routes/users.ts:1517`) does not touch
     * applications today.
     */
    ownerAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The user who created the application — pure ATTRIBUTION, not ownership.
     *
     * NULLABLE with `SET NULL`, deliberately relaxing Mongoose's
     * `required: true`. What `required` guaranteed was that a creator was
     * RECORDED at insert time; Mongo could not keep that true afterwards, since
     * deleting the user left a dangling id with no error. NULL states that
     * honestly. The alternatives are both worse: `CASCADE` would let a departing
     * member's account erasure delete an application their ORGANIZATION owns
     * (the exact failure `users.ts` refused for `parent_account_id`), and
     * `RESTRICT` would make a GDPR erasure fail on an audit field.
     *
     * No index: nothing queries by it (it is written and serialized only), and
     * the FK-maintenance scan on a user delete is over a small table.
     */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),

    lastUsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The list query is `find({ownerAccountId: {$in}, status: {$ne:'deleted'}})
    // .sort({createdAt: -1})` (`routes/applications.ts:479`). Mongo's
    // `{ownerAccountId, status}` cannot serve a `$ne` and leaves the sort in
    // memory; leading with the owner and ordering by `created_at desc` serves
    // both, so this replaces BOTH that compound and the standalone
    // `{ownerAccountId}`.
    index('applications_owner_account_id_created_at_idx').on(
      t.ownerAccountId,
      t.createdAt.desc()
    ),
    // `find({status:'active', capabilities: 'identity:approval'})` on every push
    // delivery. Mongo declared no index for the array, so this is ADDED, not
    // ported: `capabilities @> array['identity:approval']`.
    index('applications_capabilities_idx').using('gin', t.capabilities),

    // Dropped, each with a reason:
    //   `{type}`, `{status}`, `{isOfficial}`, `{isInternal}` — every read on
    //     these asks for the COMMON value (`status: 'active'` in the origin
    //     registry, `config/dynamicOriginRegistry.ts:216`), which matches almost
    //     every row, so a btree cannot beat the sequential scan it would replace.
    //   `{createdByUserId}` and `{createdByUserId, status}` — no query filters
    //     on that column; it is written and serialized only.
    //   `{createdAt: -1}` — the only `created_at` sort is scoped to an owner
    //     account, which the compound above already serves.

    check('applications_type_check', sql`${t.type} in (${sql.raw(inList(APPLICATION_TYPES))})`),
    check(
      'applications_status_check',
      sql`${t.status} in (${sql.raw(inList(APPLICATION_STATUSES))})`
    ),
    // The array analogue of a closed value set: every element must be a known
    // scope. `<@` is containment, so an empty array trivially satisfies it.
    check(
      'applications_scopes_check',
      sql`${t.scopes} <@ ${sql.raw(textArrayLiteral(APPLICATION_SCOPES))}`
    ),
  ]
);
