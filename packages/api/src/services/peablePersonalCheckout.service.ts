import { integerCheck, safeNumberCheck, urlCheck, utf16MinLength } from '@oxy.so/contracts';
import { createHash } from 'node:crypto';
import type { Peable } from '@peable.to/sdk';
import { z } from 'zod';
import { billingNamespaceSchema } from '../config/billingNamespace';
import {
  peableAmountSchema,
  peableInstantToIso,
  peableReference,
} from './peablePersonalBilling.service';
import type {
  PersonalCheckoutProvider,
  PersonalCheckoutSnapshot,
} from './personalPlanCheckout.service';

export const peablePersonalCheckoutConfigurationSchema = z
  .object({
    merchantId: z.string().check(utf16MinLength(1)),
    applicationId: z.string().check(utf16MinLength(1)),
    namespace: billingNamespaceSchema,
    returnUrl: z
      .string()
      .check(urlCheck())
      .refine((value) => new URL(value).protocol === 'https:'),
    offers: z
      .array(
        z
          .object({
            offerId: z.string().check(utf16MinLength(1)),
            offerVersion: z.number().check(integerCheck()).positive(),
            priceId: z.string().regex(/^price_[A-Za-z0-9_]+$/),
            amountMinorUnits: z.number().check(integerCheck()).positive().check(safeNumberCheck()),
            currency: z.literal('USD'),
            interval: z.enum(['month', 'year']),
            trial: z.literal('none'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** The Oxy account a native customer belongs to — written once at creation and
 * the only key Oxy ever looks a customer up by. */
export const PEABLE_CUSTOMER_ACCOUNT_KEY = 'oxy_account_id';
const accountIdForQuery = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);

type CheckoutClient = Pick<Peable, 'merchants' | 'customers' | 'prices' | 'checkout'>;

/** Explicit deployment opt-in. Orbit prices the order (Peable Tax, fail closed)
 * and its own checkout collects the payment; Oxy only freezes the approved
 * selection and checks that Orbit priced exactly that. */
export function createPeablePersonalCheckoutProvider(
  client: CheckoutClient,
  rawConfiguration: z.input<typeof peablePersonalCheckoutConfigurationSchema>,
  clock: () => Date = () => new Date(),
  dependencies: { purchasesEnabled?: boolean } = {},
): PersonalCheckoutProvider {
  const configuration = peablePersonalCheckoutConfigurationSchema.parse(rawConfiguration);
  const assertEnabled = () => {
    if (process.env.NODE_ENV !== 'test' && dependencies.purchasesEnabled !== true)
      throw new Error('Peable purchases are disabled');
  };
  const select = (input: Parameters<PersonalCheckoutProvider['create']>[0]) => {
    const selection = configuration.offers.filter(
      (offer) =>
        offer.offerId === input.offerId &&
        offer.offerVersion === input.offerVersion &&
        offer.priceId === input.priceId &&
        offer.amountMinorUnits === input.amountMinorUnits &&
        offer.currency === input.currency.toUpperCase() &&
        offer.interval === input.interval &&
        offer.trial === input.trial,
    );
    if (
      selection.length !== 1 ||
      input.providerAccountRef !== configuration.merchantId ||
      input.mode !== configuration.namespace.mode ||
      input.environment !== configuration.namespace.environment
    )
      throw new Error('Peable checkout selection differs');
    return selection[0];
  };
  const assertMerchant = async () => {
    const merchant = await client.merchants.retrieve();
    if (
      merchant.id !== configuration.merchantId ||
      merchant.oxy_app_id !== configuration.applicationId ||
      merchant.environment !== configuration.namespace.environment
    )
      throw new Error('Peable checkout credential owner differs');
  };
  const livemode = configuration.namespace.mode === 'live';
  /** The stored price must still be exactly the approved offer: an Orbit price
   * never changes what it charges, so this pins the amount, cadence and tax
   * treatment Oxy publishes to the row checkout will charge. */
  const assertPrice = async (offer: (typeof configuration.offers)[number]) => {
    const price = await client.prices.retrieve(offer.priceId);
    if (
      price.id !== offer.priceId ||
      !price.active ||
      price.livemode !== livemode ||
      price.type !== 'recurring' ||
      price.billing_scheme !== 'per_unit' ||
      price.unit_amount !== String(offer.amountMinorUnits) ||
      price.currency.toUpperCase() !== offer.currency ||
      price.recurring?.interval !== offer.interval ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== 'licensed' ||
      price.tax_behavior !== 'inclusive'
    )
      throw new Error('Peable price differs from the approved offer');
  };
  /** One native customer per Oxy account and merchant namespace, found by its
   * account key. The Idempotency-Key only covers a crash inside its 24-hour
   * replay window; after that, the search finds the customer it created. */
  const ensureCustomer = async (subjectAccountId: string) => {
    const account = accountIdForQuery.parse(subjectAccountId);
    const found = await client.customers.search({
      query: `metadata['${PEABLE_CUSTOMER_ACCOUNT_KEY}']:'${account}'`,
      limit: 2,
    });
    const matches = found.data.filter(
      (customer) =>
        customer.metadata[PEABLE_CUSTOMER_ACCOUNT_KEY] === account &&
        customer.livemode === livemode,
    );
    if (matches.length > 1 || found.has_more)
      throw new Error('Peable customer mapping is ambiguous');
    if (matches[0]) return matches[0].id;
    const key = createHash('sha256')
      .update(JSON.stringify([configuration.merchantId, configuration.namespace, account]))
      .digest('hex');
    const created = await client.customers.create(
      { metadata: { [PEABLE_CUSTOMER_ACCOUNT_KEY]: account } },
      { idempotencyKey: `oxy-personal-customer:${key}` },
    );
    if (created.metadata[PEABLE_CUSTOMER_ACCOUNT_KEY] !== account || created.livemode !== livemode)
      throw new Error('Peable customer mapping differs');
    return created.id;
  };
  const sessionSchema = z.object({
    id: z.string().regex(/^cs_[A-Za-z0-9_]+$/),
    url: z
      .string()
      .check(urlCheck())
      .refine((value) => new URL(value).protocol === 'https:'),
    expires_at: z.number(),
  });
  return {
    kind: 'peable',
    async validateExistingCheckout(snapshot, sessionId) {
      await assertMerchant();
      if (
        snapshot.merchantId !== configuration.merchantId ||
        snapshot.applicationId !== configuration.applicationId ||
        snapshot.mode !== configuration.namespace.mode ||
        snapshot.environment !== configuration.namespace.environment
      )
        throw new Error('Peable checkout credential owner differs');
      const session = await client.checkout.sessions.retrieve(sessionId);
      if (
        session.id !== sessionId ||
        session.mode !== 'subscription' ||
        peableReference(session.customer) !== snapshot.customerId
      )
        throw new Error('Peable checkout session binding differs');
    },
    async prepare(input) {
      assertEnabled();
      const offer = select(input);
      await assertMerchant();
      await assertPrice(offer);
      const customerId = await ensureCustomer(input.subjectAccountId);
      const snapshot: PersonalCheckoutSnapshot = {
        applicationId: configuration.applicationId,
        merchantId: configuration.merchantId,
        subjectAccountId: input.subjectAccountId,
        customerId,
        offerId: input.offerId,
        offerVersion: input.offerVersion,
        priceId: input.priceId,
        mode: configuration.namespace.mode,
        environment: configuration.namespace.environment,
        returnUrl: configuration.returnUrl,
      };
      return snapshot;
    },
    async create(input) {
      assertEnabled();
      const offer = select(input);
      const snapshot = input.snapshot;
      if (
        !snapshot ||
        snapshot.applicationId !== configuration.applicationId ||
        snapshot.merchantId !== configuration.merchantId ||
        snapshot.subjectAccountId !== input.subjectAccountId ||
        snapshot.offerId !== input.offerId ||
        snapshot.offerVersion !== input.offerVersion ||
        snapshot.priceId !== input.priceId ||
        snapshot.mode !== input.mode ||
        snapshot.environment !== input.environment ||
        !/^cus_[A-Za-z0-9_]+$/.test(snapshot.customerId) ||
        !z
          .string()
          .check(urlCheck())
          .refine((value) => new URL(value).protocol === 'https:')
          .safeParse(snapshot.returnUrl).success ||
        input.idempotencyKey !== `personal-checkout:${input.intentId}`
      )
        throw new Error('Peable persisted checkout snapshot differs');
      // No `payment_method_types`: Peable offers the merchant's fiat methods
      // AND FairCoin on every order (Peable ADR 0021), and a list without
      // `faircoin` is refused (`payment_method_locked`). The payer chooses.
      const session = await client.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: snapshot.customerId,
          line_items: [{ price: snapshot.priceId, quantity: 1 }],
          automatic_tax: { enabled: true },
          success_url: snapshot.returnUrl,
          cancel_url: snapshot.returnUrl,
          client_reference_id: input.intentId,
          metadata: {
            oxy_checkout_intent: input.intentId,
            [PEABLE_CUSTOMER_ACCOUNT_KEY]: input.subjectAccountId,
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      const parsed = sessionSchema.parse(session);
      // Orbit priced the order; it must ask for exactly the approved price.
      if (
        session.mode !== 'subscription' ||
        peableReference(session.customer) !== snapshot.customerId ||
        session.client_reference_id !== input.intentId ||
        peableAmountSchema.parse(session.amount_total) !== String(offer.amountMinorUnits) ||
        session.currency.toUpperCase() !== offer.currency
      )
        throw new Error('Peable checkout session differs from the approved offer');
      if (parsed.expires_at * 1000 <= clock().getTime())
        throw new Error('Peable checkout session expired');
      return {
        sessionId: parsed.id,
        checkoutUrl: parsed.url,
        expiresAt: peableInstantToIso(parsed.expires_at),
      };
    },
  };
}
