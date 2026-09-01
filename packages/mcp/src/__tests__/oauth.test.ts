import {
  createMcpAuthInfo,
  mcpPrincipalFromAuthInfo,
  validateMcpAccessTokenClaims,
  verifyMcpAccessToken,
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
      scopes: ['social.publish', 'social.read'],
      resource: 'https://mcp.mention.earth',
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    expect(() => mcpPrincipalFromAuthInfo({ ...authInfo, clientId: 'other-client' }, principalOptions))
      .toThrow('MCP client binding mismatch');
  });
});
