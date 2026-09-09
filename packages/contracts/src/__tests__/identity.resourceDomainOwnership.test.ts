import {
  resourceDomainOwnershipRequestSchema,
  resourceDomainOwnershipResponseSchema,
} from '../identity';

describe('Clarity resource domain ownership contract', () => {
  it('canonicalizes and accepts an exact DNS hostname', () => {
    expect(resourceDomainOwnershipRequestSchema.parse({
      accountId: 'account_1',
      verifiedDomainId: 'domain_1',
      originHost: ' Example.COM ',
    }).originHost).toBe('example.com');
  });

  it('refuses origins containing a scheme, port or path', () => {
    for (const originHost of ['https://example.com', 'example.com:443', 'example.com/path']) {
      expect(resourceDomainOwnershipRequestSchema.safeParse({
        accountId: 'account_1',
        verifiedDomainId: 'domain_1',
        originHost,
      }).success).toBe(false);
    }
  });

  it('requires verification evidence only when supplied by Oxy', () => {
    expect(resourceDomainOwnershipResponseSchema.safeParse({
      verified: true,
      accountId: 'account_1',
      verifiedDomainId: 'domain_1',
      originHost: 'example.com',
      verifiedAt: new Date(0).toISOString(),
      method: 'dns-txt',
    }).success).toBe(true);
  });
});
