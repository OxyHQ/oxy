/**
 * `application_credentials` — an application's OAuth client / service credential,
 * and (since issue #972 §2.3) its OpenAI-SDK-compatible machine API key.
 *
 * Ported from `models/ApplicationCredential.ts`. `public_key` IS the OAuth
 * `client_id`; `secret_hash` is the SHA-256 of a secret returned to the caller
 * exactly once at creation or rotation and never re-derivable.
 *
 * ## Two credential lanes, deliberately kept apart
 *
 * A `public`/`confidential`/`service` credential is an OAuth client: its
 * `public_key` (`oxy_dk_…`) is the `client_id`, and its secret is presented
 * BESIDE that id (form body, Basic header, or the `apiKey`/`apiSecret` pair the
 * service-token mint takes). Nothing about it is a single bearer string.
 *
 * A `machine` credential is the opposite shape: ONE `oxy_sk_…` string a standard
 * OpenAI SDK sends as `Authorization: Bearer …`, with no token exchange. It is
 * split into a lookup half and a secret half — `token_prefix` and the SHA-256 in
 * `token_hash` — so resolution is an index probe on a unique column rather than
 * a scan, and the secret is still only ever compared, never stored.
 *
 * The two lanes never cross, and the CHECKs below are what enforce it: a
 * `machine` credential carries NO `secret_hash`, so it cannot authenticate as an
 * OAuth confidential client (`POST /auth/oauth/token` refuses a null hash) or
 * mint a service token (that mint additionally requires `type = 'service'`);
 * and a non-`machine` credential carries no `token_prefix`, so it can never be
 * resolved by the machine bearer lane. `public_key` stays present and unique on
 * every row: it is the credential's PUBLIC identifier, and 2.1's rule that a
 * bare `oxy_dk_…` is never a secret holds for machine credentials too.
 *
 * ## Why SHA-256 for `token_hash`, and not a password KDF
 *
 * The stated reflex — "hashing a credential means bcrypt/argon2" — is about
 * secrets a HUMAN chose. A KDF's work factor buys resistance to offline
 * enumeration of a small search space. `token_hash` covers a bearer token whose
 * secret half is 32 CSPRNG bytes rendered as hex (see
 * `utils/machineCredentialToken.ts`): the space is 2^256 and uniform, so a work
 * factor moves an already-unreachable number and buys nothing measurable. It
 * costs, though — this hash is verified on EVERY request the key makes, so an
 * argon2 verify would put tens of milliseconds of CPU on the hot path of the
 * inference edge. Plain SHA-256 is therefore the right primitive here for the
 * same reason it is wrong for a password, and this is the reasoning rather than
 * an inheritance from `secret_hash` beside it.
 *
 * What the choice DOES depend on is that the secret is never low-entropy or
 * caller-supplied. `generateMachineCredentialToken` is the only writer and the
 * only place that can break it; the parse regex refuses any other shape.
 *
 * ## The third kind is not a credential at all: `workload`
 *
 * ADR 0026 lets a first-party service authenticate by attesting the AWS ECS task
 * role it runs as, holding no key pair. The token it gets is minted by the same
 * `mintServiceToken` and differs in one claim: `credential_id` is the binding's
 * attestation handle (`wl_` + 96 bits of SHA-256 over the canonical role ARN)
 * rather than a row id here.
 *
 * Four tables record the identity that authorised a spend in
 * `application_credential_id`, `NOT NULL`, with a foreign key to
 * {@link applicationCredentials.id} — `usage_reservations`, `usage_receipts`,
 * `inference_usage_events`, and `inference_usage_daily_rollups`, where it is part
 * of the PRIMARY KEY. So an attested caller had nothing to spend against and the
 * inference edge refused it outright rather than failing that constraint
 * mid-request. Dropping those four constraints was prototyped and rejected:
 * `db/MIGRATION-CONTRACT.md` is "no quiero perder los vínculos relacionales de
 * nada", these are financial tables, and the constraints carry decided lifecycle
 * behaviour (`RESTRICT` on the two money tables, `CASCADE` on the two usage
 * ones).
 *
 * A `workload` row is the other answer: the binding is MATERIALISED here, with
 * the handle as its `id`, so every existing foreign key, cascade, join and report
 * keeps working untouched. The handle is already a stable identifier derived from
 * exactly one workload and from nothing else
 * (`services/workloadAttestation.service.ts`), so this makes it what it already
 * was in practice — the thing that authorised the spend.
 *
 * It is NOT a credential, and four CHECKs below make that unrepresentable rather
 * than a rule somebody has to remember:
 *
 *   * it has NO `public_key`, and that column is now nullable for exactly this
 *     reason. Every lane that resolves an OAuth `client_id` does it with
 *     `public_key = $1`, which can never match NULL — so the session mint, the
 *     authorize and consent hops, the UNAUTHENTICATED
 *     `GET /auth/oauth/client/:clientId`, the push-token client resolution and
 *     the OTA manifest lookup all refuse a workload row by construction, with no
 *     filter to forget;
 *   * it has no `secret_hash` (and no `token_prefix`/`token_hash`, which the
 *     machine biconditional already forces), so there is nothing for the OAuth
 *     token endpoint, the service-token mint or the machine bearer lane to
 *     compare against;
 *   * it names NO scopes. An attested caller's authority is the binding's,
 *     decided live by `workloadBindingScopes`; a scope array here would be a
 *     second, stale place to read authority from;
 *   * its `id` starts with `wl_` and no other row's does. That makes the routing
 *     assumption in `isWorkloadAttestationHandle` — that the handle space and the
 *     credential-id space are disjoint — a database invariant in BOTH directions,
 *     rather than a property of how ids happen to be generated.
 *
 * The management and reporting paths that CAN still match one (they select by row
 * id or by `application_id`) exclude it explicitly with
 * {@link excludeWorkloadRows}. `services/workloadAttributionIdentity.service.ts`
 * is the only writer.
 *
 * ## `expires_at` is NOT a TTL, and now carries two meanings
 *
 * Rotation sets the superseded credential to `deprecated` with
 * `expires_at = now + grace`, and `isCredentialUsable()`
 * (`utils/credentialUsability.ts`) accepts `active` OR `deprecated`-within-grace.
 * A `machine` credential may ALSO be created with a caller-configured lifetime,
 * which lands on the same column while the row stays `active` — and
 * `isCredentialUsable` already reads it that way (`active` + past `expires_at`
 * is unusable), so the second meaning needs no second predicate.
 *
 * Either way the row must OUTLIVE its deadline — it is the audit trail linking a
 * rotated secret to the one it replaced — so this table deliberately has NO
 * entry in `db/expiry.ts`. Mongo declared no TTL index here either; the
 * resemblance to one is the trap.
 */

