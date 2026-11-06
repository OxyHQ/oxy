import { randomBytes } from 'node:crypto';
import type { Peable } from '@peable.to/sdk';

/**
 * An in-memory stand-in for the native Orbit objects Oxy's personal-plan runtime
 * reads (ADR 0018): customers, prices, Checkout Sessions in `subscription` mode,
 * subscriptions, invoices, their PaymentIntents and the customer portal. Shapes
 * follow `@peable.to/contracts` for every field the runtime reads; the helpers
 * play the engine's part (a payer completing checkout, a renewal, a refund).
 */
type Json = Record<string, unknown>;
export interface NativePeableOptions {
  merchant: { id: string; oxy_app_id: string; environment: string };
  livemode: boolean;
  now?: () => number;
}
export function nativePeable(options: NativePeableOptions) {
  const now = () => Math.floor((options.now?.() ?? Date.now()) / 1000);
  const livemode = options.livemode;
  let counter = 0;
  // Unique across fixtures: every test file shares one database.
  const run = randomBytes(6).toString('hex');
  const id = (prefix: string) => `${prefix}_${run}${(++counter).toString().padStart(4, '0')}`;
  const customers = new Map<string, Json>();
  const prices = new Map<string, Json>();
  const sessions = new Map<string, Json>();
  const subscriptions = new Map<string, Json>();
  const invoices = new Map<string, Json>();
  const payments = new Map<string, Json>();
  const replay = new Map<string, unknown>();
  const notFound = (what: string) => Object.assign(new Error(`No such ${what}`), { statusCode: 404 });
  const once = <T>(key: string | undefined, make: () => T): T => {
    if (!key) return make();
    if (!replay.has(key)) replay.set(key, make());
    return replay.get(key) as T;
  };
  const get = (map: Map<string, Json>, key: string, what: string) => {
    const value = map.get(key);
    if (!value) throw notFound(what);
    return structuredClone(value);
  };
  const list = (data: Json[]) => ({ object: 'list', data: structuredClone(data), has_more: false });
  const metadataQuery = (query: string) => {
    const match = /^metadata\['([^']+)'\]:'([^']+)'$/.exec(query);
    if (!match) throw new Error(`Unsupported search ${query}`);
    return (row: Json) => (row.metadata as Record<string, string>)[match[1]] === match[2];
  };

  function price(input: {
    unitAmount: number;
    interval: 'month' | 'year';
    currency?: string;
    taxBehavior?: 'inclusive' | 'exclusive' | 'unspecified';
    active?: boolean;
  }) {
    const row = {
      id: id('price'),
      object: 'price',
      livemode,
      active: input.active ?? true,
      product: id('prod'),
      currency: input.currency ?? 'USD',
      unit_amount: String(input.unitAmount),
      billing_scheme: 'per_unit',
      type: 'recurring',
      recurring: { interval: input.interval, interval_count: 1, usage_type: 'licensed', meter: null },
      tax_behavior: input.taxBehavior ?? 'inclusive',
      lookup_key: null,
      metadata: {},
    };
    prices.set(row.id, row);
    return row;
  }

  function invoiceFor(
    subscription: Json,
    input: { reason: string; start: number; end: number; paidAt: number | null; amount?: string },
  ) {
    const item = (subscription.items as { data: Json[] }).data[0];
    const priceRow = item.price as Json;
    const amount = input.amount ?? (priceRow.unit_amount as string);
    const invoiceId = id('in');
    const paymentId = id('pi');
    payments.set(paymentId, {
      id: paymentId,
      object: 'payment_intent',
      livemode,
      customer: subscription.customer,
      amount,
      amount_received: input.paidAt === null ? '0' : amount,
      amount_refunded: '0',
      latest_charge: input.paidAt === null ? null : id('ch'),
      status: input.paidAt === null ? 'requires_payment_method' : 'succeeded',
      metadata: { invoice: invoiceId },
    });
    const tax = String(Math.floor(Number(amount) / 6));
    const invoice = {
      id: invoiceId,
      object: 'invoice',
      livemode,
      customer: subscription.customer,
      subscription: subscription.id,
      status: input.paidAt === null ? 'open' : 'paid',
      billing_reason: input.reason,
      currency: priceRow.currency,
      lines: {
        object: 'list',
        has_more: false,
        data: [
          {
            id: id('il'),
            object: 'line_item',
            type: 'subscription',
            amount,
            currency: priceRow.currency,
            period: { start: input.start, end: input.end },
            price: structuredClone(priceRow),
            quantity: 1,
            proration: false,
            subscription: subscription.id,
            subscription_item: item.id,
          },
        ],
      },
      total: amount,
      tax,
      total_excluding_tax: String(Number(amount) - Number(tax)),
      amount_due: amount,
      amount_paid: input.paidAt === null ? '0' : amount,
      payment_intent: paymentId,
      status_transitions: { paid_at: input.paidAt },
      metadata: {},
    };
    invoices.set(invoiceId, invoice);
    subscription.latest_invoice = invoiceId;
    return invoice;
  }

  const client = {
    merchants: { retrieve: async () => structuredClone(options.merchant) },
    customers: {
      search: async ({ query }: { query: string }) =>
        list([...customers.values()].filter(metadataQuery(query))),
      create: async (params: Json, request?: { idempotencyKey?: string }) =>
        structuredClone(
          once(request?.idempotencyKey, () => {
            const row = {
              id: id('cus'),
              object: 'customer',
              livemode,
              metadata: { ...(params.metadata as object) },
            };
            customers.set(row.id, row);
            return row;
          }),
        ),
      retrieve: async (key: string) => get(customers, key, 'customer'),
    },
    prices: { retrieve: async (key: string) => get(prices, key, 'price') },
    checkout: {
      sessions: {
        create: async (params: Json, request?: { idempotencyKey?: string }) => {
          // Peable 4 (ADR 0021): FairCoin is offered on every order and a
          // session that would remove it is refused, as the gateway does.
          const types = params.payment_method_types as string[] | undefined;
          if (types && !types.includes('faircoin'))
            throw Object.assign(new Error('FairCoin cannot be removed from an order'), {
              statusCode: 400,
              code: 'payment_method_locked',
            });
          return structuredClone(
            once(request?.idempotencyKey, () => {
              const line = (params.line_items as Json[])[0];
              const priceRow = get(prices, line.price as string, 'price');
              const sessionId = id('cs');
              const row = {
                id: sessionId,
                object: 'checkout_session',
                livemode,
                mode: params.mode,
                status: 'open',
                payment_status: 'unpaid',
                customer: params.customer,
                client_reference_id: params.client_reference_id ?? null,
                amount_total: priceRow.unit_amount,
                currency: priceRow.currency,
                rail: 'card',
                network: livemode ? 'mainnet' : 'testnet',
                payment_method_types: types ?? ['card', 'faircoin'],
                url: `https://checkout.peable.to/c/${sessionId}#cs=${sessionId}_secret_fixture`,
                expires_at: now() + 86_400,
                metadata: { ...(params.metadata as object) },
                price: priceRow.id,
              };
              sessions.set(row.id, row);
              return row;
            }),
          );
        },
        retrieve: async (key: string) => get(sessions, key, 'checkout session'),
        list: async ({ customer }: { customer?: string }) =>
          list([...sessions.values()].filter((row) => !customer || row.customer === customer)),
      },
    },
    subscriptions: {
      retrieve: async (key: string) => get(subscriptions, key, 'subscription'),
      update: async (key: string, params: Json) => {
        const row = subscriptions.get(key);
        if (!row) throw notFound('subscription');
        Object.assign(row, params);
        return structuredClone(row);
      },
      search: async ({ query }: { query: string }) =>
        list([...subscriptions.values()].filter(metadataQuery(query))),
    },
    invoices: {
      retrieve: async (key: string) => get(invoices, key, 'invoice'),
      list: async ({ subscription }: { subscription?: string }) =>
        list(
          [...invoices.values()].filter((row) => !subscription || row.subscription === subscription),
        ),
    },
    paymentIntents: { retrieve: async (key: string) => get(payments, key, 'payment intent') },
    billingPortal: {
      sessions: {
        create: async (params: Json) => ({
          id: id('bps'),
          object: 'billing_portal.session',
          customer: params.customer,
          return_url: params.return_url,
          url: `https://checkout.peable.to/portal/${counter}`,
        }),
      },
    },
    webhooks: {
      constructEvent: (raw: string, signature: string, secret: string) => {
        if (signature !== `valid:${secret}`) throw new Error('Invalid Peable signature');
        return JSON.parse(raw);
      },
    },
  };

  return {
    client: client as unknown as Peable,
    raw: { customers, prices, sessions, subscriptions, invoices, payments },
    price,
    /** The payer confirms and pays: the engine starts the subscription and pays its first invoice. */
    complete(sessionId: string, input: { start: number; end: number; paidAt?: number | null }) {
      const session = sessions.get(sessionId);
      if (!session) throw notFound('checkout session');
      const priceRow = get(prices, session.price as string, 'price');
      const subscription: Json = {
        id: id('sub'),
        object: 'subscription',
        livemode,
        customer: session.customer,
        status: input.paidAt === null ? 'incomplete' : 'active',
        currency: priceRow.currency,
        items: {
          object: 'list',
          has_more: false,
          data: [{ id: id('si'), object: 'subscription_item', price: priceRow, quantity: 1 }],
        },
        current_period_start: input.start,
        current_period_end: input.end,
        cancel_at_period_end: false,
        trial_end: null,
        latest_invoice: null,
        metadata: { checkout_session: sessionId },
      };
      subscriptions.set(subscription.id as string, subscription);
      const invoice = invoiceFor(subscription, {
        reason: 'subscription_create',
        start: input.start,
        end: input.end,
        paidAt: input.paidAt === undefined ? input.start : input.paidAt,
      });
      session.status = 'complete';
      session.payment_status = input.paidAt === null ? 'unpaid' : 'paid';
      session.payment_intent = invoice.payment_intent;
      return { subscription: structuredClone(subscription), invoice: structuredClone(invoice) };
    },
    /** The engine renews: a new period and its invoice. */
    renew(subscriptionId: string, input: { start: number; end: number; paidAt?: number | null }) {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw notFound('subscription');
      subscription.current_period_start = input.start;
      subscription.current_period_end = input.end;
      return structuredClone(
        invoiceFor(subscription, {
          reason: 'subscription_cycle',
          start: input.start,
          end: input.end,
          paidAt: input.paidAt === undefined ? input.start : input.paidAt,
        }),
      );
    },
    refund(invoiceId: string, amount: string) {
      const invoice = invoices.get(invoiceId);
      if (!invoice) throw notFound('invoice');
      const payment = payments.get(invoice.payment_intent as string);
      if (!payment) throw notFound('payment intent');
      payment.amount_refunded = amount;
      return structuredClone(payment);
    },
    expire(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) throw notFound('checkout session');
      session.status = 'expired';
    },
    setSubscription(subscriptionId: string, patch: Json) {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw notFound('subscription');
      Object.assign(subscription, patch);
    },
    event(type: string, object: Json) {
      return JSON.stringify({ id: id('evt'), object: 'event', type, livemode, data: { object } });
    },
  };
}
