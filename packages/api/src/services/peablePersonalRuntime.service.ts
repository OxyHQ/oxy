import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { Peable } from '@peable.to/sdk';
import { z } from 'zod';
import { assertBillingDatabaseNamespace } from '../config/billingNamespace';
import { getDb } from '../config/postgres';
import {
  accessOfferSegments,
  accessSubscriptionSources,
  personalPlanCheckoutIntents,
} from '../db/schema';
import { logger } from '../utils/logger';
import { peablePersonalManagementConfigurationSchema } from './peablePersonalManagement.service';
import {
  createPeableObservationVerifier,
  createPeablePersonalEvidenceAuthority,
  assertPeablePersonalReconciliationComplete,
  handlePeablePersonalObservation,
  reconcilePeablePersonalInvoiceState,
  type PeablePersonalPaidContext,
} from './peablePersonalEvidence.service';
import {
  closePersonalPlanCheckoutFromProvider,
  personalCheckoutSnapshotFromIntent,
  resumePersonalPlanCheckout,
  type PersonalCheckoutProvider,
} from './personalPlanCheckout.service';
import { loadProductBillingCatalogue } from './productBillingCatalogue.service';

const pinnedKeysSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine((keys) => Object.keys(keys).length > 0);
export const peablePersonalRuntimeConfigurationSchema = peablePersonalManagementConfigurationSchema
  .extend({
    invoiceIssuer: z
      .object({ legalName: z.literal('The Oxy Collective, Inc.'), id: z.string().min(1) })
      .strict(),
    sellerId: z.string().min(1),
    invoiceAuthorityKeys: pinnedKeysSchema,
    taxQuoteAuthorityKeys: pinnedKeysSchema,
    purchasesEnabled: z.literal(false),
    observationsEnabled: z.boolean(),
    recoveryEnabled: z.boolean(),
    recoveryIntervalMilliseconds: z.number().int().min(60_000).max(86_400_000),
  })
  .strict();
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
        value.planId === subscription.planId &&
        value.providerPriceId === subscription.providerPriceId,
    );
    if (
      mappings.length !== 1 ||
      subscription.storeId !== source.payerAccountId ||
      subscription.providerSubscriptionId !== source.providerSubscriptionId ||
      subscription.livemode !== (configuration.namespace.mode === 'live') ||
      subscription.interval !== 'month' ||
      subscription.trialEndsAt !== null
    )
      throw new Error('Peable personal source binding differs');
    const mapping = mappings[0];
    const segments = await getDb()
      .select()
      .from(accessOfferSegments)
      .where(
        and(
          eq(accessOfferSegments.subscriptionId, source.id),
          eq(accessOfferSegments.origin, 'bundle'),
          eq(accessOfferSegments.offerId, mapping.offerId),
          eq(accessOfferSegments.offerVersion, mapping.offerVersion),
        ),
      );
    if (!segments.length) throw new Error('Peable personal offer attribution unavailable');
    const catalogue = await loadProductBillingCatalogue();
    const prices = catalogue.prices.filter(
      (value) =>
        value.provider === 'peable' &&
        value.kind === 'oxy_one' &&
        value.offerKind === 'bundle' &&
        value.providerAccountId === configuration.merchantId &&
        value.mode === source.mode &&
        value.environment === source.environment &&
        value.offerId === mapping.offerId &&
        value.offerVersion === mapping.offerVersion &&
        value.priceId === mapping.providerPriceId &&
        value.amountMinorUnits === 2999 &&
        value.currency.toUpperCase() === 'USD',
    );
    if (prices.length !== 1) throw new Error('Peable personal price authority unavailable');
    return {
      accountId: source.payerAccountId,
      customerId: subscription.providerCustomerId,
      subscriptionId: source.providerSubscriptionId,
      priceId: mapping.providerPriceId,
      planId: mapping.planId,
      merchantId: configuration.merchantId,
      appId: configuration.applicationId,
      ...configuration.namespace,
      offerId: mapping.offerId,
      offerVersion: mapping.offerVersion,
    };
  }
  return {
    configuration,
    authority,
    checkoutProvider: process.env.NODE_ENV === 'test' ? dependencies.checkoutProvider : undefined,
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
        if (process.env.NODE_ENV === 'test' && dependencies.checkoutProvider)
          await resumePersonalPlanCheckout(intent.id, {
            provider: dependencies.checkoutProvider,
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
        snapshot.taxQuote.source.storeId !== intent.subjectAccountId ||
        snapshot.taxQuote.source.planId !== snapshot.planId
      )
        throw new Error('Peable checkout snapshot unavailable or differs');
      const merchant = await client.merchants.retrieve();
      if (
        merchant.id !== configuration.merchantId ||
        merchant.oxyAppId !== configuration.applicationId ||
        merchant.environment !== configuration.namespace.environment
      )
        throw new Error('Peable checkout credential owner differs');
      const session = await client.billing.retrieveCheckout(intent.providerSessionId);
      if (
        session.id !== intent.providerSessionId ||
        session.storeId !== snapshot.subjectAccountId ||
        session.planId !== snapshot.planId ||
        session.providerCustomerId !== snapshot.customerId ||
        session.providerPriceId !== snapshot.priceId
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
      if (session.status !== 'complete' || !subscription?.latestInvoiceId)
        return { status: 'checkout_pending' as const };
      if (
        subscription.storeId !== snapshot.subjectAccountId ||
        subscription.planId !== snapshot.planId ||
        subscription.providerCustomerId !== snapshot.customerId ||
        subscription.providerPriceId !== snapshot.priceId ||
        subscription.livemode !== (snapshot.mode === 'live') ||
        subscription.interval !== 'month' ||
        subscription.trialEndsAt !== null
      )
        throw new Error('Peable checkout subscription binding differs');
      const context: PeablePersonalPaidContext = {
        accountId: snapshot.subjectAccountId,
        customerId: snapshot.customerId,
        subscriptionId: subscription.providerSubscriptionId,
        priceId: snapshot.priceId,
        planId: snapshot.planId,
        merchantId: snapshot.merchantId,
        appId: snapshot.applicationId,
        ...configuration.namespace,
        offerId: snapshot.offerId,
        offerVersion: snapshot.offerVersion,
        checkoutIntentId: intent.id,
      };
      // latestInvoiceId is discovery only. Peable's signed quote-bound authority
      // rejects non-subscription_create invoices; exact frozen quote evidence is mandatory.
      const scopedAuthority = {
        ...authority,
        readFinalInvoiceAuthority: async (
          source: Parameters<typeof authority.readFinalInvoiceAuthority>[0],
        ) => {
          const final = await authority.readFinalInvoiceAuthority(source);
          const invoice = z
            .object({
              taxQuoteId: z.literal(snapshot.taxQuote.quote.id),
              sellerId: z.literal(snapshot.taxQuote.quote.sellerId),
              invoiceIssuerId: z.literal(snapshot.taxQuote.quote.invoiceIssuerId),
              customerLocationEvidenceId: z.literal(
                snapshot.taxQuote.quote.customerLocationEvidenceId,
              ),
              taxRateEvidenceId: z.literal(snapshot.taxQuote.quote.taxRateEvidenceId),
              currency: z.literal('USD'),
              grossMinorUnits: z.literal(2999),
              netMinorUnits: z.literal(snapshot.taxQuote.quote.netMinorUnits),
              taxMinorUnits: z.literal(snapshot.taxQuote.quote.taxMinorUnits),
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
        subscription.latestInvoiceId,
        dependencies.clock,
      );
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
      if (!subscription.latestInvoiceId) return { status: 'no_invoice' as const };
      return reconcilePeablePersonalInvoiceState(authority, context, subscription.latestInvoiceId);
    },
  };
}

type PeablePersonalRuntime = ReturnType<typeof createPeablePersonalRuntime>;
let runtime: PeablePersonalRuntime | undefined;
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

export async function initializePeablePersonalRuntime(dependencies: { client?: Peable } = {}) {
  if (process.env.OXY_ONE_PEABLE_RUNTIME_ENABLED !== 'true') return;
  if (runtime) return;
  const path = process.env.OXY_ONE_PEABLE_RUNTIME_FILE;
  const publicKey = process.env.OXY_ONE_PEABLE_PUBLIC_KEY,
    secret = process.env.OXY_ONE_PEABLE_SECRET;
  if (!path || !publicKey || !secret) throw new Error('Peable personal runtime unconfigured');
  const configuration = peablePersonalRuntimeConfigurationSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  );
  await assertBillingDatabaseNamespace(getDb(), configuration.namespace);
  const client =
    dependencies.client ??
    new Peable({
      publicKey,
      secret,
      invoiceAuthorityKeys: configuration.invoiceAuthorityKeys,
      taxQuoteAuthorityKeys: configuration.taxQuoteAuthorityKeys,
    });
  const created = createPeablePersonalRuntime(
    client,
    configuration,
    process.env.OXY_ONE_PEABLE_OBSERVATION_SECRET,
  );
  const merchant = await client.merchants.retrieve();
  if (
    merchant.id !== configuration.merchantId ||
    merchant.oxyAppId !== configuration.applicationId ||
    merchant.environment !== configuration.namespace.environment
  )
    throw new Error('Peable personal credential owner differs');
  runtime = created;
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
  recoveryCursor = undefined;
  checkoutRecoveryCursor = undefined;
}
