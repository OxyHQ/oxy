/**
 * Multi-account MCP connections.
 *
 * One OAuth grant is one account, and that is the right shape for a grant. It
 * is the wrong shape for the thing a person actually holds: a connector in an
 * assistant, which they expect to reach every account they run. Asking them to
 * register a second connector per account is not an account model.
 *
 * So a CONNECTION groups grants. The account whose token family the client
 * holds is the origin; every other member joined by opening a single-use link
 * and approving it HERE, on the IdP, while signed in as that account. Oxy owns
 * all of it — the membership, the consent, and which member the connector is
 * currently acting as — so every Oxy MCP app gets the same behaviour from
 * introspection instead of inventing its own account bundle.
 *
 * The resource server never decides membership. It presents a live access
 * token, asks for a link URL to hand the person, and reads back the account set
 * on the next introspection.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import {
  mcpOauthAccountLinkIntents,
  mcpOauthClients,
  mcpOauthConnectionAccounts,
  mcpOauthConnections,
  mcpOauthGrants,
  type McpOauthAccountLinkIntentRow,
  type McpOauthClientRow,
  type McpOauthConnectionRow,
  type McpOauthGrantRow,
} from '../db/schema/mcpOAuth';
import {
  McpOAuthError,
  grantAccountAuthorityHolds,
  normalizeMcpScopes,
  resolveMcpResource,
} from './mcpOAuth.service';

export const MCP_ACCOUNT_LINK_INTENT_TTL_SECONDS = 15 * 60;

const LINK_INTENT_PREFIX = 'oxy_mli_';

/** One member account of a connection, as reported to the resource server. */
export interface McpConnectionAccountState {
  account_id: string;
  /** True for the account whose OAuth tokens the MCP client holds. */
  is_origin: boolean;
  linked_at: string;
}

export interface McpConnectionState {
  connection_id: string;
  origin_account_id: string;
  /** The member the connector is acting as right now. */
  active_account_id: string;
  accounts: McpConnectionAccountState[];
}

export interface McpAccountLinkIntent {
  link_url: string;
  expires_in: number;
  connection_id: string;
}

export interface McpAccountLinkIntentDescription {
  client_name: string;
  client_uri: string | null;
  logo_uri: string | null;
  app_slug: string;
  resource: string;
  scopes: string[];
  /** Whether the account the viewer is signed in as is already a member. */
  already_linked: boolean;
  expires_at: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function authOrigin(): string {
  return (process.env.OXY_AUTH_URL ?? 'https://auth.oxy.so').replace(/\/$/, '');
}

/**
 * Serialize the writers that can create the same connection or membership row.
 * Scoped to the exact key so two unrelated connections never wait on each other.
 */
async function lockKey(db: DatabaseOrTransaction, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function connectionRow(
  db: DatabaseOrTransaction,
  originGrantId: string,
): Promise<McpOauthConnectionRow | null> {
  const [row] = await db.select().from(mcpOauthConnections)
    .where(eq(mcpOauthConnections.originGrantId, originGrantId))
    .limit(1);
  return row ?? null;
}

/**
 * The connection a grant's tokens drive, created on first use.
 *
 * Lazy rather than written at authorization time so grants that pre-date
 * connections behave identically to new ones: the first request that needs the
 * account set materializes it, with the origin as its only member.
 */
export async function ensureMcpConnection(grant: McpOauthGrantRow): Promise<McpOauthConnectionRow> {
  const existing = await connectionRow(getDb(), grant.id);
  if (existing) return existing;

  return getDb().transaction(async (tx) => {
    await lockKey(tx, `mcp-connection:${grant.id}`);
    const current = await connectionRow(tx, grant.id);
    const connection = current ?? (await tx.insert(mcpOauthConnections).values({
      originGrantId: grant.id,
      activeAccountId: null,
    }).returning())[0];
    if (!connection) throw new Error('MCP connection was not persisted');
    const [member] = await tx.select({ id: mcpOauthConnectionAccounts.id })
      .from(mcpOauthConnectionAccounts)
      .where(and(
        eq(mcpOauthConnectionAccounts.connectionId, connection.id),
        eq(mcpOauthConnectionAccounts.accountId, grant.effectiveAccountId),
        isNull(mcpOauthConnectionAccounts.revokedAt),
      ))
      .limit(1);
    if (!member) {
      await tx.insert(mcpOauthConnectionAccounts).values({
        connectionId: connection.id,
        grantId: grant.id,
        accountId: grant.effectiveAccountId,
        isOrigin: true,
        revokedAt: null,
      });
    }
    return connection;
  });
}

/** Live members of a connection: a membership row whose grant is still live. */
async function liveMembers(
  db: DatabaseOrTransaction,
  connectionId: string,
): Promise<Array<{
  accountId: string;
  isOrigin: boolean;
  createdAt: Date;
  grant: McpOauthGrantRow;
}>> {
  const rows = await db.select({
    accountId: mcpOauthConnectionAccounts.accountId,
    isOrigin: mcpOauthConnectionAccounts.isOrigin,
    createdAt: mcpOauthConnectionAccounts.createdAt,
    grant: mcpOauthGrants,
  })
    .from(mcpOauthConnectionAccounts)
    .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthConnectionAccounts.grantId))
    .where(and(
      eq(mcpOauthConnectionAccounts.connectionId, connectionId),
      isNull(mcpOauthConnectionAccounts.revokedAt),
      isNull(mcpOauthGrants.revokedAt),
    ))
    .orderBy(asc(mcpOauthConnectionAccounts.createdAt));
  return rows;
}

