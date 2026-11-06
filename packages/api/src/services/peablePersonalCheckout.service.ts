import { peableInstantToIso, peableUnixSecondsSchema } from './peablePersonalBilling.service';
import {
  integerCheck,
  oxyAccountIdSchema,
  isoDateTime,
  safeNumberCheck,
  urlCheck,
  utf16MaxLength,
  utf16MinLength,
} from '@oxy.so/contracts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PeableError, type BillingTaxQuote, type Peable } from '@peable.to/sdk';
import { ApiError } from '../utils/error';
import { z } from 'zod';
import { billingNamespaceSchema } from '../config/billingNamespace';
import type {
  PersonalCheckoutProvider,
  PersonalCheckoutSnapshot,
} from './personalPlanCheckout.service';

/** The SDK classifies HTTP errors and preserves the gateway's machine message.
 * A review response is not an outage, expiry, or authorization to pay again. */
function checkoutFailure(error: unknown): never {
  if (
    error instanceof PeableError &&
    error.statusCode === 409 &&
    error.code === 'reconciliation_required'
  )
    throw new ApiError(
      409,
      'Payment needs review in Peable before another payment',
      'PAYMENT_REVIEW_REQUIRED',
    );
  throw error;
}

export const peablePersonalCheckoutConfigurationSchema = z
  .object({
    embeddedEnabled: z.boolean().optional(),
    merchantId: z.string().check(utf16MinLength(1)),
    applicationId: z.string().check(utf16MinLength(1)),
    namespace: billingNamespaceSchema,
    sellerId: z.string().check(utf16MinLength(1)),
    invoiceIssuerId: z.string().check(utf16MinLength(1)),
    taxRemitterId: z.string().check(utf16MinLength(1)),
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
            priceId: z.string().check(utf16MinLength(1)),
            planId: z.string().check(utf16MinLength(1)),
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

/** Explicit deployment opt-in; all customer, fiscal and price bindings still verify. */
export function createPeablePersonalCheckoutProvider(
  client: Pick<Peable, 'merchants' | 'billing'> & Partial<Pick<Peable, 'tax'>>,
  rawConfiguration: z.input<typeof peablePersonalCheckoutConfigurationSchema>,
  clock: () => Date = () => new Date(),
  dependencies?: {
    purchasesEnabled?: boolean;
    resolveCustomerLocationEvidence(subjectAccountId: string): Promise<{
      customerLocationEvidenceId: string;
    }>;
  },
): PersonalCheckoutProvider {
  const configuration = peablePersonalCheckoutConfigurationSchema.parse(rawConfiguration);
  const assertEnabled = () => {
    if (process.env.NODE_ENV !== 'test' && dependencies?.purchasesEnabled !== true)
      throw new Error('Peable final purchase authority is unconfigured');
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
  const validateQuote = (
    quote: BillingTaxQuote,
    subjectAccountId: string,
    planId: string,
    amountMinorUnits: number,
  ) => {
    const now = clock().getTime();
    if (
      quote.schema_version !== 3 ||
      quote.source.merchant_id !== configuration.merchantId ||
      quote.source.app_id !== configuration.applicationId ||
      quote.source.store_id !== subjectAccountId ||
      quote.source.plan_id !== planId ||
      quote.source.mode !== configuration.namespace.mode ||
      quote.source.environment !== configuration.namespace.environment ||
      quote.quote.currency !== 'USD' ||
      quote.quote.gross_minor_units !== String(amountMinorUnits) ||
      quote.quote.tax_treatment !== 'inclusive' ||
      !/^(0|[1-9][0-9]*)$/.test(quote.quote.net_minor_units) ||
      !/^(0|[1-9][0-9]*)$/.test(quote.quote.tax_minor_units) ||
      BigInt(quote.quote.net_minor_units) + BigInt(quote.quote.tax_minor_units) !==
        BigInt(amountMinorUnits) ||
      quote.quote.seller_id !== configuration.sellerId ||
      quote.quote.invoice_issuer_id !== configuration.invoiceIssuerId ||
      quote.quote.tax_remitter_id !== configuration.taxRemitterId ||
      !peableUnixSecondsSchema.safeParse(quote.quote.quoted_at).success ||
      quote.quote.quoted_at * 1000 > now ||
      !peableUnixSecondsSchema.safeParse(quote.quote.expires_at).success ||
      quote.quote.expires_at * 1000 <= now
    )
      throw new Error('Peable checkout tax quote differs or expired');
  };
  return {
    kind: 'peable',
    supportsEmbedded: configuration.embeddedEnabled === true,
    async readConfiguration() {
      assertEnabled();
      if (!configuration.embeddedEnabled) throw new Error('Embedded checkout unconfigured');
      const value = await client.billing.embeddedCheckoutConfiguration();
      if (
        value.scope.merchant_id !== configuration.merchantId ||
        value.scope.app_id !== configuration.applicationId ||
        value.scope.mode !== configuration.namespace.mode ||
        value.scope.environment !== configuration.namespace.environment
      )
        throw new Error('Peable configuration authority differs');
      return {
        merchantId: configuration.merchantId,
        mode: configuration.namespace.mode,
        environment: configuration.namespace.environment,
        publishableKey: value.publishable_key,
        paymentMethods: value.payment_methods,
        offers: configuration.offers.map((offer) => ({
          offerId: offer.offerId,
          offerVersion: offer.offerVersion,
          amountMinorUnits: offer.amountMinorUnits,
          currency: offer.currency,
          interval: offer.interval,
        })),
      };
    },
    async readEmbedded(input, sessionId) {
      assertEnabled();
      if (!configuration.embeddedEnabled || !input.snapshot || !input.productId)
        throw new Error('Embedded checkout authority unavailable');
      select(input);
      const snapshot = input.snapshot;
      const value = await client.billing.retrieveEmbeddedCheckoutAction(sessionId);
      if (
        value.scope.merchant_id !== snapshot.merchantId ||
        value.scope.app_id !== snapshot.applicationId ||
        value.scope.store_id !== snapshot.subjectAccountId ||
        value.scope.plan_id !== snapshot.planId ||
        value.scope.provider_customer_id !== snapshot.customerId ||
        value.scope.provider_price_id !== snapshot.priceId ||
        value.scope.mode !== snapshot.mode ||
        value.scope.environment !== snapshot.environment ||
        !isDeepStrictEqual(value.tax_quote, snapshot.taxQuote)
      )
        throw new Error('Peable embedded checkout owner or quote differs');
      const action = value.action;
      if (!action) {
        if (value.status === 'open') throw new Error('Open checkout capability unavailable');
        return { status: value.status };
      }
      if (
        value.status !== 'open' ||
        !Number.isSafeInteger(value.expires_at) ||
        value.expires_at * 1000 <= clock().getTime() ||
        action.kind !== 'checkout_session' ||
        action.session_id !== sessionId ||
        action.amount_minor_units !== input.amountMinorUnits ||
        action.currency.toUpperCase() !== input.currency.toUpperCase()
      )
        throw new Error('Peable embedded payment action differs');
      return {
        status: value.status,
        checkout: {
          transport: 'checkout_session',
          subjectAccountId: oxyAccountIdSchema.parse(input.subjectAccountId),
          productId: input.productId,
          offerId: input.offerId,
          offerVersion: input.offerVersion,
          merchantId: snapshot.merchantId,
          mode: configuration.namespace.mode,
          environment: configuration.namespace.environment,
          sessionId,
          clientSecret: action.client_secret,
          publishableKey: action.publishable_key,
          currency: 'USD',
          amountMinorUnits: input.amountMinorUnits,
          interval: input.interval,
          tax: {
            subtotalMinorUnits: snapshot.taxQuote.quote.net_minor_units,
            taxMinorUnits: snapshot.taxQuote.quote.tax_minor_units,
            totalMinorUnits: snapshot.taxQuote.quote.gross_minor_units,
            inclusive: true,
          },
        },
      };
    },
    async validateExistingCheckout(snapshot, sessionId) {
      const merchant = await client.merchants.retrieve();
      if (
        merchant.id !== configuration.merchantId ||
        merchant.oxy_app_id !== configuration.applicationId ||
        merchant.environment !== configuration.namespace.environment ||
        snapshot.merchantId !== configuration.merchantId ||
        snapshot.applicationId !== configuration.applicationId ||
        snapshot.mode !== configuration.namespace.mode ||
        snapshot.environment !== configuration.namespace.environment
      )
        throw new Error('Peable checkout credential owner differs');
      const session = await client.billing.retrieveCheckout(sessionId).catch(checkoutFailure);
      if (
        session.id !== sessionId ||
        session.store_id !== snapshot.subjectAccountId ||
        session.plan_id !== snapshot.planId ||
        session.provider_customer_id !== snapshot.customerId ||
        session.provider_price_id !== snapshot.priceId
      )
        throw new Error('Peable checkout observation binding differs');
    },
    async prepare(input) {
      assertEnabled();
      const offer = select(input);
      if (!dependencies && !input.billingAddress)
        throw new Error('Peable trusted customer location is unconfigured');
      const merchant = await client.merchants.retrieve();
      if (
        merchant.id !== configuration.merchantId ||
        merchant.oxy_app_id !== configuration.applicationId ||
        merchant.environment !== configuration.namespace.environment
      )
        throw new Error('Peable checkout credential owner differs');
      const customerKey = createHash('sha256')
        .update(
          JSON.stringify([
            configuration.merchantId,
            configuration.applicationId,
            configuration.namespace,
            input.subjectAccountId,
          ]),
        )
        .digest('hex');
      const customer = await client.billing.ensureCustomer(
        {
          store_id: input.subjectAccountId,
          store_name: input.subjectAccountId,
        },
        { idempotencyKey: `oxy-one-customer:${customerKey}` },
      );
      if (!customer.provider_customer_id) throw new Error('Peable checkout customer unavailable');
      const address = input.billingAddress;
      const location = address
        ? await (async () => {
            if (!client.tax) throw new Error('Peable payer location collection unavailable');
            const evidence = await client.tax.locationEvidence.create({
              customer_ref: input.subjectAccountId,
              evidence: [
                {
                  type: 'billing_address',
                  address: {
                    country: address.country,
                    state: address.state,
                    postal_code: address.postalCode,
                    city: address.city,
                    line1: address.line1,
                    line2: address.line2,
                  },
                },
              ],
            });
            if (
              evidence.customer_ref !== input.subjectAccountId ||
              evidence.status !== 'sufficient' ||
              evidence.livemode !== (configuration.namespace.mode === 'live') ||
              evidence.expires_at * 1000 <= clock().getTime()
            )
              throw new ApiError(
                422,
                'More billing location evidence is required',
                'BILLING_LOCATION_EVIDENCE_REQUIRED',
              );
            return { customerLocationEvidenceId: evidence.id };
          })()
        : await (async () => {
            if (!dependencies) throw new Error('Peable trusted customer location is unconfigured');
            return dependencies.resolveCustomerLocationEvidence(input.subjectAccountId);
          })();
      if (!location.customerLocationEvidenceId)
        throw new Error('Peable trusted customer location unavailable');
      const quote = await client.billing.createTaxQuote({
        store_id: input.subjectAccountId,
        plan_id: offer.planId,
        provider_price_id: offer.priceId,
        customer_location_evidence_id: location.customerLocationEvidenceId,
      });
      validateQuote(quote, input.subjectAccountId, offer.planId, offer.amountMinorUnits);
      if (quote.quote.customer_location_evidence_id !== location.customerLocationEvidenceId)
        throw new Error('Peable checkout customer location differs');
      const snapshot: PersonalCheckoutSnapshot = {
        applicationId: configuration.applicationId,
        merchantId: configuration.merchantId,
        subjectAccountId: input.subjectAccountId,
        planId: offer.planId,
        customerId: customer.provider_customer_id,
        offerId: input.offerId,
        offerVersion: input.offerVersion,
        priceId: input.priceId,
        mode: quote.source.mode,
        environment: quote.source.environment,
        taxQuote: structuredClone(quote),
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
        snapshot.planId !== offer.planId ||
        snapshot.offerId !== input.offerId ||
        snapshot.offerVersion !== input.offerVersion ||
        snapshot.priceId !== input.priceId ||
        snapshot.mode !== input.mode ||
        snapshot.environment !== input.environment ||
        !snapshot.customerId ||
        !z
          .string()
          .check(urlCheck())
          .refine((value) => new URL(value).protocol === 'https:')
          .safeParse(snapshot.returnUrl).success ||
        input.idempotencyKey !== `personal-checkout:${input.intentId}`
      )
        throw new Error('Peable persisted checkout snapshot differs');
      validateQuote(
        snapshot.taxQuote,
        input.subjectAccountId,
        snapshot.planId,
        offer.amountMinorUnits,
      );
      const checkoutInput = {
        provider_customer_id: snapshot.customerId,
        provider_price_id: snapshot.priceId,
        trial_days: 0,
        return_url: snapshot.returnUrl,
        store_id: snapshot.subjectAccountId,
        plan_id: snapshot.planId,
        tax_quote: structuredClone(snapshot.taxQuote),
      };
      if (input.presentation === 'embedded') {
        if (!configuration.embeddedEnabled || input.renewalSubscriptionId)
          throw new Error('Embedded checkout is unavailable for this operation');
        const session = await client.billing
          .createEmbeddedCheckoutSession(checkoutInput, { idempotencyKey: input.idempotencyKey })
          .catch(checkoutFailure);
        if (
          session.presentation !== 'embedded' ||
          !session.id ||
          !Number.isSafeInteger(session.expires_at) ||
          session.expires_at * 1000 <= clock().getTime() ||
          session.expires_at > snapshot.taxQuote.quote.expires_at
        )
          throw new Error('Peable embedded session binding differs');
        return {
          sessionId: session.id,
          expiresAt: peableInstantToIso(session.expires_at),
        };
      }
      const session = await (input.renewalSubscriptionId
        ? client.billing.renewSubscription(input.renewalSubscriptionId, checkoutInput, {
            idempotencyKey: input.idempotencyKey,
          })
        : client.billing.createCheckoutSession(checkoutInput, {
            idempotencyKey: input.idempotencyKey,
          })
      ).catch(checkoutFailure);
      const parsed = z
        .object({
          id: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
          url: z
            .string()
            .check(urlCheck())
            .refine((value) => new URL(value).protocol === 'https:'),
          expiresAt: z.string().check(isoDateTime()),
        })
        .parse({ ...session, expiresAt: peableInstantToIso(session.expires_at) });
      if (
        Date.parse(parsed.expiresAt) <= clock().getTime() ||
        Date.parse(parsed.expiresAt) > snapshot.taxQuote.quote.expires_at * 1000
      )
        throw new Error('Peable checkout session expired or exceeds quote');
      return { sessionId: parsed.id, checkoutUrl: parsed.url, expiresAt: parsed.expiresAt };
    },
  };
}
