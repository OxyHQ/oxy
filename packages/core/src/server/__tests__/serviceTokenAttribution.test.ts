/**
 * Canonical request attribution for service tokens (ADR 0007, issue #972 §2.2).
 *
 * Two claims are under test, and they are different claims:
 *
 *  1. A VERIFIED service token names the whole attribution tuple locally —
 *     application, credential, owning account, environment and effective
 *     scopes — so a verifier with no database can say who is responsible.
 *  2. A delegated `X-Oxy-User-Id` can never become that responsible party. It
 *     is visible exactly where delegation is meant to be visible
 *     (`req.userId`, `getOxyDelegatedUserId`) and nowhere else.
 *
 * Everything runs through the REAL `oxy.middleware.auth()` middleware with a real
 * Ed25519 signature verified against a (fetch-mocked) published JWKS, so the assertions are about the shipped lane rather than a
 * hand-built request object. The one exception is deliberate and marked: the
 * tampering cases plant fields on an already-authenticated request to prove the
 * billing resolver does not read them.
 */

import { OxyServer } from '../OxyServer';
import {
  getOxyBillingPrincipal,
  getOxyDelegatedUserId,
  getOxyRequestAttribution,
  getRequiredOxyBillingPrincipal,
  getRequiredOxyUserId,
} from '../auth';
import type { Request } from 'express';
import {
  b64url,
  createSigningKey,
  mockJwksFetch,
  signEdDSA,
  type ServiceTokenSigningKey,
} from '../../__tests__/fixtures/serviceTokens';

const SIGNING_KEY = createSigningKey('attribution-suite-a');
// Same kid, different private key: the published key cannot verify it.
const IMPOSTER_KEY = createSigningKey('attribution-suite-a');
const OWNER_ACCOUNT = 'account-owning-the-application';
const DELEGATED_USER = 'end-user-the-service-acts-for';

interface Claims {
  [key: string]: unknown;
}

/** Sign an EdDSA JWT in the shape `POST /auth/service-token` mints (ADR 0012). */
function signServiceToken(claims: Claims = {}, key: ServiceTokenSigningKey = SIGNING_KEY): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Claims = {
    iat: now,
    exp: now + 3600,
    type: 'service',
    aud: 'oxy-api',
    iss: 'oxy-auth',
    appId: 'app-1',
    appName: 'kaana',
    credentialId: 'cred-1',
    ownerAccountId: OWNER_ACCOUNT,
    environment: 'production',
    scopes: ['inference:invoke'],
    ...claims,
  };
  return signEdDSA(payload, key);
}

interface MockReq {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  userId?: string | null;
  user?: unknown;
  serviceApp?: unknown;
  serviceActingAs?: unknown;
  accessToken?: string;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

const makeReq = (headers: Record<string, string> = {}): MockReq => ({
  method: 'POST',
  path: '/v1/responses',
  headers,
  query: {},
});

const makeRes = (): MockRes => ({
  statusCode: 0,
  body: undefined,
  headersSent: false,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(body: unknown) {
    this.body = body;
    this.headersSent = true;
    return this;
  },
});

/** Run `oxy.middleware.auth()` over a request and report what the middleware decided. */
async function authenticate(
  oxy: OxyServer,
  headers: Record<string, string>,
  options: Parameters<OxyServices['auth']>[0] = {},
): Promise<{ req: MockReq; res: MockRes; nextCalled: boolean }> {
  const req = makeReq(headers);
  const res = makeRes();
  const next = jest.fn();
  const middleware = oxy.middleware.auth(options);
  await middleware(req as unknown as never, res as unknown as never, next as unknown as never);
  return { req, res, nextCalled: next.mock.calls.length > 0 };
}

/** `MockReq` is the structural subset the resolvers read; Express's own shape is irrelevant here. */
const asRequest = (req: MockReq): Request => req as unknown as Request;

let oxy: OxyServer;
/** What the JWKS endpoint answers right now; a test may swap it for an outage. */
let publishedJwks: () => ServiceTokenSigningKey[] | { status: number };

beforeEach(() => {
  oxy = new OxyServer({ baseURL: 'http://test.invalid' });
  publishedJwks = () => [SIGNING_KEY];
  mockJwksFetch(() => publishedJwks());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a verified service token resolves the whole attribution tuple locally', () => {
  it('names application, credential, owning account, environment and effective scopes', async () => {
    const { req, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
    });

    expect(nextCalled).toBe(true);
    expect(getOxyBillingPrincipal(asRequest(req))).toEqual({
      accountId: OWNER_ACCOUNT,
      applicationId: 'app-1',
      credentialId: 'cred-1',
      environment: 'production',
      scopes: ['inference:invoke'],
    });
  });

  it('reports the effective scopes verbatim — nothing re-intersects them here', async () => {
    // The mint already intersected credential ∩ application via the API's
    // `intersectScopes`. If this side narrowed again it would be a second
    // authority, and the two could disagree.
    const token = signServiceToken({ scopes: ['inference:invoke', 'inference:models:read'] });
    const { req } = await authenticate(oxy, { authorization: `Bearer ${token}` });

    expect(getRequiredOxyBillingPrincipal(asRequest(req)).scopes).toEqual([
      'inference:invoke',
      'inference:models:read',
    ]);
  });

  it('has no principal at all for an unauthenticated request', () => {
    expect(getOxyBillingPrincipal(asRequest(makeReq()))).toBeNull();
    expect(() => getRequiredOxyBillingPrincipal(asRequest(makeReq()))).toThrow(
      'no verified Oxy service principal',
    );
  });
});

