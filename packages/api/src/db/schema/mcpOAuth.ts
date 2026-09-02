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

export type McpOauthClientRow = typeof mcpOauthClients.$inferSelect;
export type McpOauthGrantRow = typeof mcpOauthGrants.$inferSelect;
