import {
  integerCheck,
  isoDateTime,
  safeNumberCheck,
  urlCheck,
  utf16MaxLength,
  utf16MinLength,
} from '@oxy.so/contracts';
import { oxyAccountIdSchema } from '@oxy.so/contracts';
import { createPeablePersonalCheckoutProvider } from './peablePersonalCheckout.service';
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Peable, PeableOxyHost } from '@peable.to/sdk';
import {
  assertPeableBillingWorkloadConfiguration,
  assertPeableBillingMerchant,
  createPeableBillingClient,
} from './peableBillingWorkload.service';
import { z } from 'zod';
import { assertBillingDatabaseNamespace } from '../config/billingNamespace';
import { getDb } from '../config/postgres';
import {
  accessOfferSegments,
  accessSubscriptionSources,
  personalPlanCheckoutIntents,
} from '../db/schema';
import { logger } from '../utils/logger';
import {
  peablePersonalManagementConfigurationSchema,
  stopPeablePersonalManagement,
} from './peablePersonalManagement.service';
import {
  createPeableObservationVerifier,
  createPeablePersonalEvidenceAuthority,
  assertPeablePersonalReconciliationComplete,
  handlePeablePersonalObservation,
  peablePersonalObservationSchema,
  reconcilePeablePersonalInvoiceState,
  type PeablePersonalPaidContext,
} from './peablePersonalEvidence.service';
import {
  closePersonalPlanCheckoutFromProvider,
  startPersonalPlanCheckout,
  personalCheckoutSnapshotFromIntent,
  resumePersonalPlanCheckout,
  type PersonalCheckoutProvider,
} from './personalPlanCheckout.service';
import { loadProductBillingCatalogue } from './productBillingCatalogue.service';

const pinnedKeysSchema = z
  .record(z.string().check(utf16MinLength(1)), z.string().check(utf16MinLength(1)))
  .refine((keys) => Object.keys(keys).length > 0);
export const peablePersonalRuntimeConfigurationSchema = peablePersonalManagementConfigurationSchema
  .extend({
    invoiceIssuer: z
      .object({
        legalName: z.literal('Oxy Platforms, Inc.'),
        id: z.string().check(utf16MinLength(1)),
      })
      .strict(),
    sellerId: z.string().check(utf16MinLength(1)),
    invoiceAuthorityKeys: pinnedKeysSchema,
    taxQuoteAuthorityKeys: pinnedKeysSchema,
    purchasesEnabled: z.boolean(),
    checkout: z
      .object({
        embeddedEnabled: z.boolean().optional(),
        returnUrl: z
          .string()
          .check(urlCheck())
          .refine((value) => new URL(value).protocol === 'https:'),
        taxRemitterId: z.string().check(utf16MinLength(1)),
        /** Reviewed Peable evidence references, not client country/IP guesses. */
        customerLocationEvidence: z.record(
          z.string().check(utf16MinLength(1)),
          z.string().check(utf16MinLength(1)),
        ),
      })
      .strict()
      .optional(),
    observationsEnabled: z.boolean(),
    recoveryEnabled: z.boolean(),
    recoveryIntervalMilliseconds: z.number().check(integerCheck()).min(60_000).max(86_400_000),
  })
  .strict()
  .refine(
    (value) => !value.purchasesEnabled || !!value.checkout,
    'Purchases require fiscal/customer-location configuration',
  );
type RuntimeConfiguration = z.infer<typeof peablePersonalRuntimeConfigurationSchema>;

