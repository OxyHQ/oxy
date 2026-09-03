import express, { type Request, type Response } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  mcpOAuthClientInfoResponseSchema,
  mcpOAuthConsentResponseSchema,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { mcpOauthClients, mcpOauthGrants } from '../db/schema/mcpOAuth';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import {
  McpOAuthError,
  authorizeMcpConnection,
  exchangeMcpAuthorizationCode,
  findActiveMcpClient,
  introspectMcpAccessToken,
  mcpClientApplication,
  mcpConsentDetails,
  mcpRedirectUriAllowed,
  normalizeMcpScopes,
  refreshMcpAccessToken,
  registerMcpClient,
  resolveMcpResource,
  revokeMcpGrant,
  revokeMcpToken,
  validateMcpRedirectUri,
} from '../services/mcpOAuth.service';
import { listActiveCapabilityCatalogs } from '../services/capabilityCatalog.service';
import { resolveLiveAgencyServicePrincipal } from '../services/agencyServicePrincipal.service';
import { logger } from '../utils/logger';

const router = express.Router();
export const mcpOAuthDiscoveryRouter = express.Router();

const issuer = (): string => (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
const authorizationEndpoint = (): string => new URL(
  '/authorize',
  process.env.OXY_AUTH_URL ?? 'https://auth.oxy.so',
).toString();

const registrationLimiter = rateLimit({
  prefix: 'rl:auth:mcp:register:',
  windowMs: 60 * 60 * 1_000,
  max: process.env.NODE_ENV === 'development' ? 100 : 20,
});
const publicReadLimiter = rateLimit({
  prefix: 'rl:auth:mcp:public-read:',
  windowMs: 60 * 1_000,
  max: process.env.NODE_ENV === 'development' ? 300 : 90,
});
const authorizeLimiter = rateLimit({
  prefix: 'rl:auth:mcp:authorize:',
  windowMs: 60 * 1_000,
  max: process.env.NODE_ENV === 'development' ? 100 : 20,
});
const tokenLimiter = rateLimit({
  prefix: 'rl:auth:mcp:token:',
  windowMs: 60 * 1_000,
  max: process.env.NODE_ENV === 'development' ? 200 : 60,
});
const introspectionLimiter = rateLimit({
  prefix: 'rl:auth:mcp:introspect:',
  windowMs: 60 * 1_000,
  max: process.env.NODE_ENV === 'development' ? 12_000 : 6_000,
  keyGenerator: (request) =>
    (request as ServiceAuthRequest).serviceApp?.appId ?? 'unknown',
});

const httpsUrl = z.string().trim().max(2_048).url().refine((value) => new URL(value).protocol === 'https:', {
  message: 'must use HTTPS',
});

const clientRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(120),
  redirect_uris: z.array(z.string().trim().min(1).max(2_048)).min(1).max(20),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token']))
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
  token_endpoint_auth_method: z.literal('none').default('none'),
  client_uri: httpsUrl.optional(),
  logo_uri: httpsUrl.optional(),
}).passthrough().superRefine((value, context) => {
  if (!value.grant_types.includes('authorization_code')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['grant_types'], message: 'authorization_code is required' });
  }
  if (new Set(value.redirect_uris).size !== value.redirect_uris.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['redirect_uris'], message: 'redirect_uris must be unique' });
  }
});

const clientParamsSchema = z.object({ clientId: z.string().trim().min(1) });
const clientQuerySchema = z.object({
  resource: z.string().trim().min(1),
  redirectUri: z.string().trim().min(1),
});
const consentQuerySchema = z.object({
  clientId: z.string().trim().min(1),
  redirectUri: z.string().trim().min(1),
  resource: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
});
const authorizeSchema = z.object({
  responseType: z.literal('code'),
  clientId: z.string().trim().min(1),
  redirectUri: z.string().trim().min(1),
  resource: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  codeChallengeMethod: z.literal('S256'),
  state: z.string().max(1_024).optional(),
}).strict();
const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    resource: z.string().min(1),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
    resource: z.string().min(1),
  }),
]);
const revokeSchema = z.object({ token: z.string().min(1), client_id: z.string().min(1) });
const introspectSchema = z.object({ token: z.string().min(1) }).strict();
const grantParamsSchema = z.object({ grantId: z.string().min(1) });

function identity(request: AuthRequest): { principalUserId: string; effectiveAccountId: string } {
  if (!request.oxyToken) throw new McpOAuthError('access_denied', 'A current Oxy session is required', 401);
  return {
    principalUserId: request.oxyToken.principalUserId,
    effectiveAccountId: request.oxyToken.subjectAccountId,
  };
}

