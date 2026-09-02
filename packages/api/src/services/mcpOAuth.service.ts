import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  issueMcpAccessToken,
  validateMcpAccessTokenClaims,
  verifyMcpAccessTokenSignature,
  type McpAccessTokenClaims,
} from '@oxyhq/mcp';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  type McpOauthClientRow,
  type McpOauthGrantRow,
} from '../db/schema/mcpOAuth';
import accountService from './account.service';
import { listActiveCapabilityCatalogs } from './capabilityCatalog.service';

export const MCP_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const AUTHORIZATION_CODE_PREFIX = 'oxy_mac_';
const REFRESH_TOKEN_PREFIX = 'oxy_mrt_';
const CLIENT_ID_PREFIX = 'oxy_mcp_';

export class McpOAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'unsupported_grant_type'
      | 'access_denied',
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

export interface McpResourceDescriptor {
  readonly appSlug: string;
  readonly audience: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly registeredByApplicationId: string;
}

export interface McpTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
  resource: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function equalStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function canonicalMcpResource(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError('invalid_request', 'resource must be an absolute URI');
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new McpOAuthError('invalid_request', 'resource must use HTTPS outside local development');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new McpOAuthError('invalid_request', 'resource cannot contain credentials, query or fragment');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export function normalizeMcpScopes(value: string | readonly string[] | undefined): string[] {
  const source: readonly string[] = typeof value === 'string'
    ? value.split(/\s+/)
    : (value ?? []);
  return [...new Set(source.map((scope) => scope.trim()).filter(Boolean))].sort();
}

export function validateMcpRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError('invalid_request', 'redirect_uri must be an absolute URI');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.hash || url.username || url.password) {
    throw new McpOAuthError('invalid_request', 'redirect_uri cannot contain credentials or a fragment');
  }
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new McpOAuthError('invalid_request', 'redirect_uri must use HTTPS or an HTTP loopback address');
  }
  return value;
}

export function mcpRedirectUriAllowed(client: McpOauthClientRow, redirectUri: string): boolean {
  return client.redirectUris.some((registered) => equalStrings(registered, redirectUri));
}

export async function resolveMcpResource(resource: string): Promise<McpResourceDescriptor> {
  const canonical = canonicalMcpResource(resource);
  const registrations = await listActiveCapabilityCatalogs();
  const registration = registrations.find((entry) => {
    const registered = entry.catalog.externalMcp?.resource;
    return registered !== undefined && canonicalMcpResource(registered) === canonical;
  });
  if (!registration?.catalog.externalMcp) {
    throw new McpOAuthError('invalid_request', 'resource is not a registered Oxy MCP server');
  }
  const scopes = [...new Set(
    registration.catalog.tools
      .filter((tool) => tool.exposure.includes('mcp'))
      .flatMap((tool) => tool.requiredCapabilities),
  )].sort();
  return {
    appSlug: registration.appSlug,
    audience: registration.audience,
    resource: canonicalMcpResource(registration.catalog.externalMcp.resource),
    scopes,
    registeredByApplicationId: registration.registeredByApplicationId,
  };
}

function assertScopesAllowed(requested: readonly string[], descriptor: McpResourceDescriptor): void {
  if (requested.length === 0) {
    throw new McpOAuthError('invalid_scope', 'At least one MCP scope is required');
  }
  const supported = new Set(descriptor.scopes);
  const denied = requested.filter((scope) => !supported.has(scope));
  if (denied.length > 0) {
    throw new McpOAuthError('invalid_scope', `Unsupported MCP scopes: ${denied.join(' ')}`);
  }
}

async function currentAccountAuthority(grant: Pick<McpOauthGrantRow, 'principalUserId' | 'effectiveAccountId'>): Promise<boolean> {
  const access = await accountService.resolveEffectiveAccess(grant.principalUserId, grant.effectiveAccountId);
  return access?.permissions.includes('account:act_as') ?? false;
}