export function createPeablePersonalRuntime(
  client: Peable,
  rawConfiguration: RuntimeConfiguration,
  observationSecret?: string,
  dependencies: { checkoutProvider?: PersonalCheckoutProvider; clock?: () => Date } = {},
) {
  const configuration = peablePersonalRuntimeConfigurationSchema.parse(rawConfiguration);
  for (const keys of [configuration.invoiceAuthorityKeys, configuration.taxQuoteAuthorityKeys]) {
    for (const value of Object.values(keys)) {
      if (createPublicKey(value).asymmetricKeyType !== 'ed25519')
        throw new Error('Peable authority key must be Ed25519');
    }
  }
  if (configuration.observationsEnabled && !observationSecret)
    throw new Error('Peable observation verification unconfigured');
  if (configuration.purchasesEnabled && !configuration.checkout)
    throw new Error('Peable purchase fiscal/customer-location configuration missing');
  for (const offer of configuration.offers) {
    if (
      offer.kind === 'existing_product'
        ? !offer.amountMinorUnits
        : (offer.amountMinorUnits !== undefined && offer.amountMinorUnits !== 2999) ||
          (offer.interval !== undefined && offer.interval !== 'month')
    )
      throw new Error('Reviewed product price required; Oxy One remains USD 29.99');
  }
  const checkoutProvider =
    configuration.purchasesEnabled && configuration.checkout
      ? createPeablePersonalCheckoutProvider(
          client,
          {
            merchantId: configuration.merchantId,
            applicationId: configuration.applicationId,
            namespace: configuration.namespace,
            sellerId: configuration.sellerId,
            invoiceIssuerId: configuration.invoiceIssuer.id,
            taxRemitterId: configuration.checkout.taxRemitterId,
            returnUrl: configuration.checkout.returnUrl,
            embeddedEnabled: configuration.checkout.embeddedEnabled,
            offers: configuration.offers
              .map((offer) => ({
                ...offer,
                priceId: offer.providerPriceId,
                amountMinorUnits:
                  offer.kind === 'existing_product'
                    ? z
                        .number()
                        .check(integerCheck())
                        .positive()
                        .check(safeNumberCheck())
                        .parse(offer.amountMinorUnits)
                    : 2999,
                currency: 'USD' as const,
                interval: offer.interval ?? 'month',
                trial: 'none' as const,
              }))
              .map(({ providerPriceId: _providerPriceId, kind: _kind, ...offer }) => offer),
          },
          dependencies.clock,
          {
            purchasesEnabled: true,
            async resolveCustomerLocationEvidence(subjectAccountId) {
              const id = configuration.checkout?.customerLocationEvidence[subjectAccountId];
              if (!id) throw new Error('Peable trusted customer location unavailable');
              return { customerLocationEvidenceId: id };
            },
          },
        )
      : process.env.NODE_ENV === 'test'
        ? dependencies.checkoutProvider
        : undefined;
  const sdkAuthority = createPeablePersonalEvidenceAuthority(client);
  const authority = {
    ...sdkAuthority,
    readFinalInvoiceAuthority: async (
      source: Parameters<NonNullable<typeof sdkAuthority.readFinalInvoiceAuthority>>[0],
    ) => {
      if (!sdkAuthority.readFinalInvoiceAuthority)
        throw new Error('Peable invoice authority unconfigured');
      const result = await sdkAuthority.readFinalInvoiceAuthority(source);
      z.object({
        sellerId: z.literal(configuration.sellerId),
        invoiceIssuerId: z.literal(configuration.invoiceIssuer.id),
      }).parse(result.invoice);
      return result;
    },
  };
  const verify =
    configuration.observationsEnabled && observationSecret
      ? createPeableObservationVerifier(client, observationSecret)
      : undefined;

  async function loadContext(sourceId: string): Promise<PeablePersonalPaidContext> {
    await assertBillingDatabaseNamespace(getDb(), configuration.namespace);
    const [source] = await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(
        and(
          eq(accessSubscriptionSources.id, sourceId),
          eq(accessSubscriptionSources.provider, 'peable'),
          eq(accessSubscriptionSources.providerAccountRef, configuration.merchantId),
          eq(accessSubscriptionSources.mode, configuration.namespace.mode),
          eq(accessSubscriptionSources.environment, configuration.namespace.environment),
        ),
      );
    if (!source || source.payerAccountId !== source.beneficiaryAccountId)
      throw new Error('Peable personal source unavailable');
    const subscription = await client.billing.retrieveSubscription(source.providerSubscriptionId);
    const mappings = configuration.offers.filter(
      (value) =>
        value.planId === subscription.plan_id &&
        value.providerPriceId === subscription.provider_price_id,
    );
    if (
      mappings.length !== 1 ||
      subscription.store_id !== source.payerAccountId ||
      subscription.provider_subscription_id !== source.providerSubscriptionId ||
      subscription.livemode !== (configuration.namespace.mode === 'live') ||
      subscription.interval !== (mappings[0]?.interval ?? 'month') ||
      subscription.trial_ends_at !== null
    )
      throw new Error('Peable personal source binding differs');
    const mapping = mappings[0];
    const segments = await getDb()
      .select()
      .from(accessOfferSegments)
      .where(
        and(
          eq(accessOfferSegments.subscriptionId, source.id),
          eq(
            accessOfferSegments.origin,
            mapping.kind === 'existing_product' ? 'individual' : 'bundle',
          ),
          eq(accessOfferSegments.offerId, mapping.offerId),
          eq(accessOfferSegments.offerVersion, mapping.offerVersion),
        ),
      );
    if (!segments.length) throw new Error('Peable personal offer attribution unavailable');
    const catalogue = await loadProductBillingCatalogue();
    const prices = catalogue.prices.filter(
      (value) =>
        value.provider === 'peable' &&
        value.kind === (mapping.kind ?? 'oxy_one') &&
        value.offerKind === (mapping.kind === 'existing_product' ? 'individual' : 'bundle') &&
        value.providerAccountId === configuration.merchantId &&
        value.mode === source.mode &&
        value.environment === source.environment &&
        value.offerId === mapping.offerId &&
        value.offerVersion === mapping.offerVersion &&
        value.priceId === mapping.providerPriceId &&
        value.amountMinorUnits ===
          (mapping.kind === 'existing_product' ? mapping.amountMinorUnits : 2999) &&
        value.currency.toUpperCase() === 'USD' &&
        value.interval === (mapping.interval ?? 'month'),
    );
    if (prices.length !== 1) throw new Error('Peable personal price authority unavailable');
    return {
      accountId: source.payerAccountId,
      customerId: subscription.provider_customer_id,
      subscriptionId: source.providerSubscriptionId,
      priceId: mapping.providerPriceId,
      planId: mapping.planId,
      merchantId: configuration.merchantId,
      appId: configuration.applicationId,
      ...configuration.namespace,
      offerId: mapping.offerId,
      offerVersion: mapping.offerVersion,
      amountMinorUnits: prices[0].amountMinorUnits,
      interval: mapping.interval ?? 'month',
      origin: prices[0].offerKind,
    };
  }
  const configured = {
    configuration,
    management: { configuration, client },
    authority,
    checkoutProvider,
    async renew(accountId: string, sourceId: string, idempotencyKey: string) {
      if (!checkoutProvider)
        return { state: 'unconfigured' as const, reason: 'provider_unconfigured' as const };
      const context = await loadContext(sourceId);
      if (context.accountId !== accountId) throw new Error('Renewal payer differs');
      const catalogue = await loadProductBillingCatalogue();
      const offer = catalogue.offers.find(
        (value) => value.id === context.offerId && value.version === context.offerVersion,
      );
      if (!offer) throw new Error('Renewal offer unavailable');
      const productId = offer.kind === 'individual' ? offer.benefits[0]?.productId : undefined;
      return startPersonalPlanCheckout(
        accountId,
        {
          expectedSubjectAccountId: oxyAccountIdSchema.parse(accountId),
          offerId: context.offerId,
          offerVersion: context.offerVersion,
          idempotencyKey,
        },
        { catalogue, provider: checkoutProvider, productId, renewalSourceId: sourceId },
      );
    },
    async recoverCheckout(intentId: string) {
      if (!configuration.recoveryEnabled) throw new Error('Peable recovery disabled');
      await assertBillingDatabaseNamespace(getDb(), configuration.namespace);
      const [intent] = await getDb()
        .select()
        .from(personalPlanCheckoutIntents)
        .where(
          and(
            eq(personalPlanCheckoutIntents.id, intentId),
            eq(personalPlanCheckoutIntents.priceProvider, 'peable'),
            eq(personalPlanCheckoutIntents.providerAccountRef, configuration.merchantId),
            eq(personalPlanCheckoutIntents.mode, configuration.namespace.mode),
            eq(personalPlanCheckoutIntents.environment, configuration.namespace.environment),
          ),
        );
      if (!intent) throw new Error('Peable checkout intent unavailable');
      if (intent.state === 'closed' || intent.state === 'fulfilled')
        return { status: 'no_invoice' as const };
      if (!intent.providerSessionId) {
        const frozen = personalCheckoutSnapshotFromIntent(intent);
        if (frozen && client.billing.retrieveCheckoutOperation) {
          const input = {
            idempotency_key: `personal-checkout:${intent.id}`,
            provider_customer_id: frozen.customerId,
            provider_price_id: frozen.priceId,
            store_id: frozen.subjectAccountId,
            plan_id: frozen.planId,
          };
          const recovered = await client.billing.retrieveCheckoutOperation(input);
          const expected = {
            ...input,
            tax_quote_id: frozen.taxQuote.quote.id,
            merchant_id: frozen.merchantId,
            app_id: frozen.applicationId,
            mode: frozen.mode,
            environment: frozen.environment,
          };
          if (recovered.state === 'succeeded') {
            if (
              Object.entries(expected).some(
                ([key, value]) => recovered.source[key as keyof typeof recovered.source] !== value,
              )
            )
              throw new Error('Recovered checkout operation differs from frozen authority');
            const session = z
              .object({
                id: z.string().check(utf16MinLength(1)).check(utf16MaxLength(160)),
                expiresAt: z.string().check(isoDateTime()),
                url: z.string().check(urlCheck()).startsWith('https://').optional(),
              })
              .parse({
                ...recovered.checkout,
                expiresAt: new Date(recovered.checkout.expires_at * 1000).toISOString(),
              });
            await getDb()
              .update(personalPlanCheckoutIntents)
              .set({
                providerSessionId: session.id,
                providerSessionExpiresAt: new Date(session.expiresAt),
                checkoutUrl: session.url ?? null,
                state: 'pending',
              })
              .where(
                and(
                  eq(personalPlanCheckoutIntents.id, intent.id),
                  isNull(personalPlanCheckoutIntents.providerSessionId),
                  eq(personalPlanCheckoutIntents.taxQuoteRef, frozen.taxQuote.quote.id),
                  inArray(personalPlanCheckoutIntents.state, ['reserved', 'pending']),
                ),
              );
            return { status: 'checkout_pending' as const };
          }
        }
        if (checkoutProvider)
          await resumePersonalPlanCheckout(intent.id, {
            provider: checkoutProvider,
            now: dependencies.clock?.(),
          });
        return { status: 'checkout_pending' as const };
      }
      const snapshot = personalCheckoutSnapshotFromIntent(intent);
      if (
        !snapshot ||
        snapshot.applicationId !== configuration.applicationId ||
        snapshot.merchantId !== configuration.merchantId ||
        snapshot.mode !== configuration.namespace.mode ||
        snapshot.environment !== configuration.namespace.environment ||
        snapshot.taxQuote.source.store_id !== intent.subjectAccountId ||
        snapshot.taxQuote.source.plan_id !== snapshot.planId
      )
        throw new Error('Peable checkout snapshot unavailable or differs');
      const merchant = await client.merchants.retrieve();
      if (
        merchant.id !== configuration.merchantId ||
        merchant.oxy_app_id !== configuration.applicationId ||
        merchant.environment !== configuration.namespace.environment
      )
        throw new Error('Peable checkout credential owner differs');
      const session = await client.billing.retrieveCheckout(intent.providerSessionId);
      if (
        session.id !== intent.providerSessionId ||
        session.store_id !== snapshot.subjectAccountId ||
        session.plan_id !== snapshot.planId ||
        session.provider_customer_id !== snapshot.customerId ||
        session.provider_price_id !== snapshot.priceId
      )
        throw new Error('Peable checkout observation binding differs');
      if (session.status === 'expired') {
        if (session.subscription !== null) return { status: 'checkout_pending' as const };
        await closePersonalPlanCheckoutFromProvider({
          intentId: intent.id,
          subjectAccountId: intent.subjectAccountId,
          providerSessionId: intent.providerSessionId,
          providerAccountRef: configuration.merchantId,
          ...configuration.namespace,
          reason: 'expired',
        });
        return { status: 'no_invoice' as const };
      }
      const subscription = session.subscription;
      if (session.status !== 'complete' || !subscription || !session.initial_invoice_id)
        return { status: 'checkout_pending' as const };
      if (
        subscription.store_id !== snapshot.subjectAccountId ||
        subscription.plan_id !== snapshot.planId ||
        subscription.provider_customer_id !== snapshot.customerId ||
        subscription.provider_price_id !== snapshot.priceId ||
        subscription.livemode !== (snapshot.mode === 'live') ||
        subscription.interval !== intent.billingInterval ||
        subscription.trial_ends_at !== null
      )
        throw new Error('Peable checkout subscription binding differs');
      const context: PeablePersonalPaidContext = {
        accountId: snapshot.subjectAccountId,
        customerId: snapshot.customerId,
        subscriptionId: subscription.provider_subscription_id,
        priceId: snapshot.priceId,
        planId: snapshot.planId,
        merchantId: snapshot.merchantId,
        appId: snapshot.applicationId,
        ...configuration.namespace,
        offerId: snapshot.offerId,
        offerVersion: snapshot.offerVersion,
        checkoutIntentId: intent.id,
        amountMinorUnits: intent.amountMinorUnits,
        interval: intent.billingInterval,
        origin: intent.offerKind,
      };
      // The checkout owns its immutable first invoice. latestInvoiceId may already
      // name a renewal when a delayed checkout callback is recovered.
      const scopedAuthority = {
        ...authority,
        readFinalInvoiceAuthority: async (
          source: Parameters<typeof authority.readFinalInvoiceAuthority>[0],
        ) => {
          const final = await authority.readFinalInvoiceAuthority(source);
          const invoice = z
            .object({
              taxQuoteId: z.literal(snapshot.taxQuote.quote.id),
              sellerId: z.literal(snapshot.taxQuote.quote.seller_id),
              invoiceIssuerId: z.literal(snapshot.taxQuote.quote.invoice_issuer_id),
              customerLocationEvidenceId: z.literal(
                snapshot.taxQuote.quote.customer_location_evidence_id,
              ),
              taxRateEvidenceId: z.literal(snapshot.taxQuote.quote.tax_rate_evidence_id),
              currency: z.literal('USD'),
              grossMinorUnits: z.literal(intent.amountMinorUnits),
              netMinorUnits: z.literal(snapshot.taxQuote.quote.net_minor_units),
              taxMinorUnits: z.literal(snapshot.taxQuote.quote.tax_minor_units),
              taxTreatment: z.literal('inclusive'),
            })
            .parse(final.invoice);
          if (!invoice.taxQuoteId) throw new Error('Peable initial invoice authority unavailable');
          return final;
        },
      };
      return reconcilePeablePersonalInvoiceState(
        scopedAuthority,
        context,
        session.initial_invoice_id,
        dependencies.clock,
      );
    },
    async observeMerchant(rawBody: string, signature: string): Promise<void> {
      if (!verify || !configuration.recoveryEnabled)
        throw new Error('Peable observations disabled');
      const event = peablePersonalObservationSchema.parse(await verify(rawBody, signature));
      if (event.livemode !== (configuration.namespace.mode === 'live'))
        throw new Error('Peable observation mode differs');
      const resource = event.data.object;
      const subscriptionId =
        resource.resource_kind === 'subscription' ? resource.resource_id : resource.subscription_id;
      if (
        !subscriptionId ||
        (resource.subscription_id && resource.subscription_id !== subscriptionId)
      )
        throw new Error('Peable observation parent unavailable');
      const subscription = await client.billing.retrieveSubscription(subscriptionId);
      if (
        subscription.provider_subscription_id !== subscriptionId ||
        subscription.livemode !== event.livemode
      )
        throw new Error('Peable observation parent differs');
      const [source] = await getDb()
        .select({ id: accessSubscriptionSources.id })
        .from(accessSubscriptionSources)
        .where(
          and(
            eq(accessSubscriptionSources.provider, 'peable'),
            eq(accessSubscriptionSources.providerAccountRef, configuration.merchantId),
            eq(accessSubscriptionSources.mode, configuration.namespace.mode),
            eq(accessSubscriptionSources.environment, configuration.namespace.environment),
            eq(accessSubscriptionSources.providerSubscriptionId, subscriptionId),
            eq(accessSubscriptionSources.payerAccountId, subscription.store_id),
            eq(accessSubscriptionSources.beneficiaryAccountId, subscription.store_id),
          ),
        );
      if (source) {
        const context = await loadContext(source.id);
        assertPeablePersonalReconciliationComplete(
          await handlePeablePersonalObservation(authority, context, rawBody, signature, verify),
        );
        return;
      }
      const intents = await getDb()
        .select({
          id: personalPlanCheckoutIntents.id,
          sessionId: personalPlanCheckoutIntents.providerSessionId,
        })
        .from(personalPlanCheckoutIntents)
        .where(
          and(
            eq(personalPlanCheckoutIntents.priceProvider, 'peable'),
            eq(personalPlanCheckoutIntents.providerAccountRef, configuration.merchantId),
            eq(personalPlanCheckoutIntents.mode, configuration.namespace.mode),
            eq(personalPlanCheckoutIntents.environment, configuration.namespace.environment),
            eq(personalPlanCheckoutIntents.subjectAccountId, subscription.store_id),
            eq(personalPlanCheckoutIntents.customerRef, subscription.provider_customer_id),
            eq(personalPlanCheckoutIntents.priceId, subscription.provider_price_id),
            eq(personalPlanCheckoutIntents.planRef, subscription.plan_id),
            inArray(personalPlanCheckoutIntents.state, ['reserved', 'pending']),
          ),
        )
        .limit(2);
      if (intents.length !== 1) throw new Error('Peable observation checkout unavailable');
      const intent = intents[0];
      if (!intent.sessionId) throw new Error('Peable observation checkout recovery pending');
      const session = await client.billing.retrieveCheckout(intent.sessionId);
      if (
        session.subscription?.provider_subscription_id !== subscriptionId ||
        (resource.resource_kind === 'invoice' &&
          session.initial_invoice_id !== resource.resource_id)
      )
        throw new Error('Peable observation checkout parent differs');
      assertPeablePersonalReconciliationComplete(await configured.recoverCheckout(intent.id));
    },
    async observe(sourceId: string, rawBody: string, signature: string) {
      if (!verify) throw new Error('Peable observations disabled');
      // Authenticate before source lookup or any owned SDK read. The handler
      // verifies again before interpreting bytes; only persisted context grants.
      verify(rawBody, signature);
      const context = await loadContext(sourceId);
      return handlePeablePersonalObservation(authority, context, rawBody, signature, verify);
    },
    async recover(sourceId: string) {
      if (!configuration.recoveryEnabled) throw new Error('Peable recovery disabled');
      const context = await loadContext(sourceId);
      const subscription = await client.billing.retrieveSubscription(context.subscriptionId);
      if (!subscription.latest_invoice_id) return { status: 'no_invoice' as const };
      return reconcilePeablePersonalInvoiceState(
        authority,
        context,
        subscription.latest_invoice_id,
      );
    },
  };
  return configured;
}

