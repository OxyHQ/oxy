/**
 * External MCP OAuth authority.
 *
 * These rows are deliberately separate from Oxy sign-in sessions and OAuth
 * application credentials. An MCP client receives only a resource-bound grant;
 * no session token, device secret, or connected-service credential is stored
 * here or returned to it.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const MCP_OAUTH_CLIENT_STATUSES = ['active', 'revoked'] as const;

export const mcpOauthClients = pgTable(
  'mcp_oauth_clients',
  {
    id: generatedId(),
    /** Public RFC 7591 client identifier. It is never accepted as a credential. */
    clientId: text().notNull(),
    clientName: text().notNull(),
    redirectUris: text().array().notNull(),
    grantTypes: text().array().notNull(),
    responseTypes: text().array().notNull(),
    tokenEndpointAuthMethod: text({ enum: ['none'] }).notNull().default('none'),
    clientUri: text(),
    logoUri: text(),
    status: text({ enum: MCP_OAUTH_CLIENT_STATUSES }).notNull().default('active'),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('mcp_oauth_clients_client_id_key').on(t.clientId),
    check('mcp_oauth_clients_status_check', sql`${t.status} in ('active', 'revoked')`),
    check(
      'mcp_oauth_clients_revoked_at_check',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
    check(
      'mcp_oauth_clients_grant_types_check',
      sql`${t.grantTypes} <@ array['authorization_code', 'refresh_token']::text[]
        and ${t.grantTypes} @> array['authorization_code']::text[]`,
    ),
    check(
      'mcp_oauth_clients_response_types_check',
      sql`${t.responseTypes} = array['code']::text[]`,
    ),
    check(
      'mcp_oauth_clients_redirect_uris_check',
      sql`cardinality(${t.redirectUris}) > 0`,
    ),
  ],
);