/**
 * The account set behind a live access token, and which member it is acting as.
 *
 * The selected member is re-checked on every read: a member whose grant was
 * revoked, or whose approver lost `account:act_as`, silently loses the selection
 * back to the origin account rather than letting the connector keep acting as an
 * account that no longer authorizes it.
 */
export async function resolveMcpConnectionState(grant: McpOauthGrantRow): Promise<McpConnectionState> {
  const connection = await ensureMcpConnection(grant);
  const members = await liveMembers(getDb(), connection.id);
  const accounts: McpConnectionAccountState[] = members.map((member) => ({
    account_id: member.accountId,
    is_origin: member.isOrigin,
    linked_at: member.createdAt.toISOString(),
  }));

  const selected = connection.activeAccountId;
  if (!selected || selected === grant.effectiveAccountId) {
    return {
      connection_id: connection.id,
      origin_account_id: grant.effectiveAccountId,
      active_account_id: grant.effectiveAccountId,
      accounts,
    };
  }

  const member = members.find((row) => row.accountId === selected);
  const usable = member !== undefined && await grantAccountAuthorityHolds(member.grant);
  if (!usable) {
    await getDb().update(mcpOauthConnections)
      .set({ activeAccountId: null, updatedAt: new Date() })
      .where(eq(mcpOauthConnections.id, connection.id));
  }
  return {
    connection_id: connection.id,
    origin_account_id: grant.effectiveAccountId,
    active_account_id: usable ? selected : grant.effectiveAccountId,
    accounts,
  };
}

/**
 * Point a connection at one of its members.
 *
 * The account must be a live member and its approver must still hold
 * `account:act_as` — a switch is an authorization decision, not a preference.
 */
export async function setMcpConnectionActiveAccount(input: {
  grant: McpOauthGrantRow;
  accountId: string;
}): Promise<McpConnectionState> {
  const connection = await ensureMcpConnection(input.grant);
  const members = await liveMembers(getDb(), connection.id);
  const member = members.find((row) => row.accountId === input.accountId);
  if (!member) {
    throw new McpOAuthError('invalid_request', 'That account is not connected to this MCP connection', 404);
  }
  if (!await grantAccountAuthorityHolds(member.grant)) {
    throw new McpOAuthError('access_denied', 'The account that approved this link can no longer operate it', 403);
  }
  await getDb().update(mcpOauthConnections)
    .set({
      activeAccountId: member.accountId === input.grant.effectiveAccountId ? null : member.accountId,
      updatedAt: new Date(),
    })
    .where(eq(mcpOauthConnections.id, connection.id));
  return resolveMcpConnectionState(input.grant);
}

/**
 * Mint the URL a person opens to add another account to their connection.
 *
 * The secret lives only in that URL; the row keeps its SHA-256 verifier, so a
 * database reader cannot approve anything. It is single-use and short-lived
 * because it is a standing invitation to widen an existing connector.
 */
