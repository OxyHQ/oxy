/**
 * `user_linked_accounts` — an external account a LOCAL Oxy user has PROVEN they
 * own, and the three tables that make the proof possible.
 *
 * ## What a row means
 *
 * "This Oxy user completed an OAuth authorization at that network, and the
 * network told us — not the user — which account authorized it." That is the
 * whole claim. A Mastodon-API server answers it with
 * `GET /api/v1/accounts/verify_credentials`; an atproto authorization server
 * answers it with the `sub` DID of the token response, which the client library
 * checks against the DID's own PDS. Nothing the user typed is stored as
 * identity: the handle they entered only chooses where to go.
 *
 * ## No third-party token lives here, and none lives anywhere else in Oxy
 *
 * The same rule as `inference_provider_connections` ("a provider secret never
 * reaches this table"), applied to users: the OAuth flow exists to PROVE
 * ownership, so the access token is used for exactly one identity read and then
 * dropped — Mastodon's is revoked at the instance (`POST /oauth/revoke`), the
 * atproto session is signed out and only ever lived in process memory. There is
 * deliberately no token column, encrypted or otherwise, on any of these tables;
 * `routes/__tests__/linkedAccounts.test.ts` asserts that against the catalogue.
 * Content import reads public data (outboxes, public XRPC) and needs none.
 *
 * ## One live claim per external account
 *
 * `(network, account_key) WHERE revoked_at IS NULL` is unique: an external
 * account can be claimed by ONE Oxy user at a time, because it becomes that
 * user's `alsoKnownAs` alias and the anchor of a Mastodon `Move` — two local
 * accounts announcing the same alias would let either one receive the other's
 * followers. A second claim is a 409; revoking the first frees the account.
 *
 * `account_key` is the network's own stable name for the account: for
 * ActivityPub the `username@domain` WebFinger address (lower-cased, domain from
 * the instance's WebFinger subject so a split-domain server is keyed by its
 * public domain); for atproto the DID. `actor_uri` is what a follower's server
 * dereferences: the AP actor id, or the DID again for atproto.
 *
 * ## Relationship to `external_identities` — read, never written
 *
 * `external_identities.user_id` is the FEDERATED SHADOW user Oxy mints for a
 * remote account it discovers; the column here is the LOCAL person who proved
 * they own that remote account. The two are different people-records by
 * design, so this table does not repurpose or reference that one. The service
 * read (`GET /linked-accounts/by-user/:userId`) reports the shadow user through
 * `lookupExternalIdentity(actorUri)` so an importer can adopt content Oxy
 * already federated in; merging the two is the job of a verified `Move`.
 *
 * `use_as_alias` is only meaningful for ActivityPub (atproto has no
 * `alsoKnownAs` a Mastodon `Move` reads), so a CHECK keeps it false elsewhere.
 * The live `activitypub` rows with it set ARE the user's aliases — there is no
 * separate alias table.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

/** Networks an account can be linked from. */
export const LINKED_ACCOUNT_NETWORK_VALUES = ['activitypub', 'atproto'] as const;

/** How ownership was proven. OAuth only, for now; the CHECK is the extension point. */
export const LINKED_ACCOUNT_PROOF_METHOD_VALUES = ['oauth'] as const;

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const userLinkedAccounts = pgTable(
  'user_linked_accounts',
  {
    id: generatedId(),
    /** The LOCAL Oxy user who proved ownership. `CASCADE`: the claim dies with the account. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    network: text({ enum: LINKED_ACCOUNT_NETWORK_VALUES }).notNull(),
    /** `username@domain` (lower-cased) for ActivityPub; the DID for atproto. */
    accountKey: text().notNull(),
    /** The AP actor id, or the DID for atproto. */
    actorUri: text().notNull(),
    /** Display handle, as the network reported it at verification time. */
    handle: text().notNull(),
    /** Instance host (ActivityPub) or PDS host (atproto) the proof came from. */
    host: text().notNull(),
    proofMethod: text({ enum: LINKED_ACCOUNT_PROOF_METHOD_VALUES }).notNull().default('oauth'),
    verifiedAt: timestamptz().notNull(),
    /** `null` while the link is live. Revocation is a stamp, so the history stays. */
    revokedAt: timestamptz(),
    /** Publish `actor_uri` in the user's ActivityPub `alsoKnownAs`. ActivityPub only. */
    useAsAlias: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('user_linked_accounts_live_account_key')
      .on(t.network, t.accountKey)
      .where(sql`${t.revokedAt} is null`),
    index('user_linked_accounts_user_id_idx').on(t.userId),
    check(
      'user_linked_accounts_network_check',
      sql`${t.network} in (${sql.raw(inList(LINKED_ACCOUNT_NETWORK_VALUES))})`,
    ),
    check(
      'user_linked_accounts_proof_method_check',
      sql`${t.proofMethod} in (${sql.raw(inList(LINKED_ACCOUNT_PROOF_METHOD_VALUES))})`,
    ),
    check(
      'user_linked_accounts_alias_network_check',
      sql`${t.network} = 'activitypub' or ${t.useAsAlias} = false`,
    ),
  ],
);

