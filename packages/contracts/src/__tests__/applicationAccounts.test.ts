import {
  APPLICATION_ACCOUNT_REGISTRATION_BATCH_MAX,
  applicationAccountRegistrationRequestSchema,
  applicationAccountTotalSchema,
} from '../applicationAccounts';

describe('application account contracts', () => {
  it('bounds a registration batch and refuses extra fields', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
    expect(
      applicationAccountRegistrationRequestSchema.safeParse({
        accountIds: ids(APPLICATION_ACCOUNT_REGISTRATION_BATCH_MAX),
      }).success,
    ).toBe(true);
    for (const body of [
      { accountIds: [] },
      { accountIds: ids(APPLICATION_ACCOUNT_REGISTRATION_BATCH_MAX + 1) },
      { accountIds: ['a'], applicationId: 'other' },
    ]) {
      expect(applicationAccountRegistrationRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('never represents an unknown total as a number', () => {
    const base = {
      schemaVersion: 1,
      applicationId: 'app',
      total: 3,
      exact: true,
      computedAt: '2026-11-02T00:00:00.000Z',
      maxAgeSeconds: 300,
      stale: false,
    };
    expect(applicationAccountTotalSchema.safeParse(base).success).toBe(true);
    expect(applicationAccountTotalSchema.safeParse({ ...base, total: -1 }).success).toBe(false);
    expect(applicationAccountTotalSchema.safeParse({ ...base, total: null }).success).toBe(false);
    expect(applicationAccountTotalSchema.safeParse({ ...base, total: 1.5 }).success).toBe(false);
  });
});
