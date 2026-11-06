import { createPeablePersonalCheckoutProvider } from '../peablePersonalCheckout.service';
import type { PersonalCheckoutInput } from '../personalPlanCheckout.service';
import { nativePeable } from '../__fixtures__/nativePeable';

const merchant = { id: 'merch_fixture', oxy_app_id: 'app_fixture', environment: 'production' };

function fixture(
  priceInput: Parameters<ReturnType<typeof nativePeable>['price']>[0] = {
    unitAmount: 599,
    interval: 'month',
  },
) {
  const peable = nativePeable({ merchant, livemode: true });
  const price = peable.price(priceInput);
  const configuration = {
    merchantId: merchant.id,
    applicationId: merchant.oxy_app_id,
    namespace: { mode: 'live' as const, environment: 'production' as const },
    returnUrl: 'https://accounts.oxy.so/payments',
    offers: [
      {
        offerId: 'mention_plus_monthly',
        offerVersion: 1,
        priceId: price.id,
        amountMinorUnits: 599,
        currency: 'USD' as const,
        interval: 'month' as const,
        trial: 'none' as const,
      },
    ],
  };
  const provider = createPeablePersonalCheckoutProvider(peable.client, configuration);
  const input: PersonalCheckoutInput = {
    intentId: 'intent_1',
    idempotencyKey: 'personal-checkout:intent_1',
    subjectAccountId: 'account_1',
    offerId: 'mention_plus_monthly',
    offerVersion: 1,
    priceId: price.id,
    amountMinorUnits: 599,
    currency: 'usd',
    providerAccountRef: merchant.id,
    mode: 'live',
    environment: 'production',
    interval: 'month',
    trial: 'none',
  };
  return { peable, price, provider, input, configuration };
}