export function newMcpClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export async function findActiveMcpClient(clientId: string): Promise<McpOauthClientRow | null> {
  const [client] = await getDb()
    .select()
    .from(mcpOauthClients)
    .where(and(eq(mcpOauthClients.clientId, clientId), eq(mcpOauthClients.status, 'active')))
    .limit(1);
  return client ?? null;
}

export async function registerMcpClient(input: {
  clientName: string;
  redirectUris: readonly string[];
  grantTypes: readonly string[];
  clientUri?: string;
  logoUri?: string;
}): Promise<McpOauthClientRow> {
  const [client] = await getDb().insert(mcpOauthClients).values({
    clientId: newMcpClientId(),
    clientName: input.clientName,
    redirectUris: [...input.redirectUris],
    grantTypes: [...input.grantTypes],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
    clientUri: input.clientUri ?? null,
    logoUri: input.logoUri ?? null,
    status: 'active',
    revokedAt: null,
  }).returning();
  if (!client) throw new Error('MCP OAuth client registration was not persisted');
  return client;
}

export async function mcpConsentRequired(input: {
  principalUserId: string;
  effectiveAccountId: string;
  client: McpOauthClientRow;
  descriptor: McpResourceDescriptor;
  scopes: readonly string[];
}): Promise<boolean> {
  assertScopesAllowed(input.scopes, input.descriptor);
  const [grant] = await getDb()
    .select({ scopes: mcpOauthGrants.scopes })
    .from(mcpOauthGrants)
    .where(and(
      eq(mcpOauthGrants.principalUserId, input.principalUserId),
      eq(mcpOauthGrants.effectiveAccountId, input.effectiveAccountId),
      eq(mcpOauthGrants.clientRecordId, input.client.id),
      eq(mcpOauthGrants.resource, input.descriptor.resource),
      isNull(mcpOauthGrants.revokedAt),
    ))
    .limit(1);
  if (!grant) return true;
  const granted = new Set(grant.scopes);
  return input.scopes.some((scope) => !granted.has(scope));
}