describe('a delegated X-Oxy-User-Id is attribution, never the payer', () => {
  it('leaves the billing account untouched while the delegated user stays visible', async () => {
    jest
      .spyOn(oxy, 'verifyActingAs')
      .mockResolvedValue({ authorized: true, scopes: ['user:read'] });

    const { req, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
      'x-oxy-user-id': DELEGATED_USER,
    });

    expect(nextCalled).toBe(true);

    // The assertion that matters: who pays does not move.
    const principal = getRequiredOxyBillingPrincipal(asRequest(req));
    expect(principal.accountId).toBe(OWNER_ACCOUNT);
    expect(principal.accountId).not.toBe(DELEGATED_USER);

    // The POSITIVE CONTROL. Without it, a resolver that simply returned a
    // constant would pass the line above. The delegated id must be visible
    // exactly where delegation is supposed to be visible.
    expect(getOxyDelegatedUserId(asRequest(req))).toBe(DELEGATED_USER);
    expect(getRequiredOxyUserId(asRequest(req))).toBe(DELEGATED_USER);
    expect(getOxyRequestAttribution(asRequest(req))).toEqual({
      accountId: OWNER_ACCOUNT,
      applicationId: 'app-1',
      credentialId: 'cred-1',
      environment: 'production',
      scopes: ['inference:invoke'],
      delegatedUserId: DELEGATED_USER,
    });
  });

  it('resolves the SAME billing account with and without delegation', async () => {
    jest
      .spyOn(oxy, 'verifyActingAs')
      .mockResolvedValue({ authorized: true, scopes: ['user:read'] });

    const withDelegation = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
      'x-oxy-user-id': DELEGATED_USER,
    });
    const withoutDelegation = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
    });

    // Restated as ADR 0007 states it: removing `userId` from a request must not
    // change what any account is charged.
    expect(getRequiredOxyBillingPrincipal(asRequest(withDelegation.req))).toEqual(
      getRequiredOxyBillingPrincipal(asRequest(withoutDelegation.req)),
    );
    expect(getOxyDelegatedUserId(asRequest(withoutDelegation.req))).toBeNull();
    expect(withoutDelegation.req.userId).toBeNull();
  });

  it('ignores a userId planted on an already-authenticated request', async () => {
    const { req } = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
    });

    // Deliberate tampering AFTER authentication: this is the shape a downstream
    // middleware bug takes. `getOxyBillingPrincipal` must read `serviceApp` and
    // nothing else, so none of these can move the answer.
    req.userId = DELEGATED_USER;
    req.user = { id: DELEGATED_USER };
    req.serviceActingAs = { userId: DELEGATED_USER, scopes: [] };

    expect(getRequiredOxyBillingPrincipal(asRequest(req)).accountId).toBe(OWNER_ACCOUNT);
    // Control: the planted fields ARE readable through the user-identity
    // accessor, so the assertion above is about the resolver's inputs and not
    // about the fields being unset.
    expect(getRequiredOxyUserId(asRequest(req))).toBe(DELEGATED_USER);
  });

  it('does not put the delegated user anywhere on the service principal', async () => {
    jest
      .spyOn(oxy, 'verifyActingAs')
      .mockResolvedValue({ authorized: true, scopes: ['user:read'] });

    const { req } = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
      'x-oxy-user-id': DELEGATED_USER,
    });

    // A field-name-agnostic sweep: no value of `req.serviceApp`, at any depth
    // this object has, may equal the delegated id. A future field called
    // `userId`/`subject`/`onBehalfOf` would fail here without anyone having to
    // remember to extend the list above.
    expect(JSON.stringify(req.serviceApp)).not.toContain(DELEGATED_USER);
  });
});

