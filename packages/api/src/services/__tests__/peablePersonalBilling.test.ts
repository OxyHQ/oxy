import {
  cancelOwnedPeableSubscription,
  readNativeSubscription,
  type PeableSubscription,
} from '../peablePersonalBilling.service';
import { nativePeable } from '../__fixtures__/nativePeable';

const unix = (iso: string) => Date.parse(iso) / 1000;
const period = { start: unix('2026-10-01T00:00:00Z'), end: unix('2026-11-01T00:00:00Z') };

function fixture() {
  const peable = nativePeable({
    merchant: { id: 'merch_fixture', oxy_app_id: 'app', environment: 'test' },
    livemode: false,
  });
  const price = peable.price({ unitAmount: 599, interval: 'month' });
  peable.raw.customers.set('cus_payer', {
    id: 'cus_payer',
    object: 'customer',
    livemode: false,
    metadata: { oxy_account_id: 'payer' },
  });
  const session = peable.raw.sessions;
  session.set('cs_fixture', {
    id: 'cs_fixture',
    customer: 'cus_payer',
    price: price.id,
    status: 'open',
    metadata: {},
  });
  const { subscription } = peable.complete('cs_fixture', period);
  const owned = {
    payerAccountId: 'payer',
    providerSubscriptionId: subscription.id as string,
    providerCustomerId: 'cus_payer',
    providerPriceId: price.id,
    livemode: false,
  };
  const update = jest.spyOn(peable.client.subscriptions, 'update');
  const retrieve = jest.spyOn(peable.client.subscriptions, 'retrieve');
  return { peable, owned, update, retrieve, subscription };
}

it('verifies payer and exact native ownership before cancellation', async () => {
  const f = fixture();
  await expect(
    cancelOwnedPeableSubscription(f.peable.client, 'other', f.owned, 'action_1'),
  ).rejects.toThrow('payer');
  expect(f.retrieve).not.toHaveBeenCalled();
  for (const field of ['providerCustomerId', 'providerPriceId'] as const) {
    await expect(
      cancelOwnedPeableSubscription(
        f.peable.client,
        'payer',
        { ...f.owned, [field]: 'other' },
        'action_1',
      ),
    ).rejects.toThrow('ownership');
  }
  await expect(
    cancelOwnedPeableSubscription(
      f.peable.client,
      'payer',
      { ...f.owned, livemode: true },
      'a_1234567',
    ),
  ).rejects.toThrow('ownership');
  expect(f.update).not.toHaveBeenCalled();
});

it('schedules the existing period with a stable replay key and never extends it', async () => {
  const f = fixture();
  const first = await cancelOwnedPeableSubscription(f.peable.client, 'payer', f.owned, 'action_1');
  expect(first.cancelAtPeriodEnd).toBe(true);
  expect(first.currentPeriodEnd).toBe(period.end);
  expect(f.update).toHaveBeenCalledTimes(1);
  const [, params, options] = f.update.mock.calls[0];
  expect(params).toEqual({ cancel_at_period_end: true });
  expect(options?.idempotencyKey).toMatch(/^oxy-personal-cancel:[0-9a-f]{64}$/);
  // Already scheduled: a replay reads and returns without a second write.
  await cancelOwnedPeableSubscription(f.peable.client, 'payer', f.owned, 'action_1');
  expect(f.update).toHaveBeenCalledTimes(1);
});

it.each(['canceled', 'incomplete', 'incomplete_expired', 'paused'])(
  'refuses to schedule cancellation of a %s subscription',
  async (status) => {
    const f = fixture();
    f.peable.setSubscription(f.owned.providerSubscriptionId, { status });
    await expect(
      cancelOwnedPeableSubscription(f.peable.client, 'payer', f.owned, 'action_1'),
    ).rejects.toThrow('period unavailable');
    expect(f.update).not.toHaveBeenCalled();
  },
);

it('refuses a cancellation the engine answered for another period', async () => {
  const f = fixture();
  f.update.mockImplementationOnce(async () => ({
    ...(f.subscription as unknown as PeableSubscription),
    cancel_at_period_end: true,
    current_period_end: period.end + 86_400,
  }));
  await expect(
    cancelOwnedPeableSubscription(f.peable.client, 'payer', f.owned, 'action_1'),
  ).rejects.toThrow('period differs');
});

it('reads only a one-item, quantity-one, single-interval subscription', () => {
  const { subscription } = fixture();
  const base = subscription as unknown as PeableSubscription;
  expect(readNativeSubscription(base).checkoutSessionId).toBe('cs_fixture');
  const item = base.items.data[0];
  for (const broken of [
    { ...base, items: { ...base.items, data: [item, item] } },
    { ...base, items: { ...base.items, data: [{ ...item, quantity: 2 }] } },
    {
      ...base,
      items: {
        ...base.items,
        data: [
          {
            ...item,
            price: { ...item.price, recurring: { ...item.price.recurring, interval_count: 3 } },
          },
        ],
      },
    },
    { ...base, current_period_end: base.current_period_start },
  ])
    expect(() => readNativeSubscription(broken as PeableSubscription)).toThrow(
      'not a personal plan subscription',
    );
});