/**
 * `linked_account_oauth_challenges` — the ten-minute state of one OAuth
 * round trip: who started it, where it may return to, and the PKCE material.
 *
 * Only the SHA-256 of the `state` parameter is stored, so a database read cannot
 * complete someone else's flow. `state_hash` is nullable because the atproto
 * client library mints its own `state` AFTER the row exists (the row id travels
 * as the library's `appState`). Spending is one transaction that filters
 * `used_at is null and expires_at > now()` and wipes both secret columns in the
 * same UPDATE, so the row is class (A) in `CONVENTIONS.md` terms and the sweep
 * in `db/expiry.ts` is housekeeping.
 */
export const linkedAccountOauthChallenges = pgTable(
  'linked_account_oauth_challenges',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    network: text({ enum: LINKED_ACCOUNT_NETWORK_VALUES }).notNull(),
    /** SHA-256 hex of the OAuth `state`. The state itself is never stored. */
    stateHash: text(),
    /** Instance host for ActivityPub; `null` for atproto until the library resolves one. */
    host: text(),
    /** PKCE verifier (Mastodon). Protected; wiped when the challenge is spent. */
    pkceVerifier: text(),
    /**
     * The atproto client library's own per-flow state (its PKCE verifier, the
     * authorization server it chose, and the flow's ephemeral DPoP key).
     * Protected; wiped when the challenge is spent.
     */
    providerState: jsonb().$type<Record<string, unknown>>(),
    /** The application whose registered redirect URI `return_to` matched. */
    clientApplicationId: text().references(() => applications.id, { onDelete: 'cascade' }),
    /** Validated against the application's redirect URIs at start; `null` renders a page. */
    returnTo: text(),
    expiresAt: timestamptz().notNull(),
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('linked_account_oauth_challenges_state_hash_key').on(t.stateHash),
    index('linked_account_oauth_challenges_expires_at_idx').on(t.expiresAt),
    index('linked_account_oauth_challenges_user_id_idx').on(t.userId),
    check(
      'linked_account_oauth_challenges_network_check',
      sql`${t.network} in (${sql.raw(inList(LINKED_ACCOUNT_NETWORK_VALUES))})`,
    ),
    check(
      'linked_account_oauth_challenges_state_hash_check',
      sql`${t.stateHash} is null or ${t.stateHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * `mastodon_app_registrations` — Oxy's own OAuth client at each Mastodon-API
 * instance, from `POST /api/v1/apps`.
 *
 * `client_secret` is OXY's credential at that instance, not a user's; it
 * authorizes nothing without a user's consent and PKCE. It is still registered
 * as a protected column, because a client secret in a DTO is a leak whoever it
 * belongs to. A row is re-registered when the redirect URI or scopes Oxy asks
 * for change, so a config change cannot keep using a stale registration.
 */
export const mastodonAppRegistrations = pgTable('mastodon_app_registrations', {
  /** Lower-cased instance hostname. */
  host: text().primaryKey(),
  clientId: text().notNull(),
  clientSecret: text().notNull(),
  redirectUri: text().notNull(),
  scopes: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
