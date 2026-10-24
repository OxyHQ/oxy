import { serviceTokenOptionsSchema, serviceTokenScopesSchema } from '../serviceToken';
it('normalizes an explicit scope subset without changing omitted defaults', () => {
  expect(serviceTokenOptionsSchema.parse({})).toEqual({});
  expect(serviceTokenScopesSchema.parse([' user:read ', 'files:read'])).toEqual([
    'files:read',
    'user:read',
  ]);
});
it.each([
  { scopes: [] },
  { scopes: [''] },
  { scopes: ['user:read', ' user:read '] },
  { scopes: Array.from({ length: 101 }, (_, i) => `scope:${i}`) },
])('rejects ambiguous or unbounded subsets $scopes', ({ scopes }) => {
  expect(serviceTokenScopesSchema.safeParse(scopes).success).toBe(false);
});

describe('first-party service authority', () => {
  const identity = {
    active: true,
    authority: 'first_party',
    accountId: 'owner',
    applicationId: 'app',
    credentialId: 'wl_role',
    environment: 'production',
    audience: 'oxy-service:recipient',
    expiresAt: '2026-10-23T12:00:00.000Z',
  };
  it('has no scope list; external authority must name its limits', async () => {
    const { serviceIntrospectionSchema } = await import('../serviceToken');
    expect(serviceIntrospectionSchema.parse(identity)).toEqual(identity);
    expect(serviceIntrospectionSchema.safeParse({ ...identity, scopes: [] }).success).toBe(false);
    expect(
      serviceIntrospectionSchema.safeParse({ ...identity, authority: 'external' }).success,
    ).toBe(false);
    expect(
      serviceIntrospectionSchema.safeParse({
        ...identity,
        authority: 'external',
        scopes: ['files:read'],
      }).success,
    ).toBe(true);
    expect(serviceIntrospectionSchema.parse({ active: false })).toEqual({ active: false });
  });
});

it('distinguishes human, key and service resource principals without invented claims', async () => {
  const { resourceIntrospectionSchema, serviceIntrospectionSchema } = await import(
    '../serviceToken'
  );
  const person = {
    active: true,
    kind: 'session',
    permissions: [],
    authority: 'first_party',
    accountId: 'org',
    effectiveAccountId: 'org',
    requesterAccountId: 'human',
    applicationId: null,
    expiresAt: '2026-10-23T12:00:00.000Z',
  };
  expect(resourceIntrospectionSchema.parse(person)).toEqual(person);
  expect(serviceIntrospectionSchema.safeParse(person).success).toBe(false);
  expect(resourceIntrospectionSchema.safeParse({ ...person, scopes: [] }).success).toBe(false);
  const key = {
    active: true,
    kind: 'key',
    permissions: [],
    authority: 'external',
    accountId: 'owner',
    applicationId: 'app',
    credentialId: 'key',
    environment: 'production',
    scopes: ['clarity:search'],
  };
  expect(resourceIntrospectionSchema.parse(key)).toEqual(key);
  expect(resourceIntrospectionSchema.safeParse({ ...key, authority: 'first_party' }).success).toBe(
    false,
  );
  expect(
    resourceIntrospectionSchema.safeParse({
      ...person,
      authority: 'external',
      applicationId: 'app',
      scopes: [],
    }).success,
  ).toBe(true);
});
