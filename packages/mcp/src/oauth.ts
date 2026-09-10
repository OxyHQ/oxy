import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';

const MCP_ACCESS_TOKEN_ALGORITHM = 'EdDSA';
const MCP_ACCESS_TOKEN_TYPE = 'at+jwt';
const MAX_ISSUED_TOKEN_TTL_SECONDS = 3_600;

export const mcpAccessTokenClaimsSchema = z.object({
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

/**
 * The account set one MCP connection may act as.
 *
 * A token is minted for ONE account — its `account_id`, and that binding is
 * cryptographic and never widened. A CONNECTION is the thing the person holds
 * in their assistant, and Oxy lets them add further accounts to it by approving
 * a single-use link while signed in as each one. Oxy reports the resulting set,
 * and which member the connector is currently acting as, on introspection; a
 * resource server serves `active_account_id`, not `account_id`.
 *
 * Absent on a connection that was never widened — treat that as the token's own
 * account being the only member.
 */
export const mcpConnectionStateSchema = z.object({
  connection_id: z.string().trim().min(1),
  origin_account_id: z.string().trim().min(1),
  active_account_id: z.string().trim().min(1),
  accounts: z.array(z.object({
    account_id: z.string().trim().min(1),
    is_origin: z.boolean(),
    linked_at: z.string().trim().min(1),
  })).default([]),
});

export type McpConnectionState = z.infer<typeof mcpConnectionStateSchema>;

/**
 * Read the connection state off an introspection response or token claims.
 *
 * Returns null for anything that is not a well-formed connection block, so an
 * older authority that does not report one degrades to the single-account
 * behaviour instead of failing the request.
 */
export function mcpConnectionStateFrom(value: unknown): McpConnectionState | null {
  if (typeof value !== 'object' || value === null) return null;
  const parsed = mcpConnectionStateSchema.safeParse(
    (value as Record<string, unknown>).connection,
  );
  if (!parsed.success) return null;
  return parsed.data.accounts.some((account) => account.account_id === parsed.data.active_account_id)
    ? parsed.data
    : null;
}

export interface McpAccessTokenSigningOptions {
  privateKey: KeyObject;
  keyId: string;
  issuer: string;
  ttlSeconds?: number;
  now?: Date;
  jti?: string;
}

export interface McpAccessTokenSignatureVerificationOptions {
  resolvePublicKey: (keyId: string) => KeyObject | undefined;
}

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
  /** The account the token itself is bound to — the connection's origin. */
  readonly accountId: string;
  /**
   * The account this request must act as: the connection's selected member, or
   * `accountId` when the connection was never widened. Serve THIS one.
   */
  readonly activeAccountId: string;
  readonly connection: McpConnectionState | null;
  readonly scopes: readonly string[];
  readonly resource: string;
}

function scopesOf(value: string | string[]): string[] {
  return [...new Set(Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean))].sort();
}

function base64UrlEncode(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('MCP access token contains invalid base64url');
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) {
    throw new Error('MCP access token contains non-canonical base64url');
  }
  return decoded;
}

function decodeJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(decodeBase64Url(segment).toString('utf8')) as unknown;
  } catch {
    throw new Error('MCP access token is not valid base64url JSON');
  }
}

/** Mint a short-lived, resource-bound MCP access token under Oxy's Ed25519 key. */
export function issueMcpAccessToken(
  claims: Omit<McpAccessTokenClaims, 'iss' | 'iat' | 'nbf' | 'exp' | 'jti'>,
  options: McpAccessTokenSigningOptions,
): { token: string; claims: McpAccessTokenClaims } {
  const ttlSeconds = options.ttlSeconds ?? 900;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_ISSUED_TOKEN_TTL_SECONDS) {
    throw new Error(`MCP access token TTL must be between 1 and ${MAX_ISSUED_TOKEN_TTL_SECONDS} seconds`);
  }
  if (options.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('MCP access tokens require an Ed25519 private key');
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.keyId)) {
    throw new Error('MCP access token key id must be URL-safe');
  }

  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const signedClaims = mcpAccessTokenClaimsSchema.parse({
    ...claims,
    iss: options.issuer,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: options.jti ?? randomUUID(),
  });
  const header = {
    alg: MCP_ACCESS_TOKEN_ALGORITHM,
    typ: MCP_ACCESS_TOKEN_TYPE,
    kid: options.keyId,
  } as const;
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(signedClaims))}`;
  const signature = signBytes(null, Buffer.from(signingInput), options.privateKey);
  return { token: `${signingInput}.${base64UrlEncode(signature)}`, claims: signedClaims };
}

/** Verify the compact JWS envelope and return structurally valid claims. */
export function verifyMcpAccessTokenSignature(
  token: string,
  options: McpAccessTokenSignatureVerificationOptions,
): McpAccessTokenClaims {
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error('MCP access token must have three non-empty segments');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  const header = z.object({
    alg: z.literal(MCP_ACCESS_TOKEN_ALGORITHM),
    typ: z.literal(MCP_ACCESS_TOKEN_TYPE),
    kid: z.string().min(1),
  }).strict().parse(decodeJsonSegment(encodedHeader));
  const publicKey = options.resolvePublicKey(header.kid);
  if (!publicKey || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('MCP access token signing key is not trusted');
  }

  const valid = verifyBytes(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    decodeBase64Url(encodedSignature),
  );
  if (!valid) throw new Error('MCP access token signature is invalid');
  return mcpAccessTokenClaimsSchema.parse(decodeJsonSegment(encodedPayload));
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

  const connection = mcpConnectionStateFrom(claims);
  // A connection block that disagrees with the token's own account belongs to
  // another connection: ignore it rather than acting as an account this token
  // was never introspected for.
  const usableConnection = connection && connection.origin_account_id === claims.account_id
    ? connection
    : null;

  return Object.freeze({
    subject: claims.sub,
    clientId: claims.client_id,
    accountId: claims.account_id,
    activeAccountId: usableConnection?.active_account_id ?? claims.account_id,
    connection: usableConnection,
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