describe('signature verification is mandatory before any claim is trusted', () => {
  it('refuses a token signed with a key Oxy never published (401, no principal)', async () => {
    const forged = signServiceToken({}, IMPOSTER_KEY);
    const { req, res, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${forged}`,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SERVICE_TOKEN' });
    expect(req.serviceApp).toBeUndefined();
    expect(getOxyBillingPrincipal(asRequest(req))).toBeNull();
  });

  it('refuses a token whose payload was edited after signing', async () => {
    // The attack the claim set invites: take a real token and rewrite
    // `ownerAccountId` to somebody else's account. The signature covers the
    // payload, so the edit must not survive.
    const token = signServiceToken();
    const [headerB64, , signatureB64] = token.split('.');
    const tamperedPayload = b64url(
      JSON.stringify({
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        type: 'service',
        aud: 'oxy-api',
        iss: 'oxy-auth',
        appId: 'app-1',
        appName: 'kaana',
        credentialId: 'cred-1',
        ownerAccountId: 'somebody-elses-account',
        environment: 'production',
        scopes: ['inference:invoke'],
      }),
    );
    const { req, res, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${headerB64}.${tamperedPayload}.${signatureB64}`,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(req.serviceApp).toBeUndefined();
  });

  it('refuses an UNSIGNED token (alg: none, empty signature segment)', async () => {
    const headerB64 = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payloadB64 = b64url(
      JSON.stringify({
        type: 'service',
        appId: 'app-1',
        appName: 'kaana',
        credentialId: 'cred-1',
        ownerAccountId: OWNER_ACCOUNT,
        environment: 'production',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aud: 'oxy-api',
        iss: 'oxy-auth',
      }),
    );
    const { req, res, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${headerB64}.${payloadB64}.`,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(req.serviceApp).toBeUndefined();
  });

  it('refuses every service token when no verification key can be obtained', async () => {
    // The secure default: without the published key the middleware CANNOT
    // verify, so it must not fall back to reading the decoded claims.
    publishedJwks = () => ({ status: 503 });
    const { req, res, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SERVICE_TOKEN' });
    expect(req.serviceApp).toBeUndefined();
    expect(getOxyBillingPrincipal(asRequest(req))).toBeNull();
  });

  it('attaches no principal on the OPTIONAL lane either', async () => {
    // `optional: true` degrades to anonymous rather than 401 — the thing that
    // must not happen is degrading to an UNVERIFIED principal.
    const forged = signServiceToken({}, IMPOSTER_KEY);
    const { req, nextCalled } = await authenticate(
      oxy,
      { authorization: `Bearer ${forged}` },
      { optional: true },
    );

    expect(nextCalled).toBe(true);
    expect(req.serviceApp).toBeUndefined();
    expect(req.userId).toBeNull();
    expect(getOxyBillingPrincipal(asRequest(req))).toBeNull();
  });
});

describe('the owning account is a required claim', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['a number', 42],
    ['null', null],
  ])('refuses a signature-valid token whose ownerAccountId is %s', async (_label, value) => {
    const token = signServiceToken({ ownerAccountId: value });
    const { req, res, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${token}`,
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SERVICE_TOKEN' });
    expect(getOxyBillingPrincipal(asRequest(req))).toBeNull();
  });

  it('accepts the same token once the claim is present — the control', async () => {
    const { res, nextCalled } = await authenticate(oxy, {
      authorization: `Bearer ${signServiceToken()}`,
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(0);
  });
});