export const mcpOauthGrants = pgTable(
  'mcp_oauth_grants',
  {
    id: generatedId(),
    /** Human who approved the connection. */
    principalUserId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** Exact Oxy account exposed through the MCP resource. */
    effectiveAccountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientRecordId: text().notNull().references(() => mcpOauthClients.id, { onDelete: 'cascade' }),
    appSlug: text().notNull(),
    resource: text().notNull(),
    audience: text().notNull(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamptz().notNull().defaultNow(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mcp_oauth_grants_active_key')
      .on(t.principalUserId, t.effectiveAccountId, t.clientRecordId, t.resource)
      .where(sql`${t.revokedAt} is null`),
    index('mcp_oauth_grants_account_idx').on(t.effectiveAccountId, t.createdAt),
    index('mcp_oauth_grants_client_idx').on(t.clientRecordId, t.createdAt),
  ],
);

export const mcpOauthAuthorizationCodes = pgTable(
  'mcp_oauth_authorization_codes',
  {
    id: generatedId(),
    /** SHA-256 verifier of the opaque code; the bearer value is never stored. */
    codeHash: text().notNull(),
    grantId: text().notNull().references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    redirectUri: text().notNull(),
    codeChallenge: text().notNull(),
    resource: text().notNull(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    usedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('mcp_oauth_authorization_codes_hash_key').on(t.codeHash),
    index('mcp_oauth_authorization_codes_expiry_idx').on(t.expiresAt),
    index('mcp_oauth_authorization_codes_grant_idx').on(t.grantId),
  ],
);

export const mcpOauthAccessTokens = pgTable(
  'mcp_oauth_access_tokens',
  {
    id: generatedId(),
    /** Signed JWT id used for live revocation checks. */
    jti: text().notNull(),
    grantId: text().notNull().references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('mcp_oauth_access_tokens_jti_key').on(t.jti),
    index('mcp_oauth_access_tokens_expiry_idx').on(t.expiresAt),
    index('mcp_oauth_access_tokens_grant_idx').on(t.grantId),
  ],
);

export const mcpOauthRefreshTokens = pgTable(
  'mcp_oauth_refresh_tokens',
  {
    id: generatedId(),
    /** SHA-256 verifier of the opaque refresh token; the bearer value is never stored. */
    tokenHash: text().notNull(),
    grantId: text().notNull().references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    /** Opaque token-family correlation key, not a row id. */
    familyKey: text().notNull(),
    parentTokenId: text().references((): AnyPgColumn => mcpOauthRefreshTokens.id, {
      onDelete: 'set null',
    }),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    usedAt: timestamptz(),
    revokedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('mcp_oauth_refresh_tokens_hash_key').on(t.tokenHash),
    index('mcp_oauth_refresh_tokens_family_idx').on(t.familyKey),
    index('mcp_oauth_refresh_tokens_expiry_idx').on(t.expiresAt),
    index('mcp_oauth_refresh_tokens_grant_idx').on(t.grantId),
  ],
);

/**
 * An MCP connection: the account set one MCP client installation may act as.
 *
 * A grant is one account. A CONNECTION is the durable thing the person holds in
 * their assistant — the connector they authorized once — and it can cover more
 * than the account that started it, because asking somebody to register a second
 * connector per account is not an account model, it is a workaround.
 *
 * `originGrantId` is the grant whose token family the client actually holds and
 * refreshes; every other member joined through an explicit, single-use link
 * approval (`mcp_oauth_account_link_intents`) made while signed in AS that
 * account. Membership therefore never widens without that account's own consent,
 * and each member keeps its own grant row, so each account revokes its own
 * participation from its own Oxy settings.
 */
export const mcpOauthConnections = pgTable(
  'mcp_oauth_connections',
  {
    id: generatedId(),
    /** The grant the MCP client holds tokens for. One connection per grant. */
    originGrantId: text().notNull().references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    /**
     * Which member account the client is currently acting as. NULL means the
     * origin grant's account — the state every connection starts in, and the one
     * it falls back to when the selected member is revoked.
     */
    activeAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('mcp_oauth_connections_origin_grant_key').on(t.originGrantId),
    index('mcp_oauth_connections_active_account_idx').on(t.activeAccountId),
  ],
);

/**
 * Membership: one row per grant that belongs to a connection, including the
 * origin grant itself.
 *
 * A junction rather than a column on the grant, because a grant can be BOTH its
 * own connection's origin and a member of somebody else's connection. Collapsing
 * that into one `connection_id` column would let a second connector inherit the
 * first one's account list — the exact leak this table's shape prevents.
 */
export const mcpOauthConnectionAccounts = pgTable(
  'mcp_oauth_connection_accounts',
  {
    id: generatedId(),
    connectionId: text().notNull().references(() => mcpOauthConnections.id, { onDelete: 'cascade' }),
    grantId: text().notNull().references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    /** The account this membership exposes, denormalized for the listing read. */
    accountId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** True for the account whose OAuth tokens the client holds. */
    isOrigin: boolean().notNull().default(false),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mcp_oauth_connection_accounts_live_key')
      .on(t.connectionId, t.accountId)
      .where(sql`${t.revokedAt} is null`),
    index('mcp_oauth_connection_accounts_connection_idx').on(t.connectionId, t.revokedAt),
    index('mcp_oauth_connection_accounts_grant_idx').on(t.grantId),
  ],
);

/**
 * A single-use invitation to add ANOTHER account to an existing connection.
 *
 * The resource server mints one on behalf of a live access token, hands the
 * person the URL, and the person approves it on the IdP while signed in as the
 * account being added. Only the SHA-256 verifier is stored: the URL is the
 * credential, and it is spent on first approval — the same lifecycle as an
 * authorization code, which is why the column is `code_hash`.
 */
export const mcpOauthAccountLinkIntents = pgTable(
  'mcp_oauth_account_link_intents',
  {
    id: generatedId(),
    connectionId: text().notNull().references(() => mcpOauthConnections.id, { onDelete: 'cascade' }),
    /** The grant whose access token asked for the link. */
    requestedByGrantId: text().notNull().references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    /**
     * SHA-256 verifier of the opaque value in the link URL; it is never stored.
     *
     * Named like `mcp_oauth_authorization_codes.code_hash` because it IS that
     * class of thing — a single-use, short-lived authorization artifact
     * exchanged for a grant — and NOT a `*_secret_hash`, which in this schema
     * means a key table with a credential lifecycle (ADR 0005, guarded by
     * `schemaInvariants.test.ts`). Nothing here is re-presented on later
     * requests.
     */
    codeHash: text().notNull(),
    /** Scopes the joining account is asked to approve — the connection's own. */
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    /** The membership created when the intent was approved. */
    approvedGrantId: text().references(() => mcpOauthGrants.id, { onDelete: 'set null' }),
    usedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('mcp_oauth_account_link_intents_code_key').on(t.codeHash),
    index('mcp_oauth_account_link_intents_expiry_idx').on(t.expiresAt),
    index('mcp_oauth_account_link_intents_connection_idx').on(t.connectionId),
  ],
);

export type McpOauthClientRow = typeof mcpOauthClients.$inferSelect;
export type McpOauthGrantRow = typeof mcpOauthGrants.$inferSelect;
export type McpOauthConnectionRow = typeof mcpOauthConnections.$inferSelect;
export type McpOauthConnectionAccountRow = typeof mcpOauthConnectionAccounts.$inferSelect;
export type McpOauthAccountLinkIntentRow = typeof mcpOauthAccountLinkIntents.$inferSelect;