type PeablePersonalRuntime = ReturnType<typeof createPeablePersonalRuntime>;
let runtime: PeablePersonalRuntime | undefined;
let disposeRuntimeClient: (() => void) | undefined;
let recoveryTimer: ReturnType<typeof setInterval> | undefined;
interface PeablePersonalRecoverySummary {
  scanned: number;
  completed: number;
  deferred: number;
  batchDeferred: boolean;
}
let recoveryInFlight: Promise<PeablePersonalRecoverySummary> | undefined;
let recoveryCursor: string | undefined;
let checkoutRecoveryCursor: string | undefined;
export function getPeablePersonalRuntime() {
  return runtime;
}

export async function initializePeablePersonalRuntime(
  dependencies: { client?: Peable; oxy?: PeableOxyHost } = {},
) {
  if (process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED !== 'true') return;
  if (runtime) return;
  assertPeableBillingWorkloadConfiguration(!!dependencies.client || !!dependencies.oxy);
  const path = process.env.OXY_ONE_PEABLE_RUNTIME_FILE;
  if (!path) throw new Error('Peable personal runtime unconfigured');
  const configuration = peablePersonalRuntimeConfigurationSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  );
  await assertBillingDatabaseNamespace(getDb(), configuration.namespace);
  const owned = dependencies.client
    ? undefined
    : createPeableBillingClient(
        {
          invoiceAuthorityKeys: configuration.invoiceAuthorityKeys,
          taxQuoteAuthorityKeys: configuration.taxQuoteAuthorityKeys,
        },
        dependencies.oxy,
      );
  const client = dependencies.client ?? owned?.client;
  if (!client) throw new Error('Peable billing workload unavailable');
  try {
    const created = createPeablePersonalRuntime(
      client,
      configuration,
      process.env.OXY_ONE_PEABLE_OBSERVATION_SECRET,
    );
    await assertPeableBillingMerchant(client, configuration);
    runtime = created;
    disposeRuntimeClient = owned?.dispose;
  } catch (error) {
    owned?.dispose();
    throw error;
  }
  if (configuration.recoveryEnabled) {
    recoveryTimer = setInterval(() => {
      if (recoveryInFlight) return;
      recoveryInFlight = recoverPeablePersonalSources().finally(() => {
        recoveryInFlight = undefined;
      });
    }, configuration.recoveryIntervalMilliseconds);
    recoveryTimer.unref();
  }
}