it('prepares one native customer per account and replays only the frozen binding', async () => {
  const f = fixture();
  const create = jest.spyOn(f.peable.client.customers, 'create');
  const prepare = f.provider.prepare;
  if (!prepare) throw new Error('prepare missing');
  const snapshot = await prepare(f.input);
  expect(snapshot).toMatchObject({
    merchantId: merchant.id,
    applicationId: merchant.oxy_app_id,
    subjectAccountId: 'account_1',
    priceId: f.price.id,
    returnUrl: 'https://accounts.oxy.so/payments',
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toEqual({ metadata: { oxy_account_id: 'account_1' } });
  // A second preparation finds the customer by its account key, not a new one.
  expect((await prepare({ ...f.input, intentId: 'intent_2' })).customerId).toBe(
    snapshot.customerId,
  );
  expect(create).toHaveBeenCalledTimes(1);

  const sessionCreate = jest.spyOn(f.peable.client.checkout.sessions, 'create');
  const session = await f.provider.create({ ...f.input, snapshot });
  expect(session.checkoutUrl).toMatch(/^https:\/\/checkout\.peable\.to\//);
  expect(sessionCreate.mock.calls[0][0]).toEqual({
    mode: 'subscription',
    customer: snapshot.customerId,
    line_items: [{ price: f.price.id, quantity: 1 }],
    automatic_tax: { enabled: true },
    success_url: 'https://accounts.oxy.so/payments',
    cancel_url: 'https://accounts.oxy.so/payments',
    client_reference_id: 'intent_1',
    metadata: { oxy_checkout_intent: 'intent_1', oxy_account_id: 'account_1' },
  });
  expect(sessionCreate.mock.calls[0][1]).toEqual({ idempotencyKey: 'personal-checkout:intent_1' });
  expect(await f.provider.create({ ...f.input, snapshot })).toEqual(session);
});

it('leaves the payment methods to Peable, so every Plus order also offers FairCoin', async () => {
  const f = fixture();
  const snapshot = await f.provider.prepare?.(f.input);
  if (!snapshot) throw new Error('prepare missing');
  const sessionCreate = jest.spyOn(f.peable.client.checkout.sessions, 'create');
  const session = await f.provider.create({ ...f.input, snapshot });
  // Never narrowed: a list without `faircoin` is `payment_method_locked` (Peable ADR 0021).
  expect(sessionCreate.mock.calls[0][0]).not.toHaveProperty('payment_method_types');
  const created = await sessionCreate.mock.results[0].value;
  expect(created.payment_method_types).toEqual(['card', 'faircoin']);
  // The hosted URL carries the payer's capability in its fragment, never a query.
  expect(new URL(session.checkoutUrl).search).toBe('');
  expect(new URL(session.checkoutUrl).hash).toMatch(/^#cs=cs_/);
});

it.each([
  ['amount', { unitAmount: 699, interval: 'month' as const }],
  ['cadence', { unitAmount: 599, interval: 'year' as const }],
  [
    'tax treatment',
    { unitAmount: 599, interval: 'month' as const, taxBehavior: 'exclusive' as const },
  ],
  ['currency', { unitAmount: 599, interval: 'month' as const, currency: 'EUR' }],
  ['activity', { unitAmount: 599, interval: 'month' as const, active: false }],
])('refuses a stored price whose %s differs from the approved offer', async (_name, price) => {
  const f = fixture(price);
  const create = jest.spyOn(f.peable.client.customers, 'create');
  await expect(f.provider.prepare?.(f.input)).rejects.toThrow('differs from the approved offer');
  expect(create).not.toHaveBeenCalled();
});

it('rejects wrong credentials before any customer effect', async () => {
  const f = fixture();
  const create = jest.spyOn(f.peable.client.customers, 'create');
  jest
    .spyOn(f.peable.client.merchants, 'retrieve')
    .mockResolvedValue({ ...merchant, oxy_app_id: 'other' } as never);
  await expect(f.provider.prepare?.(f.input)).rejects.toThrow('credential owner differs');
  expect(create).not.toHaveBeenCalled();
});

it.each([
  ['offer', { offerId: 'other' }],
  ['price', { priceId: 'price_other' }],
  ['amount', { amountMinorUnits: 1 }],
  ['namespace', { mode: 'test' }],
  ['merchant', { providerAccountRef: 'merch_other' }],
])('refuses a %s selection that is not the approved offer', async (_name, change) => {
  const f = fixture();
  await expect(f.provider.prepare?.({ ...f.input, ...change })).rejects.toThrow(
    'selection differs',
  );
});

it('rejects a missing or foreign snapshot and an altered replay key', async () => {
  const f = fixture();
  const snapshot = await f.provider.prepare?.(f.input);
  if (!snapshot) throw new Error('snapshot missing');
  const sessionCreate = jest.spyOn(f.peable.client.checkout.sessions, 'create');
  for (const input of [
    f.input,
    { ...f.input, snapshot: { ...snapshot, subjectAccountId: 'other' } },
    { ...f.input, snapshot: { ...snapshot, customerId: 'not-a-customer' } },
    { ...f.input, snapshot, idempotencyKey: 'personal-checkout:other' },
  ])
    await expect(f.provider.create(input)).rejects.toThrow('snapshot differs');
  expect(sessionCreate).not.toHaveBeenCalled();
});

it('refuses a session Orbit priced differently from the approved offer', async () => {
  const f = fixture();
  const snapshot = await f.provider.prepare?.(f.input);
  if (!snapshot) throw new Error('snapshot missing');
  const real = f.peable.client.checkout.sessions.create.bind(f.peable.client.checkout.sessions);
  jest
    .spyOn(f.peable.client.checkout.sessions, 'create')
    .mockImplementationOnce(async (...args) => ({ ...(await real(...args)), amount_total: '600' }));
  await expect(f.provider.create({ ...f.input, snapshot })).rejects.toThrow(
    'differs from the approved offer',
  );
});

it('keeps purchases closed outside tests until the deployment enables them', async () => {
  const f = fixture();
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const closed = createPeablePersonalCheckoutProvider(f.peable.client, f.configuration);
    const retrieve = jest.spyOn(f.peable.client.merchants, 'retrieve');
    await expect(closed.prepare?.(f.input)).rejects.toThrow('purchases are disabled');
    await expect(closed.create(f.input)).rejects.toThrow('purchases are disabled');
    expect(retrieve).not.toHaveBeenCalled();
  } finally {
    process.env.NODE_ENV = previous;
  }
});

it('validates a saved session against its customer before exposing its URL', async () => {
  const f = fixture();
  const snapshot = await f.provider.prepare?.(f.input);
  if (!snapshot) throw new Error('snapshot missing');
  const session = await f.provider.create({ ...f.input, snapshot });
  await expect(
    f.provider.validateExistingCheckout?.(snapshot, session.sessionId),
  ).resolves.toBeUndefined();
  await expect(
    f.provider.validateExistingCheckout?.(
      { ...snapshot, customerId: 'cus_other' },
      session.sessionId,
    ),
  ).rejects.toThrow('binding differs');
});