export async function createMcpAccountLinkIntent(input: {
  grant: McpOauthGrantRow;
  scopes: readonly string[];
  now?: Date;
}): Promise<McpAccountLinkIntent> {
  const connection = await ensureMcpConnection(input.grant);
  const secret = `${LINK_INTENT_PREFIX}${randomBytes(32).toString('base64url')}`;
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + MCP_ACCOUNT_LINK_INTENT_TTL_SECONDS * 1_000);

  await getDb().insert(mcpOauthAccountLinkIntents).values({
    connectionId: connection.id,
    requestedByGrantId: input.grant.id,
    secretHash: sha256(secret),
    scopes: normalizeMcpScopes(input.scopes),
    approvedGrantId: null,
    usedAt: null,
    expiresAt,
  });

  const url = new URL('/mcp/link', authOrigin());
  url.searchParams.set('intent', secret);
  return {
    link_url: url.toString(),
    expires_in: MCP_ACCOUNT_LINK_INTENT_TTL_SECONDS,
    connection_id: connection.id,
  };
}

async function liveIntent(
  db: DatabaseOrTransaction,
  secret: string,
  now: Date,
): Promise<McpOauthAccountLinkIntentRow> {
  const [intent] = await db.select().from(mcpOauthAccountLinkIntents)
    .where(eq(mcpOauthAccountLinkIntents.secretHash, sha256(secret)))
    .limit(1);
  if (!intent || intent.usedAt || intent.expiresAt <= now) {
    throw new McpOAuthError('invalid_grant', 'This account link is invalid, expired, or already used');
  }
  return intent;
}

async function intentContext(
  db: DatabaseOrTransaction,
  intent: McpOauthAccountLinkIntentRow,
): Promise<{ connection: McpOauthConnectionRow; originGrant: McpOauthGrantRow; client: McpOauthClientRow }> {
  const [connection] = await db.select().from(mcpOauthConnections)
    .where(eq(mcpOauthConnections.id, intent.connectionId))
    .limit(1);
  if (!connection) throw new McpOAuthError('invalid_grant', 'The MCP connection no longer exists');
  const [originGrant] = await db.select().from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.id, connection.originGrantId), isNull(mcpOauthGrants.revokedAt)))
    .limit(1);
  if (!originGrant) throw new McpOAuthError('invalid_grant', 'The MCP connection has been revoked');
  const [client] = await db.select().from(mcpOauthClients)
    .where(and(eq(mcpOauthClients.id, originGrant.clientRecordId), eq(mcpOauthClients.status, 'active')))
    .limit(1);
  if (!client) throw new McpOAuthError('invalid_client', 'The MCP client is inactive', 401);
  return { connection, originGrant, client };
}

/**
 * What the IdP shows before somebody approves a link.
 *
 * Deliberately does NOT list the connection's existing members: whoever opens
 * the URL is being asked to add ONE account — their own — and the other people
 * on the connector are not theirs to enumerate.
 */
export async function describeMcpAccountLinkIntent(input: {
  secret: string;
  effectiveAccountId: string;
  now?: Date;
}): Promise<McpAccountLinkIntentDescription> {
  const now = input.now ?? new Date();
  const intent = await liveIntent(getDb(), input.secret, now);
  const { connection, originGrant, client } = await intentContext(getDb(), intent);
  const descriptor = await resolveMcpResource(originGrant.resource);
  const members = await liveMembers(getDb(), connection.id);

  return {
    client_name: client.clientName,
    client_uri: client.clientUri,
    logo_uri: client.logoUri,
    app_slug: descriptor.appSlug,
    resource: descriptor.resource,
    scopes: normalizeMcpScopes(intent.scopes),
    already_linked: members.some((member) => member.accountId === input.effectiveAccountId),
    expires_at: intent.expiresAt.toISOString(),
  };
}

/**
 * Add the approving session's account to the connection.
 *
 * The joining account gets its OWN grant, with the same scopes, so it appears
 * in that account's `GET /auth/mcp/oauth/grants` list and can be revoked from
 * its own settings without touching anybody else's.
 */
