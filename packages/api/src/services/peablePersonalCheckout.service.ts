import { createHash } from 'node:crypto';
import type { Peable } from '@peable.to/sdk';
import { z } from 'zod';
import { billingNamespaceSchema } from '../config/billingNamespace';
import type { PersonalCheckoutProvider } from './personalPlanCheckout.service';

export const peablePersonalCheckoutConfigurationSchema = z.object({
  merchantId: z.string().min(1),
  applicationId: z.string().min(1),
  namespace: billingNamespaceSchema,
  returnUrl: z.string().url().refine(value => new URL(value).protocol === 'https:'),
  offers: z.array(z.object({
    offerId: z.string().min(1), offerVersion: z.number().int().positive(),
    priceId: z.string().min(1), planId: z.string().min(1),
    amountMinorUnits: z.literal(2999), currency: z.literal('USD'),
    interval: z.literal('month'), trial: z.literal('none'),
  }).strict()).min(1),
}).strict();

/** Uses the public SDK exclusively. This is deliberately not loaded by HTTP:
 * its existing recurring processor cannot yet attest inclusive tax/seller/FAIR.
 * The test process exercises the transport without enabling real purchases. */
export function createPeablePersonalCheckoutProvider(
  client: Pick<Peable, 'merchants' | 'billing'>,
  rawConfiguration: z.input<typeof peablePersonalCheckoutConfigurationSchema>,
  clock: () => Date = () => new Date(),
): PersonalCheckoutProvider {
  const configuration = peablePersonalCheckoutConfigurationSchema.parse(rawConfiguration);
  return {
    kind: 'peable',
    async create(input) {
      if (process.env.NODE_ENV !== 'test') throw new Error('Peable final purchase authority is unconfigured');
      const selection = configuration.offers.filter(offer => offer.offerId === input.offerId
        && offer.offerVersion === input.offerVersion && offer.priceId === input.priceId
        && offer.amountMinorUnits === input.amountMinorUnits && offer.currency === input.currency.toUpperCase()
        && offer.interval === input.interval && offer.trial === input.trial);
      if (selection.length !== 1 || input.providerAccountRef !== configuration.merchantId
        || input.mode !== configuration.namespace.mode || input.environment !== configuration.namespace.environment)
        throw new Error('Peable checkout selection differs');
      const merchant = await client.merchants.retrieve();
      if (merchant.id !== configuration.merchantId || merchant.oxyAppId !== configuration.applicationId
        || merchant.environment !== configuration.namespace.environment)
        throw new Error('Peable checkout credential owner differs');
      const customerKey = createHash('sha256').update(JSON.stringify([
        configuration.merchantId, configuration.applicationId, configuration.namespace,
        input.subjectAccountId,
      ])).digest('hex');
      const customer = await client.billing.ensureCustomer({
        storeId: input.subjectAccountId, storeName: input.subjectAccountId,
      }, { idempotencyKey: `oxy-one-customer:${customerKey}` });
      if (!customer.providerCustomerId) throw new Error('Peable checkout customer unavailable');
      const session = await client.billing.createCheckoutSession({
        providerCustomerId: customer.providerCustomerId, providerPriceId: input.priceId,
        trialDays: 0, returnUrl: configuration.returnUrl,
        storeId: input.subjectAccountId, planId: selection[0].planId,
      }, { idempotencyKey: input.idempotencyKey });
      const parsed = z.object({ id: z.string().min(1).max(160), url: z.string().url()
        .refine(value => new URL(value).protocol === 'https:'), expiresAt: z.string().datetime() }).parse(session);
      if (Date.parse(parsed.expiresAt) <= clock().getTime()) throw new Error('Peable checkout session expired');
      return { sessionId: parsed.id, checkoutUrl: parsed.url };
    },
  };
}
