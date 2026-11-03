import { generateKeyPairSync } from 'node:crypto';
import type { Peable } from '@peable.to/sdk';
import { createPeablePersonalRuntime } from '../peablePersonalRuntime.service';

const publicKey = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();
function fixture() {
  const event = {
    id: 'evt_fixture',
    object: 'event',
    livemode: true,
    type: 'billing.observation.updated',
    api_version: '2026-11-03',
    request: { id: null as string | null, idempotency_key: null as string | null },
    created: 1793720000,
    data: {
      object: {
        object: 'billing_observation',
        livemode: true,
        resource_kind: 'invoice',
        resource_id: 'in_fixture',
        subscription_id: 'sub_fixture',
        revision: 1,
        observed_at: 1793720000,
      },
    },
  };
  const constructEvent = jest.fn(() => event);
  const retrieveSubscription = jest.fn(async () => ({
    provider_subscription_id: 'sub_wrong',
    livemode: true,
  }));
  const client = {
    webhooks: { constructEvent },
    billing: { retrieveSubscription },
  } as unknown as Peable;
  const runtime = createPeablePersonalRuntime(
    client,
    {
      merchantId: 'merch_fixture',
      applicationId: 'app_fixture',
      namespace: { mode: 'live', environment: 'production' },
      offers: [
        {
          offerId: 'offer_fixture',
          offerVersion: 1,
          planId: 'plan_fixture',
          providerPriceId: 'price_fixture',
        },
      ],
      invoiceIssuer: { legalName: 'Oxy Platforms, Inc.', id: 'merch_fixture' },
      sellerId: 'merch_fixture',
      invoiceAuthorityKeys: { fixture: publicKey },
      taxQuoteAuthorityKeys: { fixture: publicKey },
      purchasesEnabled: false,
      observationsEnabled: true,
      recoveryEnabled: true,
      recoveryIntervalMilliseconds: 60000,
    },
    'fixture_observation_secret',
  );
  return { runtime, event, constructEvent, retrieveSubscription };
}
it('authenticates signed raw bytes before any owned provider read', async () => {
  const f = fixture();
  f.constructEvent.mockImplementation(() => {
    throw new Error('Signature mismatch');
  });
  await expect(f.runtime.observeMerchant('{ "exact": 1 }', 'untrusted')).rejects.toThrow(
    'Signature mismatch',
  );
  expect(f.constructEvent).toHaveBeenCalledWith(
    '{ "exact": 1 }',
    'untrusted',
    'fixture_observation_secret',
  );
  expect(f.retrieveSubscription).not.toHaveBeenCalled();
});
it('rejects a signed event for the other money mode before lookup', async () => {
  const f = fixture();
  f.event.livemode = false;
  await expect(f.runtime.observeMerchant('{}', 'verified')).rejects.toThrow('mode differs');
  expect(f.retrieveSubscription).not.toHaveBeenCalled();
});
it('does not invent a parent for legacy invoice events', async () => {
  const f = fixture();
  Reflect.deleteProperty(f.event.data.object, 'subscription_id');
  await expect(f.runtime.observeMerchant('{}', 'verified')).rejects.toThrow('parent unavailable');
  expect(f.retrieveSubscription).not.toHaveBeenCalled();
});
it('treats the signed parent as a hint and rejects an owned read naming another subscription', async () => {
  const f = fixture();
  await expect(f.runtime.observeMerchant('{}', 'verified')).rejects.toThrow('parent differs');
  expect(f.retrieveSubscription).toHaveBeenCalledWith('sub_fixture');
});
it('rejects a contradictory parent on a subscription observation', async () => {
  const f = fixture();
  f.event.data.object.resource_kind = 'subscription';
  await expect(f.runtime.observeMerchant('{}', 'verified')).rejects.toThrow('parent unavailable');
  expect(f.retrieveSubscription).not.toHaveBeenCalled();
});

it('rejects malformed request metadata before any owned provider lookup', async () => {
  const f = fixture();
  Reflect.set(f.event.request, 'id', 42);
  await expect(f.runtime.observeMerchant('{}', 'verified')).rejects.toThrow();
  expect(f.retrieveSubscription).not.toHaveBeenCalled();
});
it('accepts historical envelopes without additive request metadata', async () => {
  const f = fixture();
  Reflect.deleteProperty(f.event, 'request');
  Reflect.deleteProperty(f.event, 'api_version');
  await expect(f.runtime.observeMerchant('{}', 'verified')).rejects.toThrow('parent differs');
  expect(f.retrieveSubscription).toHaveBeenCalledWith('sub_fixture');
});
it('rejects an unsupported event wire version before owned lookup', async () => {
  const f = fixture();
  f.event.api_version = '2099-01-01';
  await expect(f.runtime.observeMerchant('{}', 'verified')).rejects.toThrow();
  expect(f.retrieveSubscription).not.toHaveBeenCalled();
});