import { ne, sql, type SQL } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { APPLICATION_SCOPES } from '../../utils/applicationScopes';
import { applications } from './applications';
import { applicationWorkloadIdentities } from './applicationWorkloadIdentities';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

/**
 * Credential kind. `service` credentials mint service tokens; `public` clients
 * hold no secret at all; `machine` credentials ARE a single `oxy_sk_…` bearer
 * token; a `workload` row is not a credential at all but the materialised
 * attestation handle of an `application_workload_identities` binding, so an
 * attested identity is something the usage ledger's foreign keys can name (see
 * the header).
 *
 * This tuple is the SINGLE declaration — the Mongoose model that carried the
 * other copy is gone. It renders the CHECK below, and
 * `check-drizzle-snapshot-sync` holds that rendering against the migration the
 * database was actually built from, so editing it without regenerating a
 * migration fails CI.
 */
export const APPLICATION_CREDENTIAL_TYPES = [
  'public',
  'confidential',
  'service',
  'machine',
  'workload',
] as const;

export type ApplicationCredentialType = (typeof APPLICATION_CREDENTIAL_TYPES)[number];

/** Every kind a caller may ask for: the stored vocabulary minus `workload`. */
export type CreatableApplicationCredentialType = Exclude<ApplicationCredentialType, 'workload'>;

