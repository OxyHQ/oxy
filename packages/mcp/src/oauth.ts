import { z } from 'zod';

const mcpAccessTokenClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  resource: z.string().url(),
  client_id: z.string().min(1),
  scope: z.union([z.string(), z.array(z.string())]),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  account_id: z.string().min(1),
}).passthrough();

export type McpAccessTokenClaims = z.infer<typeof mcpAccessTokenClaimsSchema>;

export interface McpTokenValidationOptions {
  issuer: string;
  audience: string;
  resource: string;
  requiredScopes?: readonly string[];
  now?: Date;
}

export interface McpTokenVerifier extends McpTokenValidationOptions {
  verifySignature: (token: string) => Promise<unknown>;
}

function scopesOf(value: string | string[]): Set<string> {
  return new Set(Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean));
}

export function validateMcpAccessTokenClaims(
  untrustedClaims: unknown,
  options: McpTokenValidationOptions,
): McpAccessTokenClaims {
  const claims = mcpAccessTokenClaimsSchema.parse(untrustedClaims);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== options.issuer) throw new Error('MCP token issuer mismatch');
  if (!audiences.includes(options.audience)) throw new Error('MCP token audience mismatch');
  if (claims.resource !== options.resource) throw new Error('MCP token resource mismatch');
  if (claims.exp <= Math.floor((options.now ?? new Date()).getTime() / 1_000)) throw new Error('MCP token expired');
  const grantedScopes = scopesOf(claims.scope);
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
  return validateMcpAccessTokenClaims(verifiedClaims, options);
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