export async function authorizeMcpConnection(input: {
  principalUserId: string;
  effectiveAccountId: string;
  client: McpOauthClientRow;
  descriptor: McpResourceDescriptor;
  redirectUri: string;
  codeChallenge: string;
  scopes: readonly string[];
}): Promise<{ code: string; expiresIn: number }> {
  assertScopesAllowed(input.scopes, input.descriptor);
  if (!mcpRedirectUriAllowed(input.client, input.redirectUri)) {
    throw new McpOAuthError('invalid_request', 'redirect_uri is not registered for this client');
  }
  if (!await currentAccountAuthority({
    principalUserId: input.principalUserId,
    effectiveAccountId: input.effectiveAccountId,
  })) {
    throw new McpOAuthError('access_denied', 'The approving user can no longer operate this account', 403);
  }

  const code = opaque(AUTHORIZATION_CODE_PREFIX);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MCP_AUTHORIZATION_CODE_TTL_SECONDS * 1_000);
  await getDb().transaction(async (tx) => {
    await tx.execute(
      // Serializes two approvals for the same connection without widening the
      // lock to any other client/account/resource tuple.
      sql`select pg_advisory_xact_lock(hashtextextended(${`mcp-grant:${input.principalUserId}:${input.effectiveAccountId}:${input.client.id}:${input.descriptor.resource}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(mcpOauthGrants)
      .where(and(
        eq(mcpOauthGrants.principalUserId, input.principalUserId),
        eq(mcpOauthGrants.effectiveAccountId, input.effectiveAccountId),
        eq(mcpOauthGrants.clientRecordId, input.client.id),
        eq(mcpOauthGrants.resource, input.descriptor.resource),
        isNull(mcpOauthGrants.revokedAt),
      ))
      .limit(1);
    const scopes = normalizeMcpScopes([...(existing?.scopes ?? []), ...input.scopes]);
    const grant = existing
      ? (await tx.update(mcpOauthGrants).set({
          scopes,
          audience: input.descriptor.audience,
          appSlug: input.descriptor.appSlug,
          lastUsedAt: now,
          updatedAt: now,
        }).where(eq(mcpOauthGrants.id, existing.id)).returning())[0]
      : (await tx.insert(mcpOauthGrants).values({
          principalUserId: input.principalUserId,
          effectiveAccountId: input.effectiveAccountId,
          clientRecordId: input.client.id,
          appSlug: input.descriptor.appSlug,
          resource: input.descriptor.resource,
          audience: input.descriptor.audience,
          scopes,
          lastUsedAt: now,
          revokedAt: null,
        }).returning())[0];
    if (!grant) throw new Error('MCP OAuth grant was not persisted');
    await tx.insert(mcpOauthAuthorizationCodes).values({
      codeHash: sha256(code),
      grantId: grant.id,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      resource: input.descriptor.resource,
      scopes: [...input.scopes],
      usedAt: null,
      expiresAt,
    });
  });
  return { code, expiresIn: MCP_AUTHORIZATION_CODE_TTL_SECONDS };
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function issueTokenPair(
  db: DatabaseOrTransaction,
  grant: McpOauthGrantRow,
  client: McpOauthClientRow,
  scopes: readonly string[],
  refreshFamily?: { familyKey: string; parentTokenId: string },
): Promise<McpTokenResponse> {
  const signing = capabilityTicketSigningConfig();
  const issuer = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
  const issued = issueMcpAccessToken({
    sub: grant.principalUserId,
    aud: grant.audience,
    resource: grant.resource,
    client_id: client.clientId,
    scope: normalizeMcpScopes(scopes).join(' '),
    account_id: grant.effectiveAccountId,
  }, {
    privateKey: signing.privateKey,
    keyId: signing.keyId,
    issuer,
    ttlSeconds: MCP_ACCESS_TOKEN_TTL_SECONDS,
  });
  const refreshToken = opaque(REFRESH_TOKEN_PREFIX);
  const refreshExpiresAt = new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_SECONDS * 1_000);
  await db.insert(mcpOauthAccessTokens).values({
    jti: issued.claims.jti,
    grantId: grant.id,
    scopes: [...scopes],
    expiresAt: new Date(issued.claims.exp * 1_000),
    revokedAt: null,
  });
  await db.insert(mcpOauthRefreshTokens).values({
    tokenHash: sha256(refreshToken),
    grantId: grant.id,
    familyKey: refreshFamily?.familyKey ?? randomUUID(),
    parentTokenId: refreshFamily?.parentTokenId ?? null,
    scopes: [...scopes],
    usedAt: null,
    revokedAt: null,
    expiresAt: refreshExpiresAt,
  });
  return {
    access_token: issued.token,
    token_type: 'Bearer',
    expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: normalizeMcpScopes(scopes).join(' '),
    resource: grant.resource,
  };
}

async function liveGrantContext(grantId: string): Promise<{
  grant: McpOauthGrantRow;
  client: McpOauthClientRow;
  descriptor: McpResourceDescriptor;
}> {
  const [grant] = await getDb().select().from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.revokedAt)))
    .limit(1);
  if (!grant) throw new McpOAuthError('invalid_grant', 'The MCP authorization grant is inactive');
  const [client] = await getDb().select().from(mcpOauthClients)
    .where(and(eq(mcpOauthClients.id, grant.clientRecordId), eq(mcpOauthClients.status, 'active')))
    .limit(1);
  if (!client) throw new McpOAuthError('invalid_client', 'The MCP client is inactive', 401);
  const descriptor = await resolveMcpResource(grant.resource);
  if (descriptor.appSlug !== grant.appSlug || descriptor.audience !== grant.audience) {
    throw new McpOAuthError('invalid_grant', 'The MCP resource registration has changed');
  }
  assertScopesAllowed(grant.scopes, descriptor);
  if (!await currentAccountAuthority(grant)) {
    throw new McpOAuthError('invalid_grant', 'The approving user can no longer operate this account');
  }
  return { grant, client, descriptor };
}