/**
 * The types `POST /applications/:appId/credentials` accepts.
 *
 * A `workload` row is not something anybody requests. Its `id` must be one
 * specific attestation handle and it must carry no public identifier, so a
 * created one fails two of the CHECKs below — a Console form would get a 500
 * where it should get a 400 naming the allowed values. It exists only as the
 * materialisation of an `application_workload_identities` binding, written by
 * `services/workloadAttributionIdentity.service.ts` and by nothing else.
 *
 * A separate tuple rather than a filter over the one above, because zod needs a
 * non-empty TUPLE type and a `filter` erases that. The alias below is what keeps
 * the two from drifting: a fifth presentable kind added above and not here makes
 * it fail to compile.
 */
export const CREATABLE_APPLICATION_CREDENTIAL_TYPES = [
  'public',
  'confidential',
  'service',
  'machine',
] as const satisfies readonly CreatableApplicationCredentialType[];

/** `Assert<false>` does not satisfy the constraint, so a drift is a build error. */
type Assert<T extends true> = T;

/**
 * Every creatable type is listed above. Deliberately one-directional: `satisfies`
 * already refuses a value here that is not creatable, and this refuses a creatable
 * value that is missing.
 */
type _EveryCreatableTypeIsOffered = Assert<
  [
    Exclude<
      CreatableApplicationCredentialType,
      (typeof CREATABLE_APPLICATION_CREDENTIAL_TYPES)[number]
    >,
  ] extends [never]
    ? true
    : false
>;

/** Which deployment the credential is issued for. */
export const APPLICATION_CREDENTIAL_ENVIRONMENTS = [
  'development',
  'staging',
  'production',
] as const;

export type ApplicationCredentialEnvironment =
  (typeof APPLICATION_CREDENTIAL_ENVIRONMENTS)[number];

/**
 * Lifecycle. `pending` is an unauthenticatable two-phase handoff state;
 * `deprecated` is the 7-day rotation grace; `revoked` is immediate.
 */
export const APPLICATION_CREDENTIAL_STATUSES = [
  'pending',
  'active',
  'deprecated',
  'revoked',
] as const;

