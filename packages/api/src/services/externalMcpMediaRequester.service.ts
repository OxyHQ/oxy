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
  readonly tool:
    | 'upload-media'
    | 'upload-media-from-url'
    | 'uploadLeaseDocument'
    | 'submitApplication'
    | 'addApplicationDocuments';
  readonly privateDocument?: true;
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
    typeof toolName !== 'string' ||
    ![
      'upload-media',
      'upload-media-from-url',
      'uploadLeaseDocument',
      'submitApplication',
      'addApplicationDocuments',
    ].includes(toolName) ||
    [
      'x-oxy-requester-token',
      'x-oxy-task-id',
      'x-oxy-capability-ticket',
      'x-oxy-requester-context',
    ].some((name) => req.headers[name] !== undefined)
  )
    throw deny();
  // This is deliberately not a generic requester proof. A token granting Mention
  // media creation never becomes a Files grant, private graph reader or session.
  const privateDocument = [
    'uploadLeaseDocument',
    'submitApplication',
    'addApplicationDocuments',
  ].includes(toolName);
  if (privateDocument && presenter.applicationId !== '6a2f851751b784a86fd0e922') throw deny();
  const allowedPath =
    req.baseUrl.endsWith('/assets') &&
    (privateDocument
      ? (req.method === 'POST' && req.path === '/service/user-media/uploads') ||
        (req.method === 'GET' && /^\/service\/user-media\/uploads\/[^/]+$/.test(req.path)) ||
        (req.method === 'POST' &&
          /^\/service\/user-media\/uploads\/[^/]+\/(parts|complete)$/.test(req.path))
      : toolName === 'upload-media'
        ? req.method === 'POST' && req.path === '/service/user-media'
        : (req.method === 'POST' && req.path === '/service/user-media/import') ||
          (req.method === 'GET' && /^\/service\/user-media\/imports\/[^/]+$/.test(req.path)));
  if (!allowedPath) throw deny();
  const resolved = await resolveLiveMcpAccessToken(token, presenter.applicationId);
  if (!resolved) throw deny();
  const tool = resolved.descriptor.tools.find((entry) => entry.name === toolName);
  const scopes = normalizeMcpScopes(resolved.claims.scope);
  if (
    tool?.effect !== 'write' ||
    !tool.resourceTypes.includes(privateDocument ? 'homiio_account' : 'media') ||
    tool.invocation?.method !== 'POST' ||
    !tool.requiredCapabilities.includes(
      privateDocument
        ? toolName === 'uploadLeaseDocument'
          ? 'housing.leases.manage'
          : 'housing.applications.submit'
        : 'social.media.create',
    ) ||
    (privateDocument && tool.invocation.path !== `/_oxy/capabilities/${toolName}`) ||
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
    tool: toolName as ExternalMcpMediaOperation['tool'],
    ...(privateDocument ? { privateDocument: true as const } : {}),
    scopes,
    expiresAt: new Date(resolved.claims.exp * 1000),
  };
}

/** Recheck persisted upload constraints on every continuation, not only admission. */
export function assertExternalDocumentUpload(
  operation: ExternalMcpMediaOperation | undefined,
  upload: { size: number; mime: string; visibility?: string; reference?: unknown },
): void {
  if (!operation?.privateDocument) return;
  if (
    upload.visibility !== 'private' ||
    upload.size <= 0 ||
    upload.size > 10 * 1024 * 1024 ||
    ![
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
    ].includes(upload.mime) ||
    upload.reference != null
  )
    throw new ForbiddenError(
      'The external housing action permits only a private document up to 10 MiB.',
    );
}

const DOCUMENT_AUTHORITY_KEY = '_oxy_mcp_document_authority';
function documentAuthority(operation: ExternalMcpMediaOperation) {
  return {
    originGrantId: operation.originGrantId,
    activeGrantId: operation.activeGrantId,
    clientId: operation.clientId,
    receiverApplicationId: operation.receiverApplicationId,
    accountId: operation.effectiveAccountId,
    tool: operation.tool,
  };
}

/** Caller metadata cannot manufacture upload provenance. No credential is persisted. */
export function externalDocumentMetadata(
  operation: ExternalMcpMediaOperation | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const clean = { ...metadata };
  delete clean[DOCUMENT_AUTHORITY_KEY];
  if (operation?.privateDocument) clean[DOCUMENT_AUTHORITY_KEY] = documentAuthority(operation);
  return Object.keys(clean).length ? clean : undefined;
}

export function assertExternalDocumentContinuation(
  operation: ExternalMcpMediaOperation | undefined,
  upload: {
    size: number;
    mime: string;
    visibility?: string;
    reference?: unknown;
    metadata?: Record<string, unknown> | null;
  },
): void {
  if (!operation?.privateDocument) return;
  assertExternalDocumentUpload(operation, upload);
  const provenance = upload.metadata?.[DOCUMENT_AUTHORITY_KEY];
  const expected = documentAuthority(operation);
  if (
    !provenance ||
    typeof provenance !== 'object' ||
    Object.entries(expected).some(
      ([key, value]) => (provenance as Record<string, unknown>)[key] !== value,
    )
  )
    throw new ForbiddenError('This upload belongs to another external operation.');
}
