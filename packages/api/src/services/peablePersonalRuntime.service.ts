import { integerCheck, safeNumberCheck, urlCheck } from '@oxy.so/contracts';
import { readFile } from 'node:fs/promises';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Peable, PeableOxyHost, WebhookEvent } from '@peable.to/sdk';
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
  assertPeableBillingWorkloadConfiguration,
  assertPeableBillingMerchant,
  createPeableBillingClient,
} from './peableBillingWorkload.service';
import {
  createPeablePersonalCheckoutProvider,
  PEABLE_CUSTOMER_ACCOUNT_KEY,
} from './peablePersonalCheckout.service';
import {
  peablePersonalManagementConfigurationSchema,
  stopPeablePersonalManagement,
} from './peablePersonalManagement.service';
import {
  assertPeablePersonalReconciliationComplete,
  reconcilePeablePersonalInvoiceState,
  reconcilePeablePersonalSubscriptionState,
  type PeablePersonalPaidContext,
} from './peablePersonalEvidence.service';
import {
  peableInstantToIso,
  peableReference,
  readNativeSubscription,
} from './peablePersonalBilling.service';
import {
  closePersonalPlanCheckoutFromProvider,
  personalCheckoutSnapshotFromIntent,
  resumePersonalPlanCheckout,
  type PersonalCheckoutProvider,
} from './personalPlanCheckout.service';
import { loadProductBillingCatalogue } from './productBillingCatalogue.service';

export const peablePersonalRuntimeConfigurationSchema = peablePersonalManagementConfigurationSchema
  .extend({
    purchasesEnabled: z.boolean(),
    checkout: z
      .object({
        returnUrl: z
          .string()
          .check(urlCheck())
          .refine((value) => new URL(value).protocol === 'https:'),
      })
      .strict()
      .optional(),
    eventsEnabled: z.boolean(),
    recoveryEnabled: z.boolean(),
    recoveryIntervalMilliseconds: z.number().check(integerCheck()).min(60_000).max(86_400_000),
  })
  .strict()
  .refine(
    (value) => !value.purchasesEnabled || !!value.checkout,
    'Purchases require a checkout return URL',
  );
type RuntimeConfiguration = z.infer<typeof peablePersonalRuntimeConfigurationSchema>;

/** The Peable events this runtime acts on. Each only says WHICH object to
 * re-read; nothing in a delivery body is ever applied. */
export const PEABLE_PERSONAL_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
] as const;

const ignored = { status: 'ignored' as const };