export async function approveMcpAccountLink(input: {
  secret: string;
  principalUserId: string;
  effectiveAccountId: string;
  now?: Date;
}): Promise<{ connection_id: string; account_id: string; already_linked: boolean }> {
  const now = input.now ?? new Date();
  const intent = await liveIntent(getDb(), input.secret, now);
  const { connection, originGrant } = await intentContext(getDb(), intent);
  const descriptor = await resolveMcpResource(originGrant.resource);
  if (descriptor.appSlug !== originGrant.appSlug || descriptor.audience !== originGrant.audience) {
    throw new McpOAuthError('invalid_grant', 'The MCP resource registration has changed');
  }
  if (!await grantAccountAuthorityHolds({
    principalUserId: input.principalUserId,
    effectiveAccountId: input.effectiveAccountId,
  })) {
    throw new McpOAuthError('access_denied', 'You cannot operate the selected account', 403);
  }

  return getDb().transaction(async (tx) => {
    await lockKey(tx, `mcp-link:${connection.id}:${input.effectiveAccountId}`);
    const [claimed] = await tx.update(mcpOauthAccountLinkIntents)
      .set({ usedAt: now, updatedAt: now })
      .where(and(
        eq(mcpOauthAccountLinkIntents.id, intent.id),
        isNull(mcpOauthAccountLinkIntents.usedAt),
      ))
      .returning({ id: mcpOauthAccountLinkIntents.id });
    if (!claimed) {
      throw new McpOAuthError('invalid_grant', 'This account link was already used');
    }

    const [existingGrant] = await tx.select().from(mcpOauthGrants)
      .where(and(
        eq(mcpOauthGrants.principalUserId, input.principalUserId),
        eq(mcpOauthGrants.effectiveAccountId, input.effectiveAccountId),
        eq(mcpOauthGrants.clientRecordId, originGrant.clientRecordId),
        eq(mcpOauthGrants.resource, originGrant.resource),
        isNull(mcpOauthGrants.revokedAt),
      ))
      .limit(1);
    const scopes = normalizeMcpScopes([...(existingGrant?.scopes ?? []), ...intent.scopes]);
    const grant = existingGrant
      ? (await tx.update(mcpOauthGrants).set({
          scopes,
          audience: descriptor.audience,
          appSlug: descriptor.appSlug,
          lastUsedAt: now,
          updatedAt: now,
        }).where(eq(mcpOauthGrants.id, existingGrant.id)).returning())[0]
      : (await tx.insert(mcpOauthGrants).values({
          principalUserId: input.principalUserId,
          effectiveAccountId: input.effectiveAccountId,
          clientRecordId: originGrant.clientRecordId,
          appSlug: descriptor.appSlug,
          resource: originGrant.resource,
          audience: descriptor.audience,
          scopes,
          lastUsedAt: now,
          revokedAt: null,
        }).returning())[0];
    if (!grant) throw new Error('MCP link grant was not persisted');

    const [member] = await tx.select({ id: mcpOauthConnectionAccounts.id })
      .from(mcpOauthConnectionAccounts)
      .where(and(
        eq(mcpOauthConnectionAccounts.connectionId, connection.id),
        eq(mcpOauthConnectionAccounts.accountId, input.effectiveAccountId),
        isNull(mcpOauthConnectionAccounts.revokedAt),
      ))
      .limit(1);
    if (!member) {
      await tx.insert(mcpOauthConnectionAccounts).values({
        connectionId: connection.id,
        grantId: grant.id,
        accountId: input.effectiveAccountId,
        isOrigin: false,
        revokedAt: null,
      });
    }
    await tx.update(mcpOauthAccountLinkIntents)
      .set({ approvedGrantId: grant.id, updatedAt: now })
      .where(eq(mcpOauthAccountLinkIntents.id, intent.id));

    return {
      connection_id: connection.id,
      account_id: input.effectiveAccountId,
      already_linked: member !== undefined,
    };
  });
}

/**
 * Retire every membership a revoked grant holds.
 *
 * Called from grant revocation, so an account leaving takes effect on every
 * connection it had joined — its own, and any it was invited into.
 */
export async function revokeMcpConnectionMemberships(
  db: DatabaseOrTransaction,
  grantId: string,
  when = new Date(),
): Promise<void> {
  await db.update(mcpOauthConnectionAccounts)
    .set({ revokedAt: when, updatedAt: when })
    .where(and(
      eq(mcpOauthConnectionAccounts.grantId, grantId),
      isNull(mcpOauthConnectionAccounts.revokedAt),
    ));
}