export async function exchangeMcpAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}): Promise<McpTokenResponse> {
  const [authorizationCode] = await getDb().select().from(mcpOauthAuthorizationCodes)
    .where(eq(mcpOauthAuthorizationCodes.codeHash, sha256(input.code)))
    .limit(1);
  if (!authorizationCode || authorizationCode.usedAt || authorizationCode.expiresAt <= new Date()) {
    throw new McpOAuthError('invalid_grant', 'Authorization code is invalid, expired, or already used');
  }
  const context = await liveGrantContext(authorizationCode.grantId);
  if (!equalStrings(context.client.clientId, input.clientId)
    || !equalStrings(authorizationCode.redirectUri, input.redirectUri)
    || authorizationCode.resource !== canonicalMcpResource(input.resource)
    || !equalStrings(authorizationCode.codeChallenge, pkceChallenge(input.codeVerifier))) {
    throw new McpOAuthError('invalid_grant', 'Authorization code binding does not match');
  }

  return getDb().transaction(async (tx) => {
    const [claimed] = await tx.update(mcpOauthAuthorizationCodes)
      .set({ usedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(mcpOauthAuthorizationCodes.id, authorizationCode.id),
        isNull(mcpOauthAuthorizationCodes.usedAt),
        gt(mcpOauthAuthorizationCodes.expiresAt, new Date()),
      ))
      .returning({ id: mcpOauthAuthorizationCodes.id });
    if (!claimed) throw new McpOAuthError('invalid_grant', 'Authorization code was already used');
    return issueTokenPair(tx, context.grant, context.client, authorizationCode.scopes);
  });
}

async function revokeGrant(db: DatabaseOrTransaction, grantId: string, when = new Date()): Promise<void> {
  await db.update(mcpOauthGrants).set({ revokedAt: when, updatedAt: when })
    .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.revokedAt)));
  await db.update(mcpOauthAccessTokens).set({ revokedAt: when })
    .where(and(eq(mcpOauthAccessTokens.grantId, grantId), isNull(mcpOauthAccessTokens.revokedAt)));
  await db.update(mcpOauthRefreshTokens).set({ revokedAt: when })
    .where(and(eq(mcpOauthRefreshTokens.grantId, grantId), isNull(mcpOauthRefreshTokens.revokedAt)));
}

export async function refreshMcpAccessToken(input: {
  refreshToken: string;
  clientId: string;
  resource: string;
}): Promise<McpTokenResponse> {
  const [refresh] = await getDb().select().from(mcpOauthRefreshTokens)
    .where(eq(mcpOauthRefreshTokens.tokenHash, sha256(input.refreshToken)))
    .limit(1);
  if (!refresh) throw new McpOAuthError('invalid_grant', 'Refresh token is invalid');
  const context = await liveGrantContext(refresh.grantId);
  if (!equalStrings(context.client.clientId, input.clientId)
    || context.grant.resource !== canonicalMcpResource(input.resource)) {
    throw new McpOAuthError('invalid_grant', 'Refresh token binding does not match');
  }

  const outcome = await getDb().transaction(async (tx) => {
    const [claimed] = await tx.update(mcpOauthRefreshTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(mcpOauthRefreshTokens.id, refresh.id),
        isNull(mcpOauthRefreshTokens.usedAt),
        isNull(mcpOauthRefreshTokens.revokedAt),
        gt(mcpOauthRefreshTokens.expiresAt, new Date()),
      ))
      .returning();
    if (!claimed) {
      const [current] = await tx.select().from(mcpOauthRefreshTokens)
        .where(eq(mcpOauthRefreshTokens.id, refresh.id)).limit(1);
      if (current?.usedAt) await revokeGrant(tx, refresh.grantId);
      return null;
    }
    return issueTokenPair(tx, context.grant, context.client, claimed.scopes, {
      familyKey: claimed.familyKey,
      parentTokenId: claimed.id,
    });
  });
  if (!outcome) throw new McpOAuthError('invalid_grant', 'Refresh token is expired, revoked, or reused');
  return outcome;
}

