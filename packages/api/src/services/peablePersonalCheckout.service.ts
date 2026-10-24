import {
  integerCheck,
  isoDateTime,
  safeNumberCheck,
  urlCheck,
  utf16MaxLength,
  utf16MinLength,
} from '@oxy.so/contracts';
import { createHash } from 'node:crypto';
import { PeableError, type BillingTaxQuote, type Peable } from '@peable.to/sdk';
import { ApiError } from '../utils/error';
import { z } from '@oxy.so/zod4';
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
    error.code === 'invalid_request_error' &&
    error.message === 'reconciliation_required'
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
  client: Pick<Peable, 'merchants' | 'billing'>,
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
      quote.schemaVersion !== 1 ||
      quote.source.merchantId !== configuration.merchantId ||
      quote.source.appId !== configuration.applicationId ||
      quote.source.storeId !== subjectAccountId ||
      quote.source.planId !== planId ||
      quote.source.mode !== configuration.namespace.mode ||
      quote.source.environment !== configuration.namespace.environment ||
      quote.quote.currency !== 'USD' ||
      quote.quote.grossMinorUnits !== amountMinorUnits ||
      quote.quote.taxTreatment !== 'inclusive' ||
      !Number.isSafeInteger(quote.quote.netMinorUnits) ||
      !Number.isSafeInteger(quote.quote.taxMinorUnits) ||
      quote.quote.netMinorUnits < 0 ||
      quote.quote.taxMinorUnits < 0 ||
      quote.quote.netMinorUnits + quote.quote.taxMinorUnits !== amountMinorUnits ||
      quote.quote.sellerId !== configuration.sellerId ||
      quote.quote.invoiceIssuerId !== configuration.invoiceIssuerId ||
      quote.quote.taxRemitterId !== configuration.taxRemitterId ||
      !Number.isFinite(Date.parse(quote.quote.quotedAt)) ||
      Date.parse(quote.quote.quotedAt) > now ||
      !Number.isFinite(Date.parse(quote.quote.expiresAt)) ||
      Date.parse(quote.quote.expiresAt) <= now
    )
      throw new Error('Peable checkout tax quote differs or expired');
  };
  return {
    kind: 'peable',
    async validateExistingCheckout(snapshot, sessionId) {
      const merchant = await client.merchants.retrieve();
      if (
        merchant.id !== configuration.merchantId ||
        merchant.oxyAppId !== configuration.applicationId ||
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
        session.storeId !== snapshot.subjectAccountId ||
        session.planId !== snapshot.planId ||
        session.providerCustomerId !== snapshot.customerId ||
        session.providerPriceId !== snapshot.priceId
      )
        throw new Error('Peable checkout observation binding differs');
    },
    async prepare(input) {
      assertEnabled();
      const offer = select(input);
      if (!dependencies) throw new Error('Peable trusted customer location is unconfigured');
      const merchant = await client.merchants.retrieve();
      if (
        merchant.id !== configuration.merchantId ||
        merchant.oxyAppId !== configuration.applicationId ||
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
          storeId: input.subjectAccountId,
          storeName: input.subjectAccountId,
        },
        { idempotencyKey: `oxy-one-customer:${customerKey}` },
      );
      if (!customer.providerCustomerId) throw new Error('Peable checkout customer unavailable');
      const location = await dependencies.resolveCustomerLocationEvidence(input.subjectAccountId);
      if (!location.customerLocationEvidenceId)
        throw new Error('Peable trusted customer location unavailable');
      const quote = await client.billing.createTaxQuote({
        storeId: input.subjectAccountId,
        planId: offer.planId,
        customerLocationEvidenceId: location.customerLocationEvidenceId,
      });
      validateQuote(quote, input.subjectAccountId, offer.planId, offer.amountMinorUnits);
      if (quote.quote.customerLocationEvidenceId !== location.customerLocationEvidenceId)
        throw new Error('Peable checkout customer location differs');
      const snapshot: PersonalCheckoutSnapshot = {
        applicationId: configuration.applicationId,
        merchantId: configuration.merchantId,
        subjectAccountId: input.subjectAccountId,
        planId: offer.planId,
        customerId: customer.providerCustomerId,
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
        providerCustomerId: snapshot.customerId,
        providerPriceId: snapshot.priceId,
        trialDays: 0,
        returnUrl: snapshot.returnUrl,
        storeId: snapshot.subjectAccountId,
        planId: snapshot.planId,
        taxQuote: structuredClone(snapshot.taxQuote),
      };
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
        .parse(session);
      if (
        Date.parse(parsed.expiresAt) <= clock().getTime() ||
        Date.parse(parsed.expiresAt) > Date.parse(snapshot.taxQuote.quote.expiresAt)
      )
        throw new Error('Peable checkout session expired or exceeds quote');
      return { sessionId: parsed.id, checkoutUrl: parsed.url, expiresAt: parsed.expiresAt };
    },
  };
}
