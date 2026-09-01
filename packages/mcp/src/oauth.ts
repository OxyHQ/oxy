import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';

const mcpAccessTokenClaimsSchema = z.object({
  iss: z.url(),
  sub: z.string().trim().min(1),
  aud: z.string().trim().min(1),
  resource: z.url(),
  client_id: z.string().trim().min(1),
  scope: z.union([
    z.string().trim().min(1),
    z.array(z.string().trim().min(1)).min(1),
  ]),
  jti: z.string().trim().min(1),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative().optional(),
  exp: z.number().int().positive(),
  account_id: z.string().trim().min(1),
}).passthrough();

const AUTH_INFO_CLAIMS_KEY = 'oxy.accessTokenClaims';

export type McpAccessTokenClaims = z.infer<typeof mcpAccessTokenClaimsSchema>;

export interface McpTokenValidationOptions {
  issuer: string;
  audience: string;
  resource: string;
  accountId: string;
  maxTokenTtlSeconds: number;
  requiredScopes?: readonly string[];
  clockToleranceSeconds?: number;
  now?: Date;
}

export interface McpTokenStatusContext {
  token: string;
  claims: McpAccessTokenClaims;
}

export interface McpTokenVerifier extends McpTokenValidationOptions {
  verifySignature: (token: string) => Promise<unknown>;
  /** Performs live introspection or a revocation-list lookup for this jti. */
  validateTokenStatus: (context: McpTokenStatusContext) => Promise<boolean>;
}

export interface McpPrincipal {
  readonly subject: string;
  readonly clientId: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
}

function scopesOf(value: string | string[]): string[] {
  return [...new Set(Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean))].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nowSeconds(options: Pick<McpTokenValidationOptions, 'now'>): number {
  return Math.floor((options.now ?? new Date()).getTime() / 1_000);
}

export function validateMcpAccessTokenClaims(
  untrustedClaims: unknown,
  options: McpTokenValidationOptions,
): McpAccessTokenClaims {
  const claims = mcpAccessTokenClaimsSchema.parse(untrustedClaims);
  const now = nowSeconds(options);
  const tolerance = options.clockToleranceSeconds ?? 30;

  if (!Number.isInteger(options.maxTokenTtlSeconds) || options.maxTokenTtlSeconds <= 0) {
    throw new Error('MCP maximum token TTL must be a positive integer');
  }
  if (!Number.isInteger(tolerance) || tolerance < 0) {
    throw new Error('MCP clock tolerance must be a non-negative integer');
  }
  if (claims.iss !== options.issuer) throw new Error('MCP token issuer mismatch');
  if (claims.aud !== options.audience) throw new Error('MCP token audience mismatch');
  if (claims.resource !== options.resource) throw new Error('MCP token resource mismatch');
  if (claims.account_id !== options.accountId) throw new Error('MCP token account mismatch');
  if (claims.exp <= claims.iat) throw new Error('MCP token expiry must be after issuance');
  if (claims.exp - claims.iat > options.maxTokenTtlSeconds) throw new Error('MCP token TTL exceeds policy');
  if (claims.iat > now + tolerance) throw new Error('MCP token issued in the future');
  if (claims.nbf !== undefined && claims.nbf > now + tolerance) throw new Error('MCP token is not active yet');
  if (claims.exp <= now - tolerance) throw new Error('MCP token expired');

  const grantedScopes = new Set(scopesOf(claims.scope));
  for (const scope of options.requiredScopes ?? []) {
    if (!grantedScopes.has(scope)) throw new Error(`MCP token is missing scope ${scope}`);
  }
  return claims;
}

export async function verifyMcpAccessToken(
  token: string,
  options: McpTokenVerifier,
): Promise<McpAccessTokenClaims> {
  const verifiedClaims = await options.verifySignature(token);
  const claims = validateMcpAccessTokenClaims(verifiedClaims, options);
  if (!await options.validateTokenStatus({ token, claims })) {
    throw new Error('MCP token is inactive or revoked');
  }
  return claims;
}

export function createMcpAuthInfo(token: string, claims: McpAccessTokenClaims): AuthInfo {
  return {
    token,
    clientId: claims.client_id,
    scopes: scopesOf(claims.scope),
    expiresAt: claims.exp,
    resource: new URL(claims.resource),
    extra: { [AUTH_INFO_CLAIMS_KEY]: claims },
  };
}

export function mcpPrincipalFromAuthInfo(
  authInfo: AuthInfo | undefined,
  options: Omit<McpTokenValidationOptions, 'accountId'>,
): McpPrincipal {
  if (!authInfo) throw new Error('MCP authentication is required');

  const untrustedClaims = authInfo.extra?.[AUTH_INFO_CLAIMS_KEY];
  const parsedClaims = mcpAccessTokenClaimsSchema.parse(untrustedClaims);
  const claims = validateMcpAccessTokenClaims(untrustedClaims, {
    ...options,
    accountId: parsedClaims.account_id,
  });
  const authScopes = [...new Set(authInfo.scopes)].sort();
  const claimScopes = scopesOf(claims.scope);
  if (authInfo.clientId !== claims.client_id) throw new Error('MCP client binding mismatch');
  if (!sameStrings(authScopes, claimScopes)) throw new Error('MCP scope binding mismatch');
  if (authInfo.expiresAt !== claims.exp) throw new Error('MCP expiry binding mismatch');
  if (authInfo.resource?.href !== new URL(claims.resource).href) {
    throw new Error('MCP resource binding mismatch');
  }

  return Object.freeze({
    subject: claims.sub,
    clientId: claims.client_id,
    accountId: claims.account_id,
    scopes: Object.freeze(claimScopes),
    resource: claims.resource,
  });
}

export function buildProtectedResourceMetadata(input: {
  resource: string;
  authorizationServer: string;
  scopes: readonly string[];
}): Record<string, unknown> {
  return {
    resource: input.resource,
    authorization_servers: [input.authorizationServer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...input.scopes],
  };
}
