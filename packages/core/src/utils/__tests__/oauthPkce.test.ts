import { createHash } from 'node:crypto';
import {
  buildOAuthAuthorizeUrl,
  canonicalizeOAuthRedirectUri,
  computeCodeChallenge,
  DEFAULT_OAUTH_SCOPE,
  generateOAuthState,
  generatePkcePair,
  OXY_AUTHORIZE_URL,
  OXY_OAUTH_REDIRECT_URI_STORAGE_KEY,
  OXY_OAUTH_RETURN_PATH_STORAGE_KEY,
  clearOAuthHandshake,
  consumeOAuthReturnPath,
  persistOAuthHandshake,
  persistOAuthReturnPath,
  readOAuthHandshake,
} from '../oauthPkce';

/** RFC 7636 unreserved subset produced by base64url (no `+`, `/`, `=`). */
const BASE64URL_RE = /^[A-Za-z0-9\-_]+$/;

/** Independent base64url(SHA-256(input)) via Node crypto for cross-checking. */
function nodeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('computeCodeChallenge', () => {
  it('matches the RFC 7636 Appendix B known-answer vector', async () => {
    // From RFC 7636 §Appendix B: verifier -> S256 challenge.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    await expect(computeCodeChallenge(verifier)).resolves.toBe(expected);
  });

  it('produces unpadded base64url (no +, /, or = characters)', async () => {
    const challenge = await computeCodeChallenge('some-arbitrary-code-verifier-value-123');
    expect(challenge).toMatch(BASE64URL_RE);
    expect(challenge).not.toContain('=');
  });

  it('agrees with an independent Node crypto implementation', async () => {
    const verifier = 'another_verifier-value.with~allowed_chars-0123456789';
    await expect(computeCodeChallenge(verifier)).resolves.toBe(nodeCodeChallenge(verifier));
  });

  it('encodes the full 32-byte SHA-256 digest as 43 base64url chars', async () => {
    const challenge = await computeCodeChallenge('x');
    expect(challenge).toHaveLength(43);
  });
});

