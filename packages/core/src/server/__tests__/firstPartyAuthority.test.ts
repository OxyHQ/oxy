import { OxyServer } from '../OxyServer';
import { createSigningKey, mockJwksFetch, signEdDSA } from '../../__tests__/fixtures/serviceTokens';

const key = createSigningKey('first-party');
const audience = 'oxy-service:recipient';
const expiry = Math.floor(Date.now() / 1000) + 300;
const claims = {
  type: 'service',
  authority: 'first_party',
  appId: 'sender',
  appName: 'Sender',
  credentialId: 'wl_sender',
  ownerAccountId: 'billing-account',
  environment: 'production',
  tier: 'internal',
  iss: 'oxy-auth',
  aud: audience,
  iat: expiry - 300,
  exp: expiry,
};
const active = {
  active: true as const,
  authority: 'first_party' as const,
  applicationId: 'sender',
  credentialId: 'wl_sender',
  accountId: 'billing-account',
  environment: 'production' as const,
  audience,
  expiresAt: new Date(expiry * 1000).toISOString(),
};
function response() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}
function request(token = signEdDSA(claims, key)) {
  return {
    method: 'GET',
    path: '/resource',
    headers: { authorization: `Bearer ${token}` } as Record<string, string>,
    query: {},
  };
}
let oxy: OxyServer;
beforeEach(() => {
  mockJwksFetch(() => [key]);
  oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
});
afterEach(() => {
  oxy.dispose();
  jest.restoreAllMocks();
});

it('admits a live workload without scopes and keeps the external scope guard', async () => {
  const live = jest.spyOn(oxy, 'introspectServiceToken').mockResolvedValue(active);
  const req = request();
  const res = response();
  const next = jest.fn();
  await oxy.middleware.auth({ expectedAudience: audience })(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(live).toHaveBeenCalledTimes(1);
  expect(req).toMatchObject({ serviceApp: { authority: 'first_party' } });
  expect((req as { serviceApp?: { scopes?: unknown } }).serviceApp).not.toHaveProperty('scopes');
  oxy.middleware.requireScope('files:read')(req, res, next);
  expect(next).toHaveBeenCalledTimes(2);
  const external = {
    ...req,
    serviceApp: { ...claims, authority: 'external' as const, scopes: [] },
  };
  oxy.middleware.requireScope('files:read')(external, res, next);
  expect(res.statusCode).toBe(403);
});

it('rechecks revocation on every request', async () => {
  const live = jest
    .spyOn(oxy, 'introspectServiceToken')
    .mockResolvedValueOnce(active)
    .mockResolvedValue({ active: false });
  const next = jest.fn();
  await oxy.middleware.auth({ expectedAudience: audience })(request(), response(), next);
  const res = response();
  await oxy.middleware.auth({ expectedAudience: audience })(request(), res, next);
  expect(live).toHaveBeenCalledTimes(2);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.statusCode).toBe(401);
});

it('rejects the wrong audience before introspection', async () => {
  const live = jest.spyOn(oxy, 'introspectServiceToken');
  const res = response();
  const next = jest.fn();
  await oxy.middleware.auth({ expectedAudience: 'oxy-service:other' })(request(), res, next);
  expect(next).not.toHaveBeenCalled();
  expect(live).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(401);
});

it('requires requester proof and preserves the independent billing account', async () => {
  jest.spyOn(oxy, 'introspectServiceToken').mockResolvedValue(active);
  const verify = jest
    .spyOn(oxy, 'verifyActingAs')
    .mockResolvedValue({ authorized: true, authority: 'first_party', epoch: '1' });
  const req = request();
  req.headers['x-oxy-user-id'] = 'person';
  req.headers['x-oxy-requester-token'] = 'requester-proof';
  const next = jest.fn();
  await oxy.middleware.auth({ expectedAudience: audience })(req, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledWith(
    'sender',
    'person',
    expect.objectContaining({ requesterToken: 'requester-proof', cache: false }),
  );
  expect(req).toMatchObject({
    userId: 'person',
    serviceApp: { ownerAccountId: 'billing-account' },
    serviceActingAs: { authority: 'first_party' },
  });
});

it('rejects an external-authority workload even if stale introspection tries to promote it', async () => {
  const token = signEdDSA(
    { ...claims, authority: 'external', scopes: ['files:read'], aud: 'oxy-api' },
    key,
  );
  jest.spyOn(oxy, 'introspectServiceToken').mockResolvedValue({ ...active, audience: 'oxy-api' });
  const req = request(token);
  const res = response();
  const next = jest.fn();
  await oxy.middleware.auth({ expectedAudience: audience })(req, res, next);
  expect(res.statusCode).toBe(401);
  expect(next).not.toHaveBeenCalled();
  expect(req).not.toHaveProperty('serviceApp');
});
it.each([
  'accountId',
  'applicationId',
  'credentialId',
  'environment',
  'audience',
  'expiresAt',
] as const)(
  'refuses live workload identity whose %s differs from the verified token',
  async (field) => {
    const token = signEdDSA(claims, key);
    jest.spyOn(oxy, 'introspectServiceToken').mockResolvedValue({
      ...active,
      [field]: field === 'expiresAt' ? new Date((expiry + 1) * 1000).toISOString() : 'other',
    } as typeof active);
    const res = response();
    const next = jest.fn();
    await oxy.middleware.auth({ expectedAudience: audience })(request(token), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  },
);
it('keeps customer credential authority external, narrows its live scopes, and ignores legacy tier branding', async () => {
  const token = signEdDSA(
    {
      ...claims,
      credentialId: 'customer-credential',
      authority: 'external',
      scopes: ['files:read'],
      aud: 'oxy-api',
    },
    key,
  );
  jest.spyOn(oxy, 'introspectServiceToken').mockResolvedValue({
    ...active,
    credentialId: 'customer-credential',
    authority: 'external',
    scopes: [],
    audience: 'oxy-api',
  });
  const req = request(token);
  const next = jest.fn();
  const res = response();
  await oxy.middleware.auth({ expectedAudience: audience })(req, res, next);
  expect(req).toMatchObject({
    serviceApp: { authority: 'external', tier: 'external', scopes: [] },
  });
  oxy.middleware.requireScope('files:read')(req, res, next);
  expect(res.statusCode).toBe(403);
});
