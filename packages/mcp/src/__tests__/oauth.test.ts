import { generateKeyPairSync } from 'node:crypto';
import {
  createMcpAuthInfo,
  issueMcpAccessToken,
  mcpPrincipalFromAuthInfo,
  validateMcpAccessTokenClaims,
  verifyMcpAccessToken,
  verifyMcpAccessTokenSignature,
} from '../oauth';

const claims = {
  iss: 'https://accounts.oxy.so',
  sub: 'user-1',
  aud: 'mention-mcp',
  resource: 'https://mcp.mention.earth',
  client_id: 'client-1',
  scope: 'social.read social.publish',
  jti: 'token-1',
  iat: 1_788_256_800,
  nbf: 1_788_256_800,
  exp: 1_788_257_100,
  account_id: 'account-1',
};

const options = {
  issuer: claims.iss,
  audience: claims.aud,
  resource: claims.resource,
  accountId: claims.account_id,
  maxTokenTtlSeconds: 600,
  requiredScopes: ['social.publish'],
  now: new Date('2026-09-01T10:00:00.000Z'),
};

describe('MCP OAuth validation', () => {
  it('issues and verifies a distinct Ed25519 access-token profile', () => {
    const keyPair = generateKeyPairSync('ed25519');
    const issued = issueMcpAccessToken({
      sub: claims.sub,
      aud: claims.aud,
      resource: claims.resource,
      client_id: claims.client_id,
      scope: claims.scope,
      account_id: claims.account_id,
    }, {
      privateKey: keyPair.privateKey,
      keyId: 'mcp-test-key',
      issuer: claims.iss,
      ttlSeconds: 300,
      now: options.now,
      jti: claims.jti,
    });

    expect(issued.claims).toMatchObject(claims);
    expect(verifyMcpAccessTokenSignature(issued.token, {
      resolvePublicKey: (keyId) => keyId === 'mcp-test-key' ? keyPair.publicKey : undefined,
    })).toEqual(issued.claims);
    const [header, payload, encodedSignature] = issued.token.split('.');
    const invalidSignature = Buffer.from(encodedSignature, 'base64url');
    invalidSignature[0] ^= 0x01;
    expect(() => verifyMcpAccessTokenSignature(`${header}.${payload}.${invalidSignature.toString('base64url')}`, {
      resolvePublicKey: () => keyPair.publicKey,
    })).toThrow('signature is invalid');
    expect(() => verifyMcpAccessTokenSignature(`${header}.${payload}.invalid+base64`, {
      resolvePublicKey: () => keyPair.publicKey,
    })).toThrow('invalid base64url');
  });

  it('accepts only the exact issuer, audience, resource, account and scope', () => {
    expect(validateMcpAccessTokenClaims(claims, options).jti).toBe('token-1');
    expect(() => validateMcpAccessTokenClaims(claims, {
      ...options,
      audience: 'noted-mcp',
    })).toThrow('MCP token audience mismatch');
    expect(() => validateMcpAccessTokenClaims(claims, {
      ...options,
      resource: 'https://mcp.noted.oxy.so',
    })).toThrow('MCP token resource mismatch');
    expect(() => validateMcpAccessTokenClaims(claims, {
      ...options,
      accountId: 'account-2',
    })).toThrow('MCP token account mismatch');
    expect(() => validateMcpAccessTokenClaims(claims, {
      ...options,
      requiredScopes: ['social.moderate'],
    })).toThrow('MCP token is missing scope social.moderate');
  });

  it('rejects invalid time windows and excessive token lifetimes', () => {
    expect(() => validateMcpAccessTokenClaims({ ...claims, exp: claims.iat + 601 }, options))
      .toThrow('MCP token TTL exceeds policy');
    expect(() => validateMcpAccessTokenClaims({ ...claims, nbf: claims.iat + 90 }, options))
      .toThrow('MCP token is not active yet');
    expect(() => validateMcpAccessTokenClaims({ ...claims, exp: claims.iat }, options))
      .toThrow('MCP token expiry must be after issuance');
  });

  it('requires a live jti status check after signature verification', async () => {
    const validateTokenStatus = jest.fn(async () => false);
    await expect(verifyMcpAccessToken('signed-token', {
      ...options,
      verifySignature: async () => claims,
      validateTokenStatus,
    })).rejects.toThrow('MCP token is inactive or revoked');
    expect(validateTokenStatus).toHaveBeenCalledWith({ token: 'signed-token', claims });
  });

  it('binds SDK authInfo fields to the signed claims and freezes the principal', () => {
    const authInfo = createMcpAuthInfo('signed-token', claims);
    const principalOptions = {
      issuer: options.issuer,
      audience: options.audience,
      resource: options.resource,
      maxTokenTtlSeconds: options.maxTokenTtlSeconds,
      now: options.now,
    };
    const principal = mcpPrincipalFromAuthInfo(authInfo, principalOptions);
    expect(principal).toEqual({
      subject: 'user-1',
      clientId: 'client-1',
      accountId: 'account-1',
      // No connection block on the claims: the token's own account is the one
      // to act as, and there is nothing else the connection could name.
      activeAccountId: 'account-1',
      connection: null,
      scopes: ['social.publish', 'social.read'],
      resource: 'https://mcp.mention.earth',
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    expect(() => mcpPrincipalFromAuthInfo({ ...authInfo, clientId: 'other-client' }, principalOptions))
      .toThrow('MCP client binding mismatch');
  });
  it('acts as the connection member Oxy selected, not the token account', () => {
    const connected = {
      ...claims,
      connection: {
        connection_id: 'connection-1',
        origin_account_id: 'account-1',
        active_account_id: 'account-2',
        accounts: [
          { account_id: 'account-1', is_origin: true, linked_at: '2026-01-01T00:00:00.000Z' },
          { account_id: 'account-2', is_origin: false, linked_at: '2026-02-01T00:00:00.000Z' },
        ],
      },
    };
    const principalOptions = {
      issuer: options.issuer,
      audience: options.audience,
      resource: options.resource,
      maxTokenTtlSeconds: options.maxTokenTtlSeconds,
      now: options.now,
    };
    const principal = mcpPrincipalFromAuthInfo(
      createMcpAuthInfo('signed-token', connected),
      principalOptions,
    );
    expect(principal.accountId).toBe('account-1');
    expect(principal.activeAccountId).toBe('account-2');
    expect(principal.connection?.accounts).toHaveLength(2);
  });

  it('ignores a connection block that belongs to another connection', () => {
    const foreign = {
      ...claims,
      connection: {
        connection_id: 'connection-9',
        origin_account_id: 'account-9',
        active_account_id: 'account-9',
        accounts: [{ account_id: 'account-9', is_origin: true, linked_at: '2026-01-01T00:00:00.000Z' }],
      },
    };
    const principal = mcpPrincipalFromAuthInfo(createMcpAuthInfo('signed-token', foreign), {
      issuer: options.issuer,
      audience: options.audience,
      resource: options.resource,
      maxTokenTtlSeconds: options.maxTokenTtlSeconds,
      now: options.now,
    });
    expect(principal.activeAccountId).toBe('account-1');
    expect(principal.connection).toBeNull();
  });
});