function sendMcpOAuthError(response: Response, error: unknown): void {
  if (error instanceof McpOAuthError) {
    response.status(error.status).json({ error: error.code, error_description: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    const parameter = error.issues[0]?.path.join('.') || 'request';
    response.status(400).json({ error: 'invalid_request', error_description: `Invalid or missing parameter: ${parameter}` });
    return;
  }
  logger.error('MCP OAuth request failed', error instanceof Error ? error : new Error(String(error)), {
    component: 'mcp-oauth',
  });
  response.status(500).json({ error: 'server_error', error_description: 'The authorization server could not complete the request.' });
}

function parseForm(request: Request): Record<string, unknown> {
  if (!request.is('application/x-www-form-urlencoded')) {
    throw new McpOAuthError('invalid_request', 'The request must be application/x-www-form-urlencoded');
  }
  return typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
}

mcpOAuthDiscoveryRouter.get('/.well-known/oauth-authorization-server', publicReadLimiter, async (_request, response) => {
  try {
    const registrations = await listActiveCapabilityCatalogs();
    const scopes = [...new Set(registrations.flatMap((registration) => registration.catalog.tools
      .filter((tool) => registration.catalog.externalMcp && tool.exposure.includes('mcp'))
      .flatMap((tool) => tool.requiredCapabilities)))].sort();
    response.set('cache-control', 'public, max-age=300, must-revalidate');
    response.json({
      issuer: issuer(),
      authorization_endpoint: authorizationEndpoint(),
      token_endpoint: `${issuer()}/auth/mcp/oauth/token`,
      registration_endpoint: `${issuer()}/auth/mcp/oauth/register`,
      revocation_endpoint: `${issuer()}/auth/mcp/oauth/revoke`,
      jwks_uri: `${issuer()}/auth/mcp/oauth/jwks`,
      scopes_supported: scopes,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      resource_parameter_supported: true,
      client_id_metadata_document_supported: false,
    });
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.get('/jwks', publicReadLimiter, (_request, response) => {
  const signing = capabilityTicketSigningConfig();
  response.set('cache-control', 'public, max-age=300, must-revalidate');
  response.json({ keys: [signing.publicJwk] });
});

router.post('/register', registrationLimiter, async (request, response) => {
  try {
    const parsed = clientRegistrationSchema.safeParse(request.body);
    if (!parsed.success) throw new McpOAuthError('invalid_request', parsed.error.issues[0]?.message ?? 'Invalid client metadata');
    const redirectUris = parsed.data.redirect_uris.map(validateMcpRedirectUri);
    const client = await registerMcpClient({
      clientName: parsed.data.client_name,
      redirectUris,
      grantTypes: parsed.data.grant_types,
      clientUri: parsed.data.client_uri,
      logoUri: parsed.data.logo_uri,
    });
    response.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1_000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(client.clientUri ? { client_uri: client.clientUri } : {}),
      ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
    });
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.get('/client/:clientId', publicReadLimiter, async (request, response) => {
  try {
    const params = clientParamsSchema.parse(request.params);
    const query = clientQuerySchema.parse(request.query);
    const [client, descriptor] = await Promise.all([
      findActiveMcpClient(params.clientId),
      resolveMcpResource(query.resource),
    ]);
    if (!client) throw new McpOAuthError('invalid_client', 'MCP client is unknown or inactive', 404);
    if (!mcpRedirectUriAllowed(client, query.redirectUri)) {
      throw new McpOAuthError('invalid_request', 'redirect_uri is not registered for this client');
    }
    response.json(mcpOAuthClientInfoResponseSchema.parse({
      application: mcpClientApplication(client, descriptor.scopes),
    }));
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.get('/consent', publicReadLimiter, authMiddleware, async (request: AuthRequest, response) => {
  try {
    const query = consentQuerySchema.parse(request.query);
    const current = identity(request);
    if (query.accountId !== current.effectiveAccountId) {
      throw new McpOAuthError('access_denied', 'The selected account does not match the active session', 403);
    }
    const [client, descriptor] = await Promise.all([
      findActiveMcpClient(query.clientId),
      resolveMcpResource(query.resource),
    ]);
    if (!client) throw new McpOAuthError('invalid_client', 'MCP client is unknown or inactive', 404);
    if (!mcpRedirectUriAllowed(client, query.redirectUri)) {
      throw new McpOAuthError('invalid_request', 'redirect_uri is not registered for this client');
    }
    const scopes = normalizeMcpScopes(query.scope);
    response.json(mcpOAuthConsentResponseSchema.parse(await mcpConsentDetails({
      ...current,
      client,
      descriptor,
      scopes,
    })));
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.post('/authorize', authorizeLimiter, authMiddleware, async (request: AuthRequest, response) => {
  try {
    const body = authorizeSchema.parse(request.body);
    const current = identity(request);
    if (body.accountId !== current.effectiveAccountId) {
      throw new McpOAuthError('access_denied', 'The selected account does not match the active session', 403);
    }
    const [client, descriptor] = await Promise.all([
      findActiveMcpClient(body.clientId),
      resolveMcpResource(body.resource),
    ]);
    if (!client) throw new McpOAuthError('invalid_client', 'MCP client is unknown or inactive', 404);
    const issued = await authorizeMcpConnection({
      ...current,
      client,
      descriptor,
      redirectUri: body.redirectUri,
      codeChallenge: body.codeChallenge,
      scopes: normalizeMcpScopes(body.scope),
    });
    response.json({ code: issued.code, expires_in: issued.expiresIn, ...(body.state ? { state: body.state } : {}) });
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.post('/token', tokenLimiter, async (request, response) => {
  try {
    const parsed = tokenRequestSchema.safeParse(parseForm(request));
    if (!parsed.success) {
      const unsupported = typeof request.body === 'object' && request.body !== null
        && (request.body as Record<string, unknown>).grant_type !== 'authorization_code'
        && (request.body as Record<string, unknown>).grant_type !== 'refresh_token';
      throw new McpOAuthError(
        unsupported ? 'unsupported_grant_type' : 'invalid_request',
        parsed.error.issues[0]?.message ?? 'Invalid token request',
      );
    }
    const result = parsed.data.grant_type === 'authorization_code'
      ? await exchangeMcpAuthorizationCode({
          code: parsed.data.code,
          clientId: parsed.data.client_id,
          redirectUri: parsed.data.redirect_uri,
          codeVerifier: parsed.data.code_verifier,
          resource: parsed.data.resource,
        })
      : await refreshMcpAccessToken({
          refreshToken: parsed.data.refresh_token,
          clientId: parsed.data.client_id,
          resource: parsed.data.resource,
        });
    response.set('cache-control', 'no-store');
    response.set('pragma', 'no-cache');
    response.json(result);
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.post('/revoke', tokenLimiter, async (request, response) => {
  try {
    const body = revokeSchema.parse(parseForm(request));
    await revokeMcpToken(body.token, body.client_id);
    response.status(200).end();
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.post('/introspect', serviceAuthMiddleware, introspectionLimiter, async (request: ServiceAuthRequest, response) => {
  try {
    if (!request.serviceApp) throw new McpOAuthError('invalid_client', 'A live Oxy service credential is required', 401);
    const principal = await resolveLiveAgencyServicePrincipal(request.serviceApp);
    if (!principal) throw new McpOAuthError('invalid_client', 'The Oxy service credential is inactive', 401);
    const body = introspectSchema.parse(request.body);
    const claims = await introspectMcpAccessToken(body.token, principal.applicationId);
    response.json(claims ? { active: true, ...claims } : { active: false });
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.get('/grants', publicReadLimiter, authMiddleware, async (request: AuthRequest, response) => {
  try {
    const current = identity(request);
    const grants = await getDb().select({
      id: mcpOauthGrants.id,
      appSlug: mcpOauthGrants.appSlug,
      resource: mcpOauthGrants.resource,
      scopes: mcpOauthGrants.scopes,
      clientId: mcpOauthClients.clientId,
      clientName: mcpOauthClients.clientName,
      createdAt: mcpOauthGrants.createdAt,
      lastUsedAt: mcpOauthGrants.lastUsedAt,
    }).from(mcpOauthGrants)
      .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientRecordId))
      .where(and(
        eq(mcpOauthGrants.principalUserId, current.principalUserId),
        eq(mcpOauthGrants.effectiveAccountId, current.effectiveAccountId),
        isNull(mcpOauthGrants.revokedAt),
      ))
      .orderBy(desc(mcpOauthGrants.lastUsedAt));
    response.json({ grants });
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

router.delete('/grants/:grantId', authorizeLimiter, authMiddleware, async (request: AuthRequest, response) => {
  try {
    const params = grantParamsSchema.parse(request.params);
    const current = identity(request);
    await revokeMcpGrant({ grantId: params.grantId, ...current });
    response.status(204).end();
  } catch (error) {
    sendMcpOAuthError(response, error);
  }
});

export default router;