export async function recoverPeablePersonalSources(): Promise<PeablePersonalRecoverySummary> {
  const summary = { scanned: 0, completed: 0, deferred: 0, batchDeferred: false };
  if (!runtime?.configuration.recoveryEnabled) return summary;
  const configured = runtime;
  try {
    const intents = await getDb()
      .select({ id: personalPlanCheckoutIntents.id })
      .from(personalPlanCheckoutIntents)
      .where(
        and(
          eq(personalPlanCheckoutIntents.priceProvider, 'peable'),
          eq(personalPlanCheckoutIntents.providerAccountRef, configured.configuration.merchantId),
          eq(personalPlanCheckoutIntents.mode, configured.configuration.namespace.mode),
          eq(
            personalPlanCheckoutIntents.environment,
            configured.configuration.namespace.environment,
          ),
          inArray(personalPlanCheckoutIntents.state, ['reserved', 'pending']),
          checkoutRecoveryCursor
            ? gt(personalPlanCheckoutIntents.id, checkoutRecoveryCursor)
            : undefined,
        ),
      )
      .orderBy(asc(personalPlanCheckoutIntents.id))
      .limit(50);
    summary.scanned += intents.length;
    for (const intent of intents) {
      try {
        assertPeablePersonalReconciliationComplete(await configured.recoverCheckout(intent.id));
        summary.completed++;
      } catch {
        summary.deferred++;
        logger.warn('Peable personal checkout recovery deferred', { intentId: intent.id });
      }
      checkoutRecoveryCursor = intent.id;
    }
    if (intents.length < 50) checkoutRecoveryCursor = undefined;
    const sources = await getDb()
      .select({ id: accessSubscriptionSources.id })
      .from(accessSubscriptionSources)
      .where(
        and(
          eq(accessSubscriptionSources.provider, 'peable'),
          eq(accessSubscriptionSources.providerAccountRef, configured.configuration.merchantId),
          eq(accessSubscriptionSources.mode, configured.configuration.namespace.mode),
          eq(accessSubscriptionSources.environment, configured.configuration.namespace.environment),
          recoveryCursor ? gt(accessSubscriptionSources.id, recoveryCursor) : undefined,
        ),
      )
      .orderBy(asc(accessSubscriptionSources.id))
      .limit(50);
    summary.scanned += sources.length;
    for (const source of sources) {
      try {
        assertPeablePersonalReconciliationComplete(await configured.recover(source.id));
        summary.completed++;
      } catch {
        summary.deferred++;
        logger.warn('Peable personal source recovery deferred', { sourceId: source.id });
      }
      // Advance through every source fairly, including deferred work; wrapping
      // the scan retries it without trapping all other sources behind one item.
      recoveryCursor = source.id;
    }
    if (sources.length < 50) recoveryCursor = undefined;
  } catch {
    summary.batchDeferred = true;
    logger.warn('Peable personal recovery batch deferred');
  }
  return summary;
}
export async function stopPeablePersonalRuntime() {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = undefined;
  await recoveryInFlight;
  runtime = undefined;
  disposeRuntimeClient?.();
  disposeRuntimeClient = undefined;
  await stopPeablePersonalManagement();
  recoveryCursor = undefined;
  checkoutRecoveryCursor = undefined;
}
