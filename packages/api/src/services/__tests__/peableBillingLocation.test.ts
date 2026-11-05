import { billingCustomerLocationRequestSchema } from '@oxy.so/contracts';
import type { Peable } from '@peable.to/sdk';
import {
  recordPeableCustomerLocation,
  resolvePeableCustomerLocation,
} from '../peableBillingLocation.service';
const now = new Date('2026-11-03T12:00:00.000Z');
const configuration = {
  merchantId: 'merch_billing',
  applicationId: 'billing',
  namespace: { mode: 'live' as const, environment: 'production' },
};
const request = billingCustomerLocationRequestSchema.parse({
  expectedSubjectAccountId: 'payer',
  billingAddress: { country: 'US', state: 'DE', postalCode: '19802' },
});
function fixture() {
  const evidence = {
    id: 'taxloc_owned',
    customerRef: 'payer',
    status: 'sufficient',
    country: 'US',
    livemode: true,
    observedAt: '2026-11-03T11:00:00.000Z',
    expiresAt: '2026-11-04T11:00:00.000Z',
  };
  const create = jest.fn().mockResolvedValue(evidence),
    retrieve = jest.fn().mockResolvedValue(evidence);
  const merchant = jest
    .fn()
    .mockResolvedValue({
      id: configuration.merchantId,
      oxyAppId: configuration.applicationId,
      environment: 'production',
    });
  const client = {
    merchants: { retrieve: merchant },
    tax: { locationEvidence: { create, retrieve } },
  } as unknown as Pick<Peable, 'merchants' | 'tax'>;
  return { client, evidence, create, retrieve, merchant };
}
it('records only the authenticated payer address as one kind and returns no raw address', async () => {
  const f = fixture();
  const result = await recordPeableCustomerLocation(
    f.client,
    configuration,
    'payer',
    request,
    () => now,
  );
  expect(f.create).toHaveBeenCalledWith({
    customerRef: 'payer',
    evidence: [{ type: 'billing_address', address: request.billingAddress }],
  });
  expect(result).toEqual({
    state: 'recorded',
    subjectAccountId: 'payer',
    evidenceId: 'taxloc_owned',
    status: 'sufficient',
    country: 'US',
    expiresAt: f.evidence.expiresAt,
  });
});
it('refuses a switched subject before any provider call', async () => {
  const f = fixture();
  await expect(
    recordPeableCustomerLocation(f.client, configuration, 'other', request, () => now),
  ).rejects.toMatchObject({ code: 'SUBJECT_CHANGED' });
  expect(f.merchant).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});
it('keeps a single address insufficient where the provider requires another verified kind', async () => {
  const f = fixture();
  f.create.mockResolvedValue({ ...f.evidence, status: 'insufficient', country: null });
  expect(
    await recordPeableCustomerLocation(f.client, configuration, 'payer', request, () => now),
  ).toMatchObject({ state: 'recorded', status: 'insufficient' });
});
it.each(['id', 'oxyAppId', 'environment'])(
  'refuses a different merchant %s before writing evidence',
  async (field) => {
    const f = fixture();
    f.merchant.mockResolvedValue({
      id: configuration.merchantId,
      oxyAppId: configuration.applicationId,
      environment: 'production',
      [field]: 'other',
    });
    await expect(
      recordPeableCustomerLocation(f.client, configuration, 'payer', request, () => now),
    ).rejects.toThrow('owner differs');
    expect(f.create).not.toHaveBeenCalled();
  },
);
it.each([
  { customerRef: 'another-payer' },
  { livemode: false },
  { id: 'taxloc_other' },
  { observedAt: '2026-11-04T00:00:00.000Z' },
  { expiresAt: '2026-11-03T11:00:00.000Z' },
  { status: 'insufficient' },
  { status: 'conflicting' },
  { country: null },
])('does not use mismatched, expired or insufficient referenced evidence: %j', async (patch) => {
  const f = fixture();
  f.retrieve.mockResolvedValue({ ...f.evidence, ...patch });
  await expect(
    resolvePeableCustomerLocation(f.client, configuration, 'payer', 'taxloc_owned', () => now),
  ).rejects.toThrow();
});
it('accepts only a currently sufficient reference owned by this payer and namespace', async () => {
  const f = fixture();
  await expect(
    resolvePeableCustomerLocation(f.client, configuration, 'payer', 'taxloc_owned', () => now),
  ).resolves.toEqual({ customerLocationEvidenceId: 'taxloc_owned' });
  expect(f.retrieve).toHaveBeenCalledWith('taxloc_owned');
});
it('requires an explicit reference without falling back to a configured per-account map', async () => {
  const f = fixture();
  await expect(
    resolvePeableCustomerLocation(f.client, configuration, 'payer', undefined, () => now),
  ).rejects.toMatchObject({ code: 'BILLING_LOCATION_REQUIRED' });
  expect(f.retrieve).not.toHaveBeenCalled();
});
