import { introspectOxyMcpAccessToken } from '../introspection';

const claims = {
  active: true,
  iss: 'https://api.oxy.so',
  sub: 'user-1',
  aud: 'mention-api',
  resource: 'https://mcp.mention.earth',
  client_id: 'client-1',
  scope: 'social.read social.posts.publish',
  jti: 'token-1',
  iat: 1_788_256_800,
  nbf: 1_788_256_800,
  exp: 1_788_257_100,
  account_id: 'account-1',
};

describe('Oxy MCP access-token introspection', () => {
  it('returns strict claims for a live token without caching the result', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify(claims), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const options = {
      endpoint: 'https://api.oxy.so/auth/mcp/oauth/introspect',
      getServiceToken: async () => 'service-token',
      fetch: fetcher,
    };

    await expect(introspectOxyMcpAccessToken('access-token', options))
      .resolves.toMatchObject({ jti: 'token-1', account_id: 'account-1' });
    await introspectOxyMcpAccessToken('access-token', options);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer service-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: 'access-token' }),
    });
  });

  it('returns null only for an explicit inactive response', async () => {
    await expect(introspectOxyMcpAccessToken('access-token', {
      endpoint: 'https://api.oxy.so/auth/mcp/oauth/introspect',
      getServiceToken: async () => 'service-token',
      fetch: async () => new Response(JSON.stringify({ active: false }), { status: 200 }),
    })).resolves.toBeNull();
  });

  it('refreshes a rejected service token once, then returns live claims', async () => {
    const invalidateServiceToken = jest.fn();
    const getServiceToken = jest.fn()
      .mockResolvedValueOnce('stale-service-token')
      .mockResolvedValueOnce('fresh-service-token');
    const fetcher = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(claims), { status: 200 }));

    await expect(introspectOxyMcpAccessToken('access-token', {
      endpoint: 'https://api.oxy.so/auth/mcp/oauth/introspect',
      getServiceToken,
      invalidateServiceToken,
      fetch: fetcher,
    })).resolves.toMatchObject({ jti: 'token-1' });
    expect(invalidateServiceToken).toHaveBeenCalledTimes(1);
    expect(getServiceToken).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed success bodies and insecure endpoints', async () => {
    await expect(introspectOxyMcpAccessToken('access-token', {
      endpoint: 'https://api.oxy.so/auth/mcp/oauth/introspect',
      getServiceToken: async () => 'service-token',
      fetch: async () => new Response(JSON.stringify({ active: true }), { status: 200 }),
    })).rejects.toThrow();
    await expect(introspectOxyMcpAccessToken('access-token', {
      endpoint: 'http://api.oxy.so/auth/mcp/oauth/introspect',
      getServiceToken: async () => 'service-token',
    })).rejects.toThrow('must use HTTPS');
  });
});