export function createPeablePersonalRuntime(
  client: Peable,
  rawConfiguration: RuntimeConfiguration,
  webhookSecret?: string,
  dependencies: { checkoutProvider?: PersonalCheckoutProvider; clock?: () => Date } = {},
) {
  const configuration = peablePersonalRuntimeConfigurationSchema.parse(rawConfiguration);
  if (configuration.eventsEnabled && !webhookSecret)
    throw new Error('Peable event verification unconfigured');
  for (const offer of configuration.offers) {
    if (
      offer.kind === 'existing_product'
        ? !offer.amountMinorUnits
        : (offer.amountMinorUnits !== undefined && offer.amountMinorUnits !== 2999) ||
          (offer.interval !== undefined && offer.interval !== 'month')
    )
      throw new Error('Reviewed product price required; Oxy One remains USD 29.99');
  }
  const clock = dependencies.clock ?? (() => new Date());
  const namespace = configuration.namespace;
  const checkoutProvider =
    configuration.purchasesEnabled && configuration.checkout
      ? createPeablePersonalCheckoutProvider(
          client,
          {
            merchantId: configuration.merchantId,
            applicationId: configuration.applicationId,
            namespace,
            returnUrl: configuration.checkout.returnUrl,
            offers: configuration.offers.map((offer) => ({
              offerId: offer.offerId,
              offerVersion: offer.offerVersion,
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
            })),
          },
          clock,
          { purchasesEnabled: true },
        )
      : process.env.NODE_ENV === 'test'
        ? dependencies.checkoutProvider
        : undefined;

  const mappingFor = (priceId: string) => {
    const mappings = configuration.offers.filter((value) => value.providerPriceId === priceId);
    if (mappings.length !== 1) throw new Error('Peable personal offer mapping unavailable');
    return mappings[0];
  };
  /** The customer is Oxy's only if it carries this account's key. */
  const assertCustomerAccount = async (customerId: string, accountId: string) => {
    const customer = await client.customers.retrieve(customerId);
    if (
      'deleted' in customer ||
      customer.id !== customerId ||
      customer.metadata[PEABLE_CUSTOMER_ACCOUNT_KEY] !== accountId
    )
      throw new Error('Peable customer account differs');
  };

  async function sourceBySubscription(subscriptionId: string) {
    const [source] = await getDb()
      .select({ id: accessSubscriptionSources.id })
      .from(accessSubscriptionSources)
      .where(
        and(
          eq(accessSubscriptionSources.provider, 'peable'),
          eq(accessSubscriptionSources.providerSubscriptionId, subscriptionId),
          eq(accessSubscriptionSources.providerAccountRef, configuration.merchantId),
          eq(accessSubscriptionSources.mode, namespace.mode),
          eq(accessSubscriptionSources.environment, namespace.environment),
        ),
      );
    return source?.id;
  }

  async function loadContext(sourceId: string): Promise<PeablePersonalPaidContext> {
    await assertBillingDatabaseNamespace(getDb(), namespace);
    const [source] = await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(
        and(
          eq(accessSubscriptionSources.id, sourceId),
          eq(accessSubscriptionSources.provider, 'peable'),
          eq(accessSubscriptionSources.providerAccountRef, configuration.merchantId),
          eq(accessSubscriptionSources.mode, namespace.mode),
          eq(accessSubscriptionSources.environment, namespace.environment),
        ),
      );
    if (!source || source.payerAccountId !== source.beneficiaryAccountId)
      throw new Error('Peable personal source unavailable');
    const subscription = readNativeSubscription(
      await client.subscriptions.retrieve(source.providerSubscriptionId),
    );
    const mapping = mappingFor(subscription.priceId);
    if (
      subscription.id !== source.providerSubscriptionId ||
      subscription.livemode !== (namespace.mode === 'live') ||
      subscription.interval !== (mapping.interval ?? 'month') ||
      subscription.trialEnd !== null
    )
      throw new Error('Peable personal source binding differs');
    await assertCustomerAccount(subscription.customerId, source.payerAccountId);
    const origin = mapping.kind === 'existing_product' ? 'individual' : 'bundle';
    const segments = await getDb()
      .select()
      .from(accessOfferSegments)
      .where(
        and(
          eq(accessOfferSegments.subscriptionId, source.id),
          eq(accessOfferSegments.origin, origin),
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
        value.offerKind === origin &&
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
      customerId: subscription.customerId,
      subscriptionId: source.providerSubscriptionId,
      priceId: mapping.providerPriceId,
      merchantId: configuration.merchantId,
      appId: configuration.applicationId,
      ...namespace,
      offerId: mapping.offerId,
      offerVersion: mapping.offerVersion,
      amountMinorUnits: prices[0].amountMinorUnits,
      interval: mapping.interval ?? 'month',
      origin: prices[0].offerKind,
    };
  }

  async function intentWhere(condition: ReturnType<typeof eq>) {
    const [intent] = await getDb()
      .select()
      .from(personalPlanCheckoutIntents)
      .where(
        and(
          condition,
          eq(personalPlanCheckoutIntents.priceProvider, 'peable'),
          eq(personalPlanCheckoutIntents.providerAccountRef, configuration.merchantId),
          eq(personalPlanCheckoutIntents.mode, namespace.mode),
          eq(personalPlanCheckoutIntents.environment, namespace.environment),
        ),
      );
    return intent;
  }

  /** The subscription a completed session started: the engine stamps the
   * session on it, and it must be this customer's. */
  async function subscriptionForSession(sessionId: string, customerId: string) {
    const found = await client.subscriptions.search({
      query: `metadata['checkout_session']:'${sessionId}'`,
      limit: 2,
    });
    if (found.has_more || found.data.length > 1)
      throw new Error('Peable checkout subscription is ambiguous');
    if (!found.data[0]) return undefined;
    const subscription = readNativeSubscription(found.data[0]);
    if (subscription.checkoutSessionId !== sessionId || subscription.customerId !== customerId)
      throw new Error('Peable checkout subscription binding differs');
    return subscription;
  }

  async function recoverCheckout(intentId: string) {
    if (!configuration.recoveryEnabled && !configuration.eventsEnabled)
      throw new Error('Peable recovery disabled');
    await assertBillingDatabaseNamespace(getDb(), namespace);
    const intent = await intentWhere(eq(personalPlanCheckoutIntents.id, intentId));
    if (!intent) throw new Error('Peable checkout intent unavailable');
    if (intent.state === 'closed' || intent.state === 'fulfilled')
      return { status: 'no_invoice' as const };
    const snapshot = personalCheckoutSnapshotFromIntent(intent);
    if (!intent.providerSessionId) {
      // A crash after Peable created the session but before Oxy stored it:
      // adopt the session this intent made rather than opening a second one.
      if (snapshot) {
        const sessions = await client.checkout.sessions.list({
          customer: snapshot.customerId,
          limit: 100,
        });
        const own = sessions.data.filter((session) => session.client_reference_id === intent.id);
        if (own.length > 1) throw new Error('Peable checkout sessions are ambiguous');
        const session = own[0];
        if (session?.url) {
          await getDb()
            .update(personalPlanCheckoutIntents)
            .set({
              providerSessionId: session.id,
              providerSessionExpiresAt: new Date(peableInstantToIso(session.expires_at)),
              checkoutUrl: session.url,
              state: 'pending',
            })
            .where(
              and(
                eq(personalPlanCheckoutIntents.id, intent.id),
                isNull(personalPlanCheckoutIntents.providerSessionId),
                inArray(personalPlanCheckoutIntents.state, ['reserved', 'pending']),
              ),
            );
          return { status: 'checkout_pending' as const };
        }
      }
      if (checkoutProvider)
        await resumePersonalPlanCheckout(intent.id, { provider: checkoutProvider, now: clock() });
      return { status: 'checkout_pending' as const };
    }
    if (
      !snapshot ||
      snapshot.applicationId !== configuration.applicationId ||
      snapshot.merchantId !== configuration.merchantId ||
      snapshot.mode !== namespace.mode ||
      snapshot.environment !== namespace.environment
    )
      throw new Error('Peable checkout snapshot unavailable or differs');
    await assertPeableBillingMerchant(client, configuration);
    const session = await client.checkout.sessions.retrieve(intent.providerSessionId);
    if (
      session.id !== intent.providerSessionId ||
      session.mode !== 'subscription' ||
      session.client_reference_id !== intent.id ||
      peableReference(session.customer) !== snapshot.customerId
    )
      throw new Error('Peable checkout session binding differs');
    if (session.status === 'open') return { status: 'checkout_pending' as const };
    const subscription = await subscriptionForSession(session.id, snapshot.customerId);
    if (session.status === 'expired') {
      if (subscription) return { status: 'checkout_pending' as const };
      await closePersonalPlanCheckoutFromProvider({
        intentId: intent.id,
        subjectAccountId: intent.subjectAccountId,
        providerSessionId: intent.providerSessionId,
        providerAccountRef: configuration.merchantId,
        ...namespace,
        reason: 'expired',
      });
      return { status: 'no_invoice' as const };
    }
    if (!subscription) return { status: 'checkout_pending' as const };
    if (
      subscription.priceId !== snapshot.priceId ||
      subscription.livemode !== (namespace.mode === 'live') ||
      subscription.interval !== intent.billingInterval ||
      subscription.trialEnd !== null
    )
      throw new Error('Peable checkout subscription binding differs');
    // The checkout owns its immutable first invoice; the latest invoice may
    // already be a renewal when a delayed completion is recovered.
    const invoices = await client.invoices.list({ subscription: subscription.id, limit: 100 });
    const initial = invoices.data.filter(
      (invoice) => invoice.billing_reason === 'subscription_create',
    );
    if (initial.length !== 1) throw new Error('Peable initial invoice unavailable');
    return reconcilePeablePersonalInvoiceState(
      client,
      {
        accountId: snapshot.subjectAccountId,
        customerId: snapshot.customerId,
        subscriptionId: subscription.id,
        priceId: snapshot.priceId,
        merchantId: snapshot.merchantId,
        appId: snapshot.applicationId,
        ...namespace,
        offerId: snapshot.offerId,
        offerVersion: snapshot.offerVersion,
        checkoutIntentId: intent.id,
        amountMinorUnits: intent.amountMinorUnits,
        interval: intent.billingInterval,
        origin: intent.offerKind,
      },
      initial[0].id,
      clock,
    );
  }

  /** A subscription Oxy has no source for yet is either one its checkout is
   * still recording, or not Oxy's. */
  async function recoverUnrecordedSubscription(subscriptionId: string) {
    const subscription = readNativeSubscription(
      await client.subscriptions.retrieve(subscriptionId),
    );
    if (!subscription.checkoutSessionId) return ignored;
    const intent = await intentWhere(
      eq(personalPlanCheckoutIntents.providerSessionId, subscription.checkoutSessionId),
    );
    if (!intent) return ignored;
    return recoverCheckout(intent.id);
  }

  async function reconcileInvoice(invoiceId: string) {
    const invoice = await client.invoices.retrieve(invoiceId);
    const subscriptionId = peableReference(invoice.subscription);
    if (!subscriptionId) return ignored;
    const sourceId = await sourceBySubscription(subscriptionId);
    if (!sourceId) return recoverUnrecordedSubscription(subscriptionId);
    return reconcilePeablePersonalInvoiceState(
      client,
      await loadContext(sourceId),
      invoiceId,
      clock,
    );
  }

  async function handleEvent(event: WebhookEvent) {
    await assertBillingDatabaseNamespace(getDb(), namespace);
    if (event.livemode !== (namespace.mode === 'live'))
      throw new Error('Peable event mode differs');
    const object = event.data.object as { id?: unknown; client_reference_id?: unknown };
    const objectId = typeof object.id === 'string' ? object.id : undefined;
    if (!objectId) return ignored;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed': {
        const intent =
          (await intentWhere(eq(personalPlanCheckoutIntents.providerSessionId, objectId))) ??
          (typeof object.client_reference_id === 'string'
            ? await intentWhere(eq(personalPlanCheckoutIntents.id, object.client_reference_id))
            : undefined);
        // Never trust the reference alone: the session read inside the
        // recovery must name this intent and its customer.
        return intent ? recoverCheckout(intent.id) : ignored;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const sourceId = await sourceBySubscription(objectId);
        if (!sourceId) return recoverUnrecordedSubscription(objectId);
        return reconcilePeablePersonalSubscriptionState(
          client,
          await loadContext(sourceId),
          sourceId,
          clock,
        );
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
        return reconcileInvoice(objectId);
      case 'charge.refunded':
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        const paymentIntentId = peableReference(
          (event.data.object as { payment_intent?: string | { id: string } | null }).payment_intent,
        );
        if (!paymentIntentId) return ignored;
        const payment = await client.paymentIntents.retrieve(paymentIntentId);
        const invoiceId = payment.metadata.invoice;
        return invoiceId ? reconcileInvoice(invoiceId) : ignored;
      }
      default:
        return ignored;
    }
  }

  return {
    configuration,
    management: { configuration, client },
    checkoutProvider,
    recoverCheckout,
    /** One signed delivery. The SDK verifies the signature and the timestamp
     * window before anything is read; the event then only names objects. */
    async receive(rawBody: string, signature: string) {
      if (!configuration.eventsEnabled || !webhookSecret) throw new Error('Peable events disabled');
      if (Buffer.byteLength(rawBody) > 1_048_576) throw new Error('Peable event body too large');
      const event = client.webhooks.constructEvent(rawBody, signature, webhookSecret);
      return handleEvent(event);
    },
    async recover(sourceId: string) {
      if (!configuration.recoveryEnabled) throw new Error('Peable recovery disabled');
      const context = await loadContext(sourceId);
      const subscription = readNativeSubscription(
        await client.subscriptions.retrieve(context.subscriptionId),
      );
      if (!subscription.latestInvoiceId)
        return reconcilePeablePersonalSubscriptionState(client, context, sourceId, clock);
      return reconcilePeablePersonalInvoiceState(
        client,
        context,
        subscription.latestInvoiceId,
        clock,
      );
    },
  };
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
  const owned = dependencies.client ? undefined : createPeableBillingClient(dependencies.oxy);
  const client = dependencies.client ?? owned?.client;
  if (!client) throw new Error('Peable billing workload unavailable');
  try {
    const created = createPeablePersonalRuntime(
      client,
      configuration,
      process.env.OXY_ONE_PEABLE_WEBHOOK_SECRET,
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
