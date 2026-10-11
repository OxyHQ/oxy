import { meteredGenerationSchema } from '../inference/economics';

const record = {
  schemaVersion: 2,
  kind: 'metered_usage',
  meteredUsageId: 'usage-1',
  requestId: 'req-1',
  parentRequestId: 'parent-1',
  applicationId: 'app-1',
  credentialId: 'credential-1',
  environment: 'production',
  economicTreatment: 'internal_metered',
  economicPolicyVersion: 'policy-2',
  outcome: 'completed',
  usageSource: 'provider_reported',
  units: [{ unit: 'input_tokens', quantity: 1000 }],
  resolvedModelReference: 'acme/model@revision',
  servingProvider: 'acme',
  tariff: {
    status: 'quoted',
    amount: '0.001000000000',
    currency: 'USD',
    priceVersionId: 'price-1',
  },
  customerCharge: { status: 'not_charged' },
  settledAt: '2026-10-02T12:00:00.000Z',
};

it('preserves the technical record, pinned tariff and parent lineage without inventing a financial receipt', () => {
  expect(meteredGenerationSchema.parse(record)).toEqual(record);
  expect(
    meteredGenerationSchema.parse({
      ...record,
      tariff: { status: 'unpriced', priceVersionId: null },
    }).tariff.status,
  ).toBe('unpriced');
});

it.each([
  { receiptId: 'receipt-1' },
  { economicTreatment: 'commercial' },
  { customerCharge: { status: 'charged', amount: '0.01' } },
  { tariff: { status: 'quoted', amount: '0.01', currency: 'USD' } },
  { resolvedModelReference: 'unpinned-model' },
])(
  'refuses a technical record that invents charge evidence or drops its pinned context: %j',
  (invalid) => {
    expect(meteredGenerationSchema.safeParse({ ...record, ...invalid }).success).toBe(false);
  },
);
