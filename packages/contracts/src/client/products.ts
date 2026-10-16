/**
 * Product access, plans, checkout and subscription checks, without Zod.
 * Schemas: `../products/*.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { OxyAccountId } from '../inference/identifiers';
import type { SubjectProductAccess, SubjectProductAccessQuery } from '../products/access';
import type {
  CancelProductSubscription,
  ProductSubscriptionCancellationResult,
  ProductSubscriptionsResponse,
  SubscriptionCreditGrantsResponse,
} from '../products/billing';
import type {
  PersonalPlanCheckoutRequest,
  PersonalPlanCheckoutResult,
  ProductPlanCheckoutRequest,
  ProductSubscriptionRenewalRequest,
} from '../products/checkout';
import type { PersonalPlanCatalogue, ProductPlanCatalogue } from '../products/plans';
import {
  array,
  boolean,
  branded,
  type Check,
  datetime,
  discriminatedUnion,
  exact,
  int,
  literal,
  maxLength,
  minLength,
  nonnegative,
  nullable,
  number,
  oneOf,
  optional,
  pattern,
  positive,
  refine,
  safe,
  startsWith,
  strictObject,
  string,
  union,
  url,
} from './check';

const identifier = string(minLength(1), maxLength(160));
const displayName = string(minLength(1), maxLength(100));
const count = number(int, nonnegative, safe);
const version = number(int, positive, safe);
const oxyAccountId = branded<OxyAccountId, string>(string(minLength(1), maxLength(64)));
const actionKey = string(minLength(8), maxLength(160), pattern(/^[a-zA-Z0-9_-]+$/));
const combination = oneOf(['maximum', 'sum', 'exclusive']);
const origin = oneOf(['individual', 'bundle']);
const purchase = oneOf(['unavailable', 'available']);
const displayPrice = <I>(interval: Check<I>) =>
  strictObject({
    currency: string(pattern(/^[A-Z]{3}$/)),
    amountMinorUnits: version,
    interval,
    trial: literal('none'),
    taxTreatment: literal('inclusive'),
    merchantTotal: literal('final'),
  });

const period = (message: string) =>
  refine(
    strictObject({ start: string(datetime), end: string(datetime) }),
    (value) => Date.parse(value.end) > Date.parse(value.start),
    message,
  );

const productBenefit = discriminatedUnion('kind', {
  capability: strictObject({ kind: literal('capability'), productId: identifier, key: identifier }),
  quota: strictObject({
    kind: literal('quota'),
    productId: identifier,
    key: identifier,
    unit: identifier,
    included: count,
    combination,
  }),
});

export const subjectProductAccessQueryCheck = exact<SubjectProductAccessQuery>()(
  strictObject({
    schemaVersion: literal(1),
    subjectAccountId: oxyAccountId,
    productId: identifier,
  }),
);

export const subjectProductAccessCheck = exact<SubjectProductAccess>()(
  strictObject({
    schemaVersion: literal(1),
    subjectAccountId: oxyAccountId,
    productId: identifier,
    evaluatedAt: string(datetime),
    capabilities: array(strictObject({ key: identifier, grantIds: array(identifier) })),
    quotas: array(
      strictObject({
        key: identifier,
        unit: identifier,
        included: count,
        combination,
        grantIds: array(identifier),
      }),
    ),
    conflicts: array(
      strictObject({
        key: identifier,
        reason: oneOf([
          'combination_mismatch',
          'unit_mismatch',
          'exclusive_overlap',
          'unsafe_total',
        ]),
        grantIds: array(identifier),
      }),
    ),
  }),
);

export const personalPlanCatalogueCheck = exact<PersonalPlanCatalogue>()(
  refine(
    strictObject({
      schemaVersion: literal(1),
      state: oneOf(['unconfigured', 'configured']),
      purchase,
      plans: array(
        strictObject({
          offerId: identifier,
          offerVersion: version,
          displayName,
          audience: literal('personal'),
          kind: literal('oxy_one'),
          price: optional(displayPrice(literal('month'))),
          benefits: array(strictObject({ displayName, benefit: productBenefit })),
        }),
      ),
    }),
    (value) => (value.state === 'unconfigured') === (value.plans.length === 0),
    'Catalogue state must match published plans',
  ),
);

export const productPlanCatalogueCheck = exact<ProductPlanCatalogue>()(
  strictObject({
    schemaVersion: literal(1),
    productId: identifier,
    purchase,
    plans: array(
      strictObject({
        productId: identifier,
        offerId: identifier,
        offerVersion: version,
        displayName,
        price: displayPrice(oneOf(['month', 'year'])),
      }),
    ),
  }),
);

const checkoutRequestShape = {
  expectedSubjectAccountId: oxyAccountId,
  offerId: identifier,
  offerVersion: version,
  idempotencyKey: actionKey,
};

export const personalPlanCheckoutRequestCheck = exact<PersonalPlanCheckoutRequest>()(
  strictObject(checkoutRequestShape),
);

export const productPlanCheckoutRequestCheck = exact<ProductPlanCheckoutRequest>()(
  strictObject({ ...checkoutRequestShape, productId: identifier }),
);

export const productSubscriptionRenewalRequestCheck = exact<ProductSubscriptionRenewalRequest>()(
  strictObject({
    expectedSubjectAccountId: oxyAccountId,
    sourceId: identifier,
    idempotencyKey: actionKey,
  }),
);

export const personalPlanCheckoutResultCheck = exact<PersonalPlanCheckoutResult>()(
  discriminatedUnion('state', {
    unconfigured: strictObject({
      state: literal('unconfigured'),
      reason: oneOf(['provider_unconfigured', 'offer_unconfigured', 'price_unconfigured']),
    }),
    pending: strictObject({
      state: literal('pending'),
      intentId: identifier,
      checkoutUrl: optional(string(url, startsWith('https://'))),
    }),
    closed: strictObject({ state: literal('closed'), intentId: identifier }),
    fulfilled: strictObject({ state: literal('fulfilled'), intentId: identifier }),
  }),
);

const billingPeriod = period('Period end must follow start');

export const productSubscriptionsResponseCheck = exact<ProductSubscriptionsResponse>()(
  strictObject({
    subscriptions: array(
      strictObject({
        sourceId: identifier,
        status: oneOf([
          'active',
          'trialing',
          'past_due',
          'unpaid',
          'canceled',
          'paused',
          'incomplete',
          'incomplete_expired',
        ]),
        period: billingPeriod,
        cancelAtPeriodEnd: boolean,
        canCancel: boolean,
        canRenew: optional(boolean),
        offers: array(
          strictObject({
            segmentId: identifier,
            offerId: identifier,
            offerVersion: version,
            displayName,
            origin,
            period: billingPeriod,
            current: boolean,
            products: array(strictObject({ id: identifier, displayName })),
          }),
        ),
      }),
    ),
  }),
);

export const subscriptionCreditGrantsResponseCheck = exact<SubscriptionCreditGrantsResponse>()(
  strictObject({
    grants: array(
      refine(
        strictObject({
          id: identifier,
          invoiceId: identifier,
          origin: oneOf([
            'subscription_payment',
            'subscription_proration',
            'subscription_promotional_grant',
          ]),
          period: billingPeriod,
          granted: count,
          consumed: count,
          clawed: count,
          remaining: count,
          promotionId: nullable(identifier),
          createdAt: string(datetime),
        }),
        (value) =>
          BigInt(value.consumed) + BigInt(value.clawed) + BigInt(value.remaining) ===
          BigInt(value.granted),
        'Grant conservation differs',
      ),
    ),
  }),
);

export const cancelProductSubscriptionCheck = exact<CancelProductSubscription>()(
  strictObject({
    sourceId: identifier,
    actionId: optional(actionKey),
    expectedSubjectAccountId: optional(oxyAccountId),
  }),
);

export const productSubscriptionCancellationResultCheck =
  exact<ProductSubscriptionCancellationResult>()(
    union(
      strictObject({ sourceId: identifier, cancelAtPeriodEnd: literal(true) }),
      strictObject({ sourceId: identifier, reconciliationPending: literal(true) }),
    ),
  );