describe('generatePkcePair', () => {
  it('returns a verifier, challenge, and S256 method', async () => {
    const pair = await generatePkcePair();
    expect(pair.method).toBe('S256');
    expect(typeof pair.codeVerifier).toBe('string');
    expect(typeof pair.codeChallenge).toBe('string');
  });

  it('produces a verifier in the RFC 7636 length range with only unreserved chars', async () => {
    const { codeVerifier } = await generatePkcePair();
    expect(codeVerifier).toMatch(BASE64URL_RE);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it('derives the challenge as base64url(SHA-256(verifier))', async () => {
    const { codeVerifier, codeChallenge } = await generatePkcePair();
    await expect(computeCodeChallenge(codeVerifier)).resolves.toBe(codeChallenge);
    expect(codeChallenge).toBe(nodeCodeChallenge(codeVerifier));
  });

  it('generates a fresh, unpredictable verifier on each call', async () => {
    const [a, b] = await Promise.all([generatePkcePair(), generatePkcePair()]);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe('generateOAuthState', () => {
  it('returns an unreserved base64url token of 32 random bytes (43 chars)', async () => {
    const state = await generateOAuthState();
    expect(state).toMatch(BASE64URL_RE);
    expect(state).toHaveLength(43);
  });

  it('is unique across calls', async () => {
    const [a, b] = await Promise.all([generateOAuthState(), generateOAuthState()]);
    expect(a).not.toBe(b);
  });
});

describe('buildOAuthAuthorizeUrl', () => {
  const base = {
    clientId: 'oxy_dk_example',
    redirectUri: 'https://merchant.co/auth/callback',
    state: 'csrf-state-token',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  };

  it('defaults to the Oxy authorize endpoint', () => {
    const url = buildOAuthAuthorizeUrl(base);
    expect(url.startsWith(`${OXY_AUTHORIZE_URL}?`)).toBe(true);
    expect(OXY_AUTHORIZE_URL).toBe('https://auth.oxy.so/authorize');
  });

  it('includes every required OAuth authorization-code + PKCE parameter', () => {
    const params = new URL(buildOAuthAuthorizeUrl(base)).searchParams;
    expect(params.get('client_id')).toBe(base.clientId);
    expect(params.get('redirect_uri')).toBe(base.redirectUri);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('state')).toBe(base.state);
    expect(params.get('scope')).toBe(DEFAULT_OAUTH_SCOPE);
    expect(params.get('code_challenge')).toBe(base.codeChallenge);
    expect(params.get('code_challenge_method')).toBe('S256');
  });

  it('defaults the scope to "openid profile"', () => {
    const params = new URL(buildOAuthAuthorizeUrl(base)).searchParams;
    expect(params.get('scope')).toBe('openid profile');
  });

  it('honors a custom scope', () => {
    const params = new URL(
      buildOAuthAuthorizeUrl({ ...base, scope: 'openid profile email wallet' }),
    ).searchParams;
    expect(params.get('scope')).toBe('openid profile email wallet');
  });

  it('honors an authorizeBaseUrl override', () => {
    const url = buildOAuthAuthorizeUrl({
      ...base,
      authorizeBaseUrl: 'https://auth.merchant.co/authorize',
    });
    expect(url.startsWith('https://auth.merchant.co/authorize?')).toBe(true);
    expect(new URL(url).searchParams.get('client_id')).toBe(base.clientId);
  });

  it('preserves a query string already present on authorizeBaseUrl', () => {
    const params = new URL(
      buildOAuthAuthorizeUrl({
        ...base,
        authorizeBaseUrl: 'https://auth.merchant.co/authorize?foo=bar&tenant=acme',
      }),
    ).searchParams;
    // Pre-existing params survive alongside the OAuth params.
    expect(params.get('foo')).toBe('bar');
    expect(params.get('tenant')).toBe('acme');
    expect(params.get('client_id')).toBe(base.clientId);
    expect(params.get('code_challenge_method')).toBe('S256');
  });

  it('URL-encodes a redirect_uri that carries a query string and special chars', () => {
    const redirectUri = 'https://merchant.co/auth/callback?next=/dashboard&lang=es';
    const url = buildOAuthAuthorizeUrl({ ...base, redirectUri });
    // The raw string must be percent-encoded (its own & must not leak as a delimiter).
    expect(url).toContain('redirect_uri=https%3A%2F%2Fmerchant.co%2Fauth%2Fcallback');
    expect(url).not.toContain('redirect_uri=https://merchant.co');
    // Round-trips back to the exact original when parsed.
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(redirectUri);
  });
});

describe('canonicalizeOAuthRedirectUri', () => {
  it('collapses apex URLs to origin only', () => {
    expect(canonicalizeOAuthRedirectUri('https://app.example/')).toBe('https://app.example');
    expect(canonicalizeOAuthRedirectUri('https://app.example')).toBe('https://app.example');
  });

  it('preserves path-qualified redirect URIs', () => {
    const uri = 'https://app.example/oauth/callback';
    expect(canonicalizeOAuthRedirectUri(uri)).toBe(uri);
  });
});

describe('OAuth handshake persistence', () => {
  function installSessionStorage(): Map<string, string> {
    const map = new Map<string, string>();
    (globalThis as { sessionStorage?: Storage }).sessionStorage = {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    } as unknown as Storage;
    return map;
  }

  afterEach(() => {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  it('round-trips redirect_uri through persist/read/clear', () => {
    const store = installSessionStorage();
    const redirectUri = 'https://app.example/oauth/callback';
    expect(persistOAuthHandshake('state-1', 'verifier-1', redirectUri)).toBe(true);
    expect(readOAuthHandshake()).toEqual({
      state: 'state-1',
      codeVerifier: 'verifier-1',
      redirectUri,
    });
    clearOAuthHandshake();
    expect(store.get(OXY_OAUTH_REDIRECT_URI_STORAGE_KEY)).toBeUndefined();
    expect(readOAuthHandshake()).toBeNull();
  });
});

describe('OAuth return path', () => {
  /** Minimal sessionStorage stand-in — jsdom is not assumed by this suite. */
  function installSessionStorage(): Map<string, string> {
    const map = new Map<string, string>();
    (globalThis as { sessionStorage?: Storage }).sessionStorage = {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    } as unknown as Storage;
    return map;
  }

  afterEach(() => {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  it('round-trips a deep path through persist/consume', () => {
    installSessionStorage();
    persistOAuthReturnPath('/company/team?tab=eng#lead');
    expect(consumeOAuthReturnPath()).toBe('/company/team?tab=eng#lead');
  });

  it('is single-use, so a stale value cannot redirect a later navigation', () => {
    installSessionStorage();
    persistOAuthReturnPath('/pricing');
    expect(consumeOAuthReturnPath()).toBe('/pricing');
    expect(consumeOAuthReturnPath()).toBeNull();
  });

  it('rejects protocol-relative and absolute values (open-redirect guard)', () => {
    const store = installSessionStorage();
    for (const hostile of ['//evil.com', '/\\evil.com', 'https://evil.com/x', 'evil.com']) {
      persistOAuthReturnPath(hostile);
      expect(store.get(OXY_OAUTH_RETURN_PATH_STORAGE_KEY)).toBeUndefined();
    }
  });

  it('rejects a hostile value written directly into storage', () => {
    const store = installSessionStorage();
    store.set(OXY_OAUTH_RETURN_PATH_STORAGE_KEY, '//evil.com');
    expect(consumeOAuthReturnPath()).toBeNull();
    // Consumed even when rejected, so it cannot be retried.
    expect(store.get(OXY_OAUTH_RETURN_PATH_STORAGE_KEY)).toBeUndefined();
  });

  it('is cleared with the handshake it belongs to', () => {
    const store = installSessionStorage();
    persistOAuthReturnPath('/newsroom');
    clearOAuthHandshake();
    expect(store.get(OXY_OAUTH_RETURN_PATH_STORAGE_KEY)).toBeUndefined();
  });

  it('no-ops without sessionStorage instead of throwing', () => {
    expect(() => persistOAuthReturnPath('/pricing')).not.toThrow();
    expect(consumeOAuthReturnPath()).toBeNull();
  });
});