export async function revokeMcpToken(token: string, clientId: string): Promise<void> {
  if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
    const [row] = await getDb()
      .select({ grantId: mcpOauthRefreshTokens.grantId, registeredClientId: mcpOauthClients.clientId })
      .from(mcpOauthRefreshTokens)
      .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthRefreshTokens.grantId))
      .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientRecordId))
      .where(eq(mcpOauthRefreshTokens.tokenHash, sha256(token)))
      .limit(1);
    if (row && equalStrings(row.registeredClientId, clientId)) await revokeGrant(getDb(), row.grantId);
    return;
  }
  try {
    const signing = capabilityTicketSigningConfig();
    const claims = verifyMcpAccessTokenSignature(token, {
      resolvePublicKey: (keyId) => keyId === signing.keyId ? signing.publicKey : undefined,
    });
    const [row] = await getDb()
      .select({ id: mcpOauthAccessTokens.id, registeredClientId: mcpOauthClients.clientId })
      .from(mcpOauthAccessTokens)
      .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthAccessTokens.grantId))
      .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientRecordId))
      .where(eq(mcpOauthAccessTokens.jti, claims.jti))
      .limit(1);
    if (row && equalStrings(row.registeredClientId, clientId)) {
      await getDb().update(mcpOauthAccessTokens).set({ revokedAt: new Date() })
        .where(eq(mcpOauthAccessTokens.id, row.id));
    }
  } catch {
    // RFC 7009 intentionally does not reveal whether the token existed.
  }
}

export async function revokeMcpGrant(input: {
  grantId: string;
  principalUserId: string;
  effectiveAccountId: string;
}): Promise<boolean> {
  const [grant] = await getDb().select({ id: mcpOauthGrants.id })
    .from(mcpOauthGrants)
    .where(and(
      eq(mcpOauthGrants.id, input.grantId),
      eq(mcpOauthGrants.principalUserId, input.principalUserId),
      eq(mcpOauthGrants.effectiveAccountId, input.effectiveAccountId),
      isNull(mcpOauthGrants.revokedAt),
    ))
    .limit(1);
  if (!grant) return false;
  await getDb().transaction(async (tx) => revokeGrant(tx, grant.id));
  return true;
}

export async function introspectMcpAccessToken(
  token: string,
  callingApplicationId: string,
): Promise<McpAccessTokenClaims | null> {
  try {
    const signing = capabilityTicketSigningConfig();
    const untrusted = verifyMcpAccessTokenSignature(token, {
      resolvePublicKey: (keyId) => keyId === signing.keyId ? signing.publicKey : undefined,
    });
    const [row] = await getDb()
      .select({
        accessExpiresAt: mcpOauthAccessTokens.expiresAt,
        accessRevokedAt: mcpOauthAccessTokens.revokedAt,
        accessScopes: mcpOauthAccessTokens.scopes,
        grant: mcpOauthGrants,
        client: mcpOauthClients,
      })
      .from(mcpOauthAccessTokens)
      .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthAccessTokens.grantId))
      .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientRecordId))
      .where(eq(mcpOauthAccessTokens.jti, untrusted.jti))
      .limit(1);
    if (!row || row.accessRevokedAt || row.accessExpiresAt <= new Date()
      || row.grant.revokedAt || row.client.status !== 'active') return null;
    const descriptor = await resolveMcpResource(row.grant.resource);
    if (descriptor.registeredByApplicationId !== callingApplicationId
      || descriptor.appSlug !== row.grant.appSlug
      || descriptor.audience !== row.grant.audience
      || row.accessScopes.some((scope) => !descriptor.scopes.includes(scope))
      || !await currentAccountAuthority(row.grant)) return null;
    const claims = validateMcpAccessTokenClaims(untrusted, {
      issuer: (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, ''),
      audience: row.grant.audience,
      resource: row.grant.resource,
      accountId: row.grant.effectiveAccountId,
      maxTokenTtlSeconds: MCP_ACCESS_TOKEN_TTL_SECONDS,
      requiredScopes: row.accessScopes,
    });
    const claimScopes = normalizeMcpScopes(claims.scope);
    const storedScopes = normalizeMcpScopes(row.accessScopes);
    return claimScopes.length === storedScopes.length
      && claimScopes.every((scope, index) => scope === storedScopes[index])
      ? claims
      : null;
  } catch {
    return null;
  }
}
