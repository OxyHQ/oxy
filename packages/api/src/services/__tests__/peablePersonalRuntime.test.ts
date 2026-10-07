import { generateKeyPairSync } from 'node:crypto';
import type { Peable } from '@peable.to/sdk';
import { createPeablePersonalEvidenceAuthority } from '../peablePersonalEvidence.service';
import { createPeablePersonalRuntime, getPeablePersonalRuntime, initializePeablePersonalRuntime,
  peablePersonalRuntimeConfigurationSchema, recoverPeablePersonalSources, stopPeablePersonalRuntime } from '../peablePersonalRuntime.service';

const source = { invoiceId: 'invoice_fixture', paymentIntentId: 'payment_fixture', customerId: 'customer_fixture',
  subscriptionId: 'subscription_fixture', priceId: 'price_fixture', planId: 'plan_fixture', merchantId: 'merch_fixture',
  appId: 'app_fixture', mode: 'test' as const, environment: 'development' as const };
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const configuration = {
  merchantId: source.merchantId, applicationId: source.appId,
  namespace: { mode: 'test' as const, environment: 'development' as const },
  offers: [{ offerId: 'one', offerVersion: 1, planId: source.planId, providerPriceId: source.priceId }],
  invoiceIssuer: { legalName: 'The Oxy Collective, Inc.' as const, id: 'issuer_fixture' }, sellerId: 'seller_fixture',
  invoiceAuthorityKeys: { fixture: publicKey }, taxQuoteAuthorityKeys: { fixture: publicKey },
  purchasesEnabled: false as const, observationsEnabled: false, recoveryEnabled: false, recoveryIntervalMilliseconds: 60_000,
};
const invoice = { sellerId: 'seller_fixture', invoiceIssuerId: 'issuer_fixture' };
function fixture() {
  const retrieveFinalInvoiceAuthority = jest.fn(async () => ({ source, invoice, method: 'card' as const }));
  const client = { billing: { retrieveFinalInvoiceAuthority } } as unknown as Peable;
  return { client, retrieveFinalInvoiceAuthority };
}
afterEach(stopPeablePersonalRuntime);
it('uses the new SDK invoice-authority API and verifies every frozen source binding', async () => {
  const test = fixture(); const authority = createPeablePersonalEvidenceAuthority(test.client);
  if (!authority.readFinalInvoiceAuthority) throw new Error('Missing SDK authority');
  expect(await authority.readFinalInvoiceAuthority(source)).toEqual({ source, invoice, method: 'card' });
  expect(test.retrieveFinalInvoiceAuthority).toHaveBeenCalledWith(source.subscriptionId, source.invoiceId);
  for (const field of Object.keys(source)) {
    await expect(authority.readFinalInvoiceAuthority({ ...source, [field]: 'other' })).rejects.toThrow('source differs');
  }
});
it('requires the configured approved issuer and seller in SDK evidence', async () => {
  const test = fixture(); const runtime = createPeablePersonalRuntime(test.client, configuration);
  expect(await runtime.authority.readFinalInvoiceAuthority(source)).toMatchObject({ invoice });
  test.retrieveFinalInvoiceAuthority.mockResolvedValue({ source, invoice: { ...invoice, invoiceIssuerId: 'other' }, method: 'card' });
  await expect(runtime.authority.readFinalInvoiceAuthority(source)).rejects.toThrow();
  test.retrieveFinalInvoiceAuthority.mockResolvedValue({ source, invoice: { ...invoice, sellerId: 'other' }, method: 'card' });
  await expect(runtime.authority.readFinalInvoiceAuthority(source)).rejects.toThrow();
});
it('requires deployment-pinned Ed25519 keys and a secret before enabling observations', () => {
  const test = fixture();
  expect(() => createPeablePersonalRuntime(test.client, { ...configuration, observationsEnabled: true })).toThrow('verification unconfigured');
  expect(() => createPeablePersonalRuntime(test.client, { ...configuration, invoiceAuthorityKeys: { fixture: 'not a key' } })).toThrow();
  expect(peablePersonalRuntimeConfigurationSchema.safeParse({ ...configuration, taxQuoteAuthorityKeys: {} }).success).toBe(false);
  expect(peablePersonalRuntimeConfigurationSchema.safeParse({ ...configuration, purchasesEnabled: true }).success).toBe(false);
});
it('refuses disabled observations before any SDK operation or DB lookup', async () => {
  const test = fixture(); const runtime = createPeablePersonalRuntime(test.client, configuration);
  await expect(runtime.observe('untrusted-source', '{}', 'untrusted')).rejects.toThrow('observations disabled');
  await expect(runtime.recover('untrusted-source')).rejects.toThrow('recovery disabled');
  expect(test.retrieveFinalInvoiceAuthority).not.toHaveBeenCalled();
});
it('keeps a production process without configuration closed and starts no recovery', async () => {
  const previousNodeEnvironment = process.env.NODE_ENV, previousEnabled = process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED;
  process.env.NODE_ENV = 'production'; delete process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED;
  try {
    await initializePeablePersonalRuntime();
    expect(getPeablePersonalRuntime()).toBeUndefined();
    await recoverPeablePersonalSources();
  } finally {
    process.env.NODE_ENV = previousNodeEnvironment;
    if (previousEnabled === undefined) delete process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED;
    else process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED = previousEnabled;
  }
});