export type ApplicationCredentialStatus = (typeof APPLICATION_CREDENTIAL_STATUSES)[number];

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const applicationCredentials = pgTable(
  'application_credentials',
  {
    id: generatedId(),
    /** `CASCADE` — a credential of an application that no longer exists must not authenticate. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /**
     * Public identifier (`oxy_dk_…`), doubling as the OAuth `client_id`.
     *
     * PUBLIC, and it must never become a credential (issue #972, workstream
     * 2.1). It ships inside mobile and browser bundles and `GET
     * /auth/oauth/client/:clientId` serves it unauthenticated, so anyone who
     * has used the application has a copy — a lane that accepted it as proof
     * would be authenticating the whole world. Identification only; the
     * `secretHash` below, or a token minted from it, is what proves anything.
     * Held by `routes/__tests__/publicIdentifierNotASecret.test.ts` and
     * `middleware/__tests__/publicIdentifierNotABearer.test.ts`.
     *
     * Unique CASE-SENSITIVELY, unlike the identifier indexes on `users`: the
     * suffix is base64url, where case is significant, so `lower()` here would
     * reject two legitimately distinct client ids as duplicates.
     *
     * ## Nullable, and ONLY for a `workload` row
     *
     * Every credential kind that a caller can present has one; a `workload` row
     * is not presented by anybody, and this is the column that makes that true
     * rather than asserted. Six lanes resolve a caller's `client_id` with
     * `public_key = $1` — the session mint, `POST /auth/oauth/authorize`,
     * `GET /auth/oauth/consent`, the unauthenticated
     * `GET /auth/oauth/client/:clientId`, `utils/resolveApplicationFromClientId.ts`
     * and the OTA manifest's copy of it — and none of them can match NULL. That
     * is a column a workload row is not in, in exactly the sense the header uses
     * for `token_prefix`, and it is strictly better than six filters that each
     * have to be remembered.
     *
     * The biconditional CHECK below is what keeps the nullability from spreading:
     * a `public`, `confidential`, `service` or `machine` row with no public
     * identifier is still impossible.
     */
    publicKey: text(),
    /**
     * SHA-256 of the raw secret. Absent for a `public` client, which has none,
     * and absent for a `machine` credential, whose secret lives in
     * {@link applicationCredentials.tokenHash} instead — see the header for why
     * the two lanes are kept apart rather than sharing one column.
     */
    secretHash: text(),
    /**
     * The lookup half of an `oxy_sk_…` machine bearer token — `oxy_sk_` plus the
     * token's 16-hex id, and nothing else. Present ONLY on `machine`
     * credentials.
     *
     * Unique CASE-SENSITIVELY for the same reason `public_key` is, and unique so
     * the machine bearer lane resolves with an index probe instead of a scan. A
     * plain `unique()` suffices: Postgres unique indexes are `NULLS DISTINCT` by
     * default, so every non-machine credential's NULL coexists freely. (Mongo
     * needed `partialFilterExpression` here; that trap does not port.)
     *
     * Public by design — it is what a Console surface can render to say WHICH
     * key a row is, and it authorises nothing on its own: the other 256 bits are
     * in `token_hash` and were shown to the caller exactly once.
     */
    tokenPrefix: text(),
    /**
     * SHA-256 of the FULL `oxy_sk_…` bearer token, prefix included. Present ONLY
     * on `machine` credentials. Compared in constant time, never returned, never
     * re-derivable. The hash choice is argued in the header.
     */
    tokenHash: text(),
    type: text({ enum: APPLICATION_CREDENTIAL_TYPES }).notNull(),
    environment: text({ enum: APPLICATION_CREDENTIAL_ENVIRONMENTS }).notNull(),
    /**
     * Scopes this credential may request. The service-token mint intersects
     * these with the owning application's scopes (`intersectScopes`), so a
     * credential can never exceed its app's authority.
     */
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text({ enum: APPLICATION_CREDENTIAL_STATUSES }).notNull().default('active'),
    lastUsedAt: timestamptz(),
    /**
     * End of the rotation grace window, or — on an `active` `machine` credential
     * — the caller-configured expiry. NOT a TTL, and both meanings are read by
     * the one predicate; see the header.
     */
    expiresAt: timestamptz(),
    /**
     * The credential this one superseded at rotation — a SELF reference, and the
     * audit trail linking a new secret back to the old one.
     *
     * `SET NULL`: NULL already means "not minted by a rotation", and losing the
     * audit hop is strictly better than `CASCADE` deleting a live credential
     * because its long-dead predecessor was purged.
     *
     * The constraint is declared at table level with an explicit name (below)
     * rather than inline: drizzle's derived name for a self-reference here is 79
     * characters and Postgres silently TRUNCATES an identifier at 63, so the
     * name in this file would not be the name in the catalogue.
     */
    rotatedFromCredentialId: text(),
    /**
     * Attribution, not ownership — the application owns the credential. Nullable
     * with `SET NULL` for the same reason as `applications.created_by_user_id`:
     * Mongo's `required` only ever guaranteed a creator was recorded at INSERT,
     * and a deleted user left a dangling id with no error.
     */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /**
     * The `application_workload_identities` binding this row materialises, while
     * that binding exists. NULL on every other kind of row, and NULL again once
     * the binding is gone.
     *
     * `SET NULL`, and the choice is the whole lifecycle answer. Deleting a
     * binding is how a compromised workload is cut off, and it must take effect
     * immediately — it does, in `resolveLiveAgencyWorkloadByHandle`, which
     * re-reads the binding on every call. What it must NOT do is take the spend
     * with it: `inference_usage_events` and `inference_usage_daily_rollups`
     * cascade from this table, so a `CASCADE` here would delete a retired
     * service's usage history, and `usage_reservations` and `usage_receipts`
     * `RESTRICT`, so it would fail outright the moment there was any. `SET NULL`
     * keeps the row — an attested identity's spend stays attributable exactly as
     * a rotated-away credential's does (see `expires_at` in the header: a row
     * here must OUTLIVE its usefulness because it is the audit trail) — and the
     * NULL is itself the record that the binding is no longer live.
     *
     * Unique, so one binding has at most one materialised row. Postgres unique
     * indexes are `NULLS DISTINCT`, so every non-workload row's NULL and every
     * unlinked workload row's NULL coexist freely.
     *
     * Re-binding the SAME subject re-links the same row, because the handle is a
     * function of the subject and of nothing else — so a role that is unbound and
     * bound again keeps its own history instead of starting a second identity.
     * Binding that subject to a DIFFERENT application is refused, in
     * `services/workloadAttributionIdentity.service.ts`: this row's
     * `application_id` already names who spent the money.
     */
    workloadIdentityId: text().references(() => applicationWorkloadIdentities.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The self-reference from the rotation chain — see the column.
    foreignKey({
      columns: [t.rotatedFromCredentialId],
      foreignColumns: [t.id],
      name: 'application_credentials_rotated_from_fk',
    }).onDelete('set null'),
    unique('application_credentials_public_key_key').on(t.publicKey),
    // One binding, at most one materialised row — see the column.
    unique('application_credentials_workload_identity_id_key').on(t.workloadIdentityId),
    // The machine bearer lane's whole lookup: `where token_prefix = $1`. Unique
    // because the prefix identifies exactly one credential, and an INDEX because
    // this runs on every request an API key makes — a scan here would be the
    // difference between an index probe and a sequential read of every
    // credential on the platform.
    unique('application_credentials_token_prefix_key').on(t.tokenPrefix),
    // "This app's credentials, live ones first" — the Console credentials tab
    // and every `clientId` → application resolution. Mongo's standalone
    // `{applicationId}` is dropped: a btree serves any leading prefix.
    index('application_credentials_application_id_status_idx').on(t.applicationId, t.status),
    check(
      'application_credentials_type_check',
      sql`${t.type} in (${sql.raw(inList(APPLICATION_CREDENTIAL_TYPES))})`
    ),
    check(
      'application_credentials_environment_check',
      sql`${t.environment} in (${sql.raw(inList(APPLICATION_CREDENTIAL_ENVIRONMENTS))})`
    ),
    check(
      'application_credentials_status_check',
      sql`${t.status} in (${sql.raw(inList(APPLICATION_CREDENTIAL_STATUSES))})`
    ),
    check(
      'application_credentials_scopes_check',
      sql`${t.scopes} <@ ${sql.raw(textArrayLiteral(APPLICATION_SCOPES))}`
    ),
    // A credential cannot be its own predecessor. The one-hop case of "a
    // rotation chain is acyclic", and the shape a bad write actually produces.
    check(
      'application_credentials_rotated_from_not_self_check',
      sql`${t.rotatedFromCredentialId} <> ${t.id}`
    ),
    // The machine lane, stated as a biconditional rather than the usual
    // one-direction implication, because BOTH directions are real failures the
    // writers can produce and neither is a hypothetical: a `machine` credential
    // with no `token_prefix` has no bearer token and can never authenticate
    // (dead row), and a non-`machine` credential WITH one would be resolvable by
    // the machine bearer lane while carrying an OAuth secret — the lane crossing
    // this table exists to prevent. Both sides are non-nullable booleans
    // (`type` is `not null`, `is not null` never yields NULL), so this can never
    // evaluate to NULL and pass by accident.
    check(
      'application_credentials_machine_token_prefix_check',
      sql`(${t.type} = 'machine') = (${t.tokenPrefix} is not null)`
    ),
    // The two halves of one token travel together. Storing a prefix with no hash
    // would leave a credential nothing could ever verify against; a hash with no
    // prefix would leave one nothing could ever find.
    check(
      'application_credentials_machine_token_hash_check',
      sql`(${t.tokenHash} is null) = (${t.tokenPrefix} is null)`
    ),
    // One direction only, and deliberately: a `machine` credential must carry no
    // `secret_hash`, because that column is what the OAuth token endpoint and
    // the service-token mint compare against — a machine key holding one could
    // authenticate on lanes whose trust gate it never passed. The converse is
    // NOT asserted: a `public` client legitimately has no `secret_hash` either,
    // so `secret_hash is null` says nothing about the type.
    check(
      'application_credentials_machine_no_secret_check',
      sql`${t.type} <> 'machine' or ${t.secretHash} is null`
    ),
    // ---- the workload lane ------------------------------------------------
    // A biconditional, for the same reason the machine one is: both directions
    // are real writes somebody can make. A `workload` row WITH a public key
    // would be resolvable as an OAuth client of its application on six lanes
    // that never gated it, including an unauthenticated one; and any other kind
    // WITHOUT one would be a credential nothing could identify, which is what
    // `not null` used to prevent and still must.
    check(
      'application_credentials_workload_public_key_check',
      sql`(${t.type} = 'workload') = (${t.publicKey} is null)`
    ),
    // The handle space and the credential-id space are disjoint, as a database
    // invariant rather than as a property of how ids happen to be generated.
    // `isWorkloadAttestationHandle` ROUTES on this: a `wl_` claim is sent to the
    // binding resolver and anything else to the credential resolver. Both
    // directions matter — a credential row with a `wl_` id would be reachable by
    // a claim meant for a binding, and a workload row without one could be
    // presented as a credential id. Every existing row satisfies it: a
    // `generatedId()` is a uuid v7 and a pre-cutover id is 24 hex characters.
    check(
      'application_credentials_workload_handle_id_check',
      sql`(${t.type} = 'workload') = starts_with(${t.id}, 'wl_')`
    ),
    // A workload row is INERT: nothing to compare and no authority to read.
    // `secret_hash` is what the OAuth token endpoint and the service-token mint
    // compare, and `token_prefix`/`token_hash` are already forced null by the
    // machine biconditional above, so those three together leave no lane
    // anything to verify. The empty `scopes` is the second half and is about
    // drift rather than about a lane: an attested caller's authority is the
    // binding's, decided live by `workloadBindingScopes`, and a copy here would
    // be a stale second answer to the same question.
    check(
      'application_credentials_workload_inert_check',
      sql`${t.type} <> 'workload' or (${t.secretHash} is null and cardinality(${t.scopes}) = 0)`
    ),
    // The binding link belongs to the rows that materialise a binding, and to no
    // others — otherwise a real credential could be made to look like one.
    check(
      'application_credentials_workload_identity_only_check',
      sql`${t.type} = 'workload' or ${t.workloadIdentityId} is null`
    ),
  ]
);

/**
 * Excludes materialised workload rows from a credential query.
 *
 * One definition, so the exclusion reads the same everywhere and a reader can
 * find every site by following this symbol. It is needed ONLY on the paths that
 * select by row id or by `application_id`; every path that resolves a caller's
 * `public_key` already cannot match a workload row, because that column is NULL
 * on one (see {@link applicationCredentials.publicKey}), and relying on a
 * column a row is not in beats relying on a predicate somebody has to add.
 *
 * Deliberately NOT applied at `services/inferenceReporting.service.ts`'s
 * spending-limit scope resolution: scoping a budget to an attested identity is
 * the same question as scoping one to a credential, the foreign key on
 * `spending_limits.scope_application_credential_id` already supports it, and
 * that lookup reads an owner account rather than granting anything.
 */
export function excludeWorkloadRows(): SQL {
  return ne(applicationCredentials.type, 'workload');
}
