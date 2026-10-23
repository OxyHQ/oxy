/** Existing external MCP media permission, forwarded by its registered resource server. */
import type { Request } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { mcpOauthConnectionAccounts, mcpOauthGrants } from '../db/schema/mcpOAuth';
import { ForbiddenError } from '../utils/error';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import {
  resolveLiveMcpAccessToken,
  grantAccountAuthorityHolds,
  normalizeMcpScopes,
} from './mcpOAuth.service';
import { resolveMcpConnectionState } from './mcpConnection.service';

export interface ExternalMcpMediaOperation {
  readonly authority: 'external';
  readonly requesterAccountId: string;
  readonly effectiveAccountId: string;
  readonly originGrantId: string;
  readonly activeGrantId: string;
  readonly clientId: string;
  readonly receiverApplicationId: string;
  readonly resource: string;
  readonly tool: 'upload-media' | 'upload-media-from-url';
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}
export function hasExternalMcpMediaProof(headers: Request['headers']): boolean {
  return (
    headers['x-oxy-mcp-media-token'] !== undefined || headers['x-oxy-mcp-media-tool'] !== undefined
  );
}

export async function resolveExternalMcpMediaRequest(
  presenter: LiveAgencyServicePrincipal,
  req: Pick<Request, 'headers' | 'method' | 'baseUrl' | 'path'>,
): Promise<ExternalMcpMediaOperation> {
  const deny = () =>
    new ForbiddenError('The external MCP grant does not authorize this media operation.');
  const token = req.headers['x-oxy-mcp-media-token'];
  const toolName = req.headers['x-oxy-mcp-media-tool'];
  if (
    presenter.authority !== 'first_party' ||
    typeof token !== 'string' ||
    !token ||
    token.length > 16384 ||
    (toolName !== 'upload-media' && toolName !== 'upload-media-from-url') ||
    ['x-oxy-requester-token', 'x-oxy-task-id', 'x-oxy-capability-ticket'].some(
      (name) => req.headers[name] !== undefined,
    )
  )
    throw deny();
  // This is deliberately not a generic requester proof. A token granting Mention
  // media creation never becomes a Files grant, private graph reader or session.
  const allowedPath =
    req.baseUrl.endsWith('/assets') &&
    (toolName === 'upload-media'
      ? req.method === 'POST' && req.path === '/service/user-media'
      : (req.method === 'POST' && req.path === '/service/user-media/import') ||
        (req.method === 'GET' && /^\/service\/user-media\/imports\/[^/]+$/.test(req.path)));
  if (!allowedPath) throw deny();
  const resolved = await resolveLiveMcpAccessToken(token, presenter.applicationId);
  if (!resolved) throw deny();
  const tool = resolved.descriptor.tools.find((entry) => entry.name === toolName);
  const scopes = normalizeMcpScopes(resolved.claims.scope);
  if (
    !tool ||
    tool.effect !== 'write' ||
    !tool.resourceTypes.includes('media') ||
    tool.invocation?.method !== 'POST' ||
    !tool.requiredCapabilities.includes('social.media.create') ||
    tool.requiredCapabilities.some(
      (scope) => !scopes.includes(scope) || !resolved.grant.scopes.includes(scope),
    )
  )
    throw deny();
  const connection = await resolveMcpConnectionState(resolved.grant);
  const [member] = await getDb()
    .select({ grant: mcpOauthGrants })
    .from(mcpOauthConnectionAccounts)
    .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthConnectionAccounts.grantId))
    .where(
      and(
        eq(mcpOauthConnectionAccounts.connectionId, connection.connection_id),
        eq(mcpOauthConnectionAccounts.accountId, connection.active_account_id),
        isNull(mcpOauthConnectionAccounts.revokedAt),
        isNull(mcpOauthGrants.revokedAt),
      ),
    )
    .limit(1);
  if (
    !member ||
    member.grant.clientRecordId !== resolved.client.id ||
    member.grant.resource !== resolved.grant.resource ||
    member.grant.audience !== resolved.grant.audience ||
    !(await grantAccountAuthorityHolds(member.grant)) ||
    tool.requiredCapabilities.some((scope) => !member.grant.scopes.includes(scope)) ||
    req.headers['x-owner-user-id'] !== connection.active_account_id ||
    (req.headers['x-oxy-user-id'] !== undefined &&
      req.headers['x-oxy-user-id'] !== connection.active_account_id)
  )
    throw deny();
  return {
    authority: 'external',
    requesterAccountId: member.grant.principalUserId,
    effectiveAccountId: connection.active_account_id,
    originGrantId: resolved.grant.id,
    activeGrantId: member.grant.id,
    clientId: resolved.client.clientId,
    receiverApplicationId: presenter.applicationId,
    resource: resolved.grant.resource,
    tool: toolName,
    scopes,
    expiresAt: new Date(resolved.claims.exp * 1000),
  };
}
