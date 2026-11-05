import { test, expect, describe } from 'bun:test';
import type { FetchFn } from '../client';
import { createShipClient } from '../config';
import {
  createGithubOidcTokenProvider,
  githubOidcEnvironment,
  GITHUB_ACTIONS_EXCHANGE_PATH,
  oxyAudience,
} from '../githubOidc';

const REQUEST_URL = 'https://pipelines.actions.githubusercontent.com/oidc/token?api-version=2.0';
const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-secret',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A GitHub + Oxy pair: each ID token request and each exchange is recorded. */
function fakeNetwork(options: { expiresIn?: number; exchangeStatus?: number } = {}) {
  const calls: Call[] = [];
  let minted = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    if (url.startsWith('https://pipelines.actions.githubusercontent.com/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ value: `github-jwt-${calls.length}` }),
      };
    }
    if (url.endsWith(GITHUB_ACTIONS_EXCHANGE_PATH)) {
      const status = options.exchangeStatus ?? 200;
      if (status !== 200) {
        return {
          ok: false,
          status,
          text: async () =>
            JSON.stringify({ error: 'Forbidden', details: { reason: 'no_trusted_publisher' } }),
        };
      }
      minted += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              token: `oxy-token-${minted}`,
              expiresIn: options.expiresIn ?? 300,
              appName: 'Demo',
            },
          }),
      };
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, fetchFn };
}

describe('githubOidcEnvironment', () => {
  test('reads both request variables', () => {
    expect(githubOidcEnvironment(ENV)).toEqual({
      requestUrl: REQUEST_URL,
      requestToken: 'runner-secret',
    });
  });
  test('is null outside a job allowed to request an ID token', () => {
    expect(githubOidcEnvironment({})).toBeNull();
    expect(githubOidcEnvironment({ ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL })).toBeNull();
  });
});

describe('the GitHub OIDC token provider', () => {
  test('asks GitHub for a token addressed to the API origin, then exchanges it with the client id', async () => {
    const { calls, fetchFn } = fakeNetwork();
    const getToken = createGithubOidcTokenProvider({
      baseURL: 'https://api.oxy.so/',
      clientId: 'oxy_dk_demo',
      environment: githubOidcEnvironment(ENV) ?? { requestUrl: '', requestToken: '' },
      fetchFn,
    });
    expect(await getToken()).toBe('oxy-token-1');

    const [idRequest, exchange] = calls;
    const url = new URL(idRequest.url);
    expect(url.searchParams.get('audience')).toBe('https://api.oxy.so');
    expect(url.searchParams.get('api-version')).toBe('2.0');
    expect(idRequest.headers.authorization).toBe('bearer runner-secret');

    expect(exchange.url).toBe('https://api.oxy.so/auth/service-token/github-actions');
    expect(exchange.method).toBe('POST');
    expect(JSON.parse(exchange.body ?? '{}')).toEqual({
      clientId: 'oxy_dk_demo',
      token: 'github-jwt-1',
    });
    // The runner's request token never leaves for Oxy.
    expect(JSON.stringify(exchange)).not.toContain('runner-secret');
  });

  test('reuses the Oxy token until a minute before it expires, then mints a fresh one', async () => {
    const { calls, fetchFn } = fakeNetwork({ expiresIn: 300 });
    let clock = 1_000_000;
    const getToken = createGithubOidcTokenProvider({
      baseURL: 'https://api.oxy.so',
      clientId: 'oxy_dk_demo',
      environment: { requestUrl: REQUEST_URL, requestToken: 't' },
      fetchFn,
      now: () => clock,
    });
    expect(await getToken()).toBe('oxy-token-1');
    clock += 200_000;
    expect(await getToken()).toBe('oxy-token-1');
    clock += 41_000;
    expect(await getToken()).toBe('oxy-token-2');
    // Each mint asked GitHub for a NEW ID token.
    expect(calls.filter((c) => c.url.startsWith('https://pipelines.')).length).toBe(2);
  });

  test('concurrent callers share one mint', async () => {
    const { calls, fetchFn } = fakeNetwork();
    const getToken = createGithubOidcTokenProvider({
      baseURL: 'https://api.oxy.so',
      clientId: 'oxy_dk_demo',
      environment: { requestUrl: REQUEST_URL, requestToken: 't' },
      fetchFn,
    });
    const tokens = await Promise.all([getToken(), getToken(), getToken()]);
    expect(new Set(tokens)).toEqual(new Set(['oxy-token-1']));
    expect(calls.length).toBe(2);
  });

  test('surfaces the API refusal, reason included', async () => {
    const { fetchFn } = fakeNetwork({ exchangeStatus: 403 });
    const getToken = createGithubOidcTokenProvider({
      baseURL: 'https://api.oxy.so',
      clientId: 'oxy_dk_demo',
      environment: { requestUrl: REQUEST_URL, requestToken: 't' },
      fetchFn,
    });
    await expect(getToken()).rejects.toThrow(/403.*no_trusted_publisher/);
  });

  test('the audience is the origin, whatever path the API URL has', () => {
    expect(oxyAudience('https://api.oxy.so')).toBe('https://api.oxy.so');
    expect(oxyAudience('http://localhost:3001/')).toBe('http://localhost:3001');
  });
});

describe('createShipClient', () => {
  test('refuses to run outside GitHub Actions OIDC; there is no secret fallback', () => {
    expect(() => createShipClient({ 'client-id': 'oxy_dk_demo' }, { env: {} })).toThrow(
      /id-token: write/,
    );
  });

  test('needs the application client id', () => {
    const saved = process.env.OXY_SHIP_CLIENT_ID;
    delete process.env.OXY_SHIP_CLIENT_ID;
    try {
      expect(() => createShipClient({}, { env: ENV })).toThrow(/client-id/);
    } finally {
      if (saved !== undefined) process.env.OXY_SHIP_CLIENT_ID = saved;
    }
  });

  test('publishes with the exchanged token and learns the application from it', async () => {
    const appToken = `x.${Buffer.from(JSON.stringify({ appId: 'app-123' })).toString('base64url')}.y`;
    const calls: Call[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (url.startsWith('https://pipelines.')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ value: 'github-jwt' }) };
      }
      if (url.endsWith(GITHUB_ACTIONS_EXCHANGE_PATH)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: { token: appToken, expiresIn: 300 } }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { channels: [] } }),
      };
    };
    const client = createShipClient({ 'client-id': 'oxy_dk_demo' }, { env: ENV, fetchFn });
    expect(await client.listChannels()).toEqual([]);
    const list = calls.find((c) => c.url.includes('/updates/v1/channels'));
    expect(list?.url).toContain('applicationId=app-123');
    expect(list?.headers.authorization).toBe(`Bearer ${appToken}`);
  });
});
