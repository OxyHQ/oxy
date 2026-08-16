/**
 * Account-scoped billing (issue #972, sections 7.1, 7.4 and 7.5).
 *
 * Mounted at `/billing/accounts`, BEFORE `/billing`, so Express matches the
 * literal segment rather than treating `accounts` as a parameter of the
 * personal-billing router.
 *
 * ## The change this surface IS
 *
 * The pre-existing `/billing` routes key every read and write on the bearer's
 * own subject — `req.user._id` — which makes the billable principal an implicit
 * personal user. The audit found the consequence: an organization could own
 * applications and be billed for nothing, and a `channel` account could not
 * acquire a balance at all, because switching into a channel is refused while
 * nothing stops one from owning an application.
 *
 * Every route here takes an `accountId` in the path and authorises the caller
 * against THAT account through the account graph
 * (`resolveCallerAccountAccess`), with inheritance, per-member revokes and the
 * archived-account refusal all coming from the one membership reader. The
 * bearer's own subject is never the answer to "whose balance is this".
 *
 * ## Two rights, and which is which
 *
 * `billing:read` reads; `billing:manage` writes. Both are baseline for `owner`,
 * `admin`, `editor` and the `billing` role, absent from `developer` and
 * `viewer`, and genuinely removable by a per-member revoke
 * (`utils/accountRoles.ts`). Before this workstream almost nothing read them —
 * the audit's finding F5 — so this is the surface that gives them meaning.
 *
 * ## What is STAFF-gated, and why those three
 *
 *  - `billingMode` and `creditLimit`, because an account granting itself
 *    `invoiced` mode with a credit limit is an account issuing itself credit.
 *  - promotional grants, because that is issuing money.
 *  - invoicing, reconciliation and cost centres, because they are platform
 *    operations over other people's records rather than account settings.
 *
 * Everything else — provisioning, auto-recharge, spending limits, checkout,
 * portal — is ordinary self-service for anyone holding `billing:manage`.
 *
 * ## Not found, not forbidden
 *
 * An account the caller has no access to answers 404, never 403. Distinguishing
 * them makes the account id space an existence oracle. A caller who HAS access
 * but lacks the right permission gets 403, because at that point they already
 * know the account exists.
 */

import { Router, type Response } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { requireStaff } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import { verifyServiceToken, type ServiceTokenPayload } from '../middleware/serviceToken';
import {
  accountBillingParams,
  accountPortalBody,
  closeInvoicePeriodBody,
  createSpendingLimitBody,
  promotionalGrantBody,
  provisionBillingBody,
  reconciliationBody,
  reconciliationRunParams,
  spendingLimitAlertsQuery,
  spendingLimitParams,
  topUpCheckoutBody,
  updateBillingProfileBody,
  updateSpendingLimitBody,
} from '../schemas/accountBilling.schemas';
import {
  createSpendingLimit,
  deleteSpendingLimit,
  grantPromotionalCredit,
  listAutoRechargeAttempts,
  listSpendingLimitAlerts,
  listSpendingLimits,
  provisionAccountBilling,
  resolveAccountBillingState,
  toAutoRechargeAttempt,
  updateBillingProfile,
  updateSpendingLimit,
  type BillingProfilePatch,
} from '../services/accountBilling.service';
import {
  closeInvoicePeriod,
  listAccountInvoices,
} from '../services/accountInvoicing.service';
import {
  getReconciliationReport,
  listReconciliationRuns,
  reconcilePayments,
} from '../services/billingReconciliation.service';
import { resolveProductEntitlement } from '../services/entitlement.service';
import { resolveCallerAccountAccess } from '../services/attribution.service';
import {
  createAccountPortalSession,
  createBalanceTopUpCheckout,
  stripePaymentProcessorLedger,
} from '../services/stripeAccountBilling.service';
import { resolveBillingAccount } from '../services/inferenceLedger.service';
import { getDb } from '../config/postgres';
import { asyncHandler } from '../utils/asyncHandler';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/error';
import { isAllowedRedirect } from '../utils/redirectAllowlist';
import { logger } from '../utils/logger';
import { DEFAULT_LEDGER_CURRENCY } from '../db/schema/ledgerColumns';
import type { AccountPermission } from '../utils/accountRoles';

const router = Router();

/**
 * Reads, writes and processor round trips get separate budgets, per the
 * unique-prefix rule: two limiters sharing one Redis key make
 * `rate-limit-redis` throw `ERR_ERL_DOUBLE_COUNT` and halve both.
 *
 * Checkout is the tightest of the three. It creates a session at Stripe on every
 * call, so an unbounded loop here is an unbounded loop against a third party.
 */
const billingReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  prefix: 'rl:billing:account:read:',
});

const billingWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  prefix: 'rl:billing:account:write:',
});

const billingCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  prefix: 'rl:billing:account:checkout:',
});

/* -------------------------------------------------------------------------- */
/*  Principals                                                                */
/* -------------------------------------------------------------------------- */

interface BillingRequest extends AuthRequest {
  serviceApp?: ServiceTokenPayload;
}

type BillingPrincipal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service'; readonly service: ServiceTokenPayload };

/**
 * Dispatch between the package's two existing verifiers, adding no third.
 *
 * The same arrangement `inferenceRoutingPolicies.ts` and
 * `inferenceProviderConnections.ts` use. A bearer that is not a valid service
 * token falls through to `authMiddleware`, which produces the 401 — so an
 * expired user token is answered by the middleware that understands user tokens.
 */
const billingPrincipal = (
  req: BillingRequest,
  res: Response,
  next: (error?: unknown) => void
): void => {
  const header = req.headers.authorization;
  if (header !== undefined && header.startsWith('Bearer ')) {
    const verification = verifyServiceToken(header.slice('Bearer '.length));
    if (verification.ok) {
      req.serviceApp = verification.payload;
      next();
      return;
    }
  }
  void authMiddleware(req, res, next);
};

function principalOf(req: BillingRequest): BillingPrincipal {
  if (req.serviceApp !== undefined) {
    return { kind: 'service', service: req.serviceApp };
  }
  const userId = req.user?.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new UnauthorizedError('Authentication is required for this operation');
  }
  return { kind: 'user', userId };
}

/**
 * May this principal act on `accountId`'s billing? Throws the refusal.
 *
 * A SERVICE token reaches only its own owner account, and only for reads. There
 * is no write lane for a service credential on this surface at all: provisioning
 * a profile, moving a credit limit or starting a checkout are decisions a person
 * with `billing:manage` makes, and a machine credential that could make them
 * would put an account's financial configuration behind a key that lives in a
 * deployment environment.
 */
async function authorizeAccount(
  principal: BillingPrincipal,
  accountId: string,
  permission: AccountPermission
): Promise<void> {
  if (principal.kind === 'service') {
    if (permission !== 'billing:read') {
      throw new ForbiddenError('A service credential may not change billing configuration');
    }
    if (!principal.service.scopes.includes('inference:usage:read')) {
      throw new ForbiddenError('This credential does not carry the inference:usage:read scope');
    }
    if (principal.service.ownerAccountId !== accountId) {
      throw new NotFoundError('No billing profile is available for that account');
    }
    return;
  }

  const access = await resolveCallerAccountAccess(principal.userId, accountId);
  if (access.status === 'no-access') {
    // 404, not 403 — see the module header.
    throw new NotFoundError('No billing profile is available for that account');
  }
  if (!access.access.accountPermissions.includes(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`);
  }
}

/** The email a Stripe customer is created with, when the caller is a person. */
function callerEmail(req: BillingRequest): string | undefined {
  const email = req.user?.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/**
 * The billing account that pays for `accountId`, or a 404.
 *
 * Used by the routes that address a limit or an invoice by id: those records
 * belong to the PAYER, so addressing them through a project that merely inherits
 * has to resolve the payer first — otherwise a project's own id would never
 * match and every such route would 404 for exactly the accounts inheritance
 * exists to serve.
 */
async function requireBillingAccountId(accountId: string): Promise<string> {
  const resolution = await resolveBillingAccount(getDb(), accountId);
  if (resolution.status === 'not-provisioned') {
    throw new NotFoundError('This account has no billing profile');
  }
  return resolution.billingAccount.accountId;
}

/* -------------------------------------------------------------------------- */
/*  Profile and balance                                                       */
/* -------------------------------------------------------------------------- */

router.use(billingPrincipal);

/*
 * ORDER MATTERS. `/reconciliation/runs/:runId` is registered BEFORE the
 * `/:accountId` family, or Express is free to capture the literal
 * `reconciliation` as an account id. Same trap the bulk-follow routes and the
 * provider-connection routes record.
 */

/** `GET /billing/accounts/reconciliation/runs/:runId` — one pass and its findings. */
router.get(
  '/reconciliation/runs/:runId',
  billingReadLimiter,
  requireStaff,
  validate({ params: reconciliationRunParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { runId } = reconciliationRunParams.parse(req.params);
    const report = await getReconciliationReport(runId);
    if (report === undefined) {
      throw new NotFoundError('No such reconciliation run');
    }
    res.json({ data: report });
  })
);

/**
 * `GET /billing/accounts/:accountId`
 *
 * Who pays for this account, what they hold, and whether the money is their own.
 * The four balance buckets are separate fields with no total beside them — a
 * grant and a purchase are never one number.
 */
router.get(
  '/:accountId',
  billingReadLimiter,
  validate({ params: accountBillingParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const resolution = await resolveAccountBillingState(accountId);
    switch (resolution.status) {
      case 'resolved':
        res.json({ data: resolution.state });
        return;
      case 'not-provisioned':
        // 200 with an explicit null, not 404: the account exists and the answer
        // "nobody has decided who pays for this yet" is the one Console renders
        // a provisioning button from. A 404 would be indistinguishable from an
        // account the caller cannot see.
        res.json({ data: null, reason: 'not_provisioned' });
        return;
      case 'unknown-account':
        throw new NotFoundError('No billing profile is available for that account');
    }
  })
);

/**
 * `POST /billing/accounts/:accountId`
 *
 * Give the account a billing profile and a zeroed balance of its own.
 * Idempotent, and it deliberately does NOT short-circuit for an account that
 * currently inherits — acquiring your own profile stops you drawing on your
 * parent, which is a real decision the caller is making.
 */
router.post(
  '/:accountId',
  billingWriteLimiter,
  validate({ params: accountBillingParams, body: provisionBillingBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeAccount(principal, accountId, 'billing:manage');

    const body = provisionBillingBody.parse(req.body);
    const staff = principal.kind === 'user' && req.user?.isStaff === true;
    if (!staff && (body.billingMode !== undefined || body.creditLimit !== undefined)) {
      throw new ForbiddenError(
        'Only Oxy staff may set a billing mode or a credit limit; an account cannot issue itself credit'
      );
    }

    const result = await provisionAccountBilling({
      accountId,
      currency: body.currency,
      billingMode: body.billingMode,
      creditLimit: body.creditLimit,
    });
    if (result.status === 'unknown-account') {
      throw new NotFoundError('No billing profile is available for that account');
    }
    res.status(201).json({ data: result.state });
  })
);

/**
 * `PATCH /billing/accounts/:accountId`
 *
 * Change the account's OWN profile. Never an inherited one — see
 * `updateBillingProfile`.
 */
router.patch(
  '/:accountId',
  billingWriteLimiter,
  validate({ params: accountBillingParams, body: updateBillingProfileBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeAccount(principal, accountId, 'billing:manage');

    const body = updateBillingProfileBody.parse(req.body);
    const staff = principal.kind === 'user' && req.user?.isStaff === true;
    if (!staff && (body.billingMode !== undefined || body.creditLimit !== undefined)) {
      throw new ForbiddenError(
        'Only Oxy staff may change a billing mode or a credit limit'
      );
    }

    // An explicit field list, never a spread: this record decides whether an
    // account may spend money it does not have.
    const patch: BillingProfilePatch = {
      status: body.status,
      billingMode: body.billingMode,
      creditLimit: body.creditLimit,
      autoRechargeEnabled: body.autoRecharge?.enabled,
      autoRechargeThreshold: body.autoRecharge?.threshold,
      autoRechargeAmount: body.autoRecharge?.amount,
    };

    const result = await updateBillingProfile(accountId, patch);
    switch (result.status) {
      case 'updated':
        res.json({ data: result.profile });
        return;
      case 'not-provisioned':
        throw new NotFoundError('This account has no billing profile of its own');
      case 'incomplete-auto-recharge':
        throw new BadRequestError(
          'An enabled auto-recharge needs both a threshold and an amount; without them it is a ' +
            'setting that reads as on and never fires'
        );
    }
  })
);

/* -------------------------------------------------------------------------- */
/*  Spending limits and alerts                                                */
/* -------------------------------------------------------------------------- */

/**
 * `GET /billing/accounts/:accountId/limits`
 *
 * Every budget that bounds what this account spends — including the
 * organization's, which is what can actually refuse a project's requests.
 */
router.get(
  '/:accountId/limits',
  billingReadLimiter,
  validate({ params: accountBillingParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');
    const limits = await listSpendingLimits(accountId);
    res.json({ data: limits, count: limits.length });
  })
);

/** `POST /billing/accounts/:accountId/limits` — create a budget. */
router.post(
  '/:accountId/limits',
  billingWriteLimiter,
  validate({ params: accountBillingParams, body: createSpendingLimitBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:manage');

    const body = createSpendingLimitBody.parse(req.body);
    const result = await createSpendingLimit(accountId, body);
    switch (result.status) {
      case 'created':
        res.status(201).json({ data: result.limit });
        return;
      case 'not-provisioned':
        throw new NotFoundError('This account has no billing profile to protect');
      case 'scope-taken':
        throw new ConflictError('That scope already has a limit for this period');
      case 'scope-not-owned':
        // 404 rather than 403: the scope target may not even exist, and telling
        // a caller which of the two it is turns this into an existence oracle
        // for other accounts' applications and credentials.
        throw new NotFoundError('No such scope target under this account');
    }
  })
);

/** `PATCH /billing/accounts/:accountId/limits/:limitId` — change a ceiling. */
router.patch(
  '/:accountId/limits/:limitId',
  billingWriteLimiter,
  validate({ params: spendingLimitParams, body: updateSpendingLimitBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId, limitId } = spendingLimitParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:manage');

    const billingAccountId = await requireBillingAccountId(accountId);
    const result = await updateSpendingLimit(
      billingAccountId,
      limitId,
      updateSpendingLimitBody.parse(req.body)
    );
    if (result.status === 'unknown-limit') {
      throw new NotFoundError('No such spending limit');
    }
    res.json({ data: result.limit });
  })
);

/** `DELETE /billing/accounts/:accountId/limits/:limitId` — remove a budget. */
router.delete(
  '/:accountId/limits/:limitId',
  billingWriteLimiter,
  validate({ params: spendingLimitParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId, limitId } = spendingLimitParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:manage');

    const billingAccountId = await requireBillingAccountId(accountId);
    const result = await deleteSpendingLimit(billingAccountId, limitId);
    if (result.status === 'unknown-limit') {
      throw new NotFoundError('No such spending limit');
    }
    res.status(204).send();
  })
);

/**
 * `GET /billing/accounts/:accountId/alerts`
 *
 * Threshold crossings, newest first. Each is an EVENT recorded once per
 * `(limit, period, threshold)` — a state would re-fire on every request for the
 * rest of the period.
 */
router.get(
  '/:accountId/alerts',
  billingReadLimiter,
  validate({ params: accountBillingParams, query: spendingLimitAlertsQuery }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    const { limit } = spendingLimitAlertsQuery.parse(req.query);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');
    const alerts = await listSpendingLimitAlerts(accountId, limit);
    res.json({ data: alerts, count: alerts.length });
  })
);

/* -------------------------------------------------------------------------- */
/*  Money in                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `POST /billing/accounts/:accountId/checkout`
 *
 * A hosted checkout that funds the account's prepaid balance. The balance is NOT
 * credited here — it moves when Stripe's webhook confirms the charge, so a
 * balance is only ever credited by the processor's own confirmation.
 */
router.post(
  '/:accountId/checkout',
  billingCheckoutLimiter,
  validate({ params: accountBillingParams, body: topUpCheckoutBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:manage');

    const body = topUpCheckoutBody.parse(req.body);
    if (!isAllowedRedirect(body.successUrl) || !isAllowedRedirect(body.cancelUrl)) {
      logger.warn('Rejected account top-up with a disallowed redirect URL', { accountId });
      throw new BadRequestError('successUrl/cancelUrl must be on an allowed domain');
    }

    const result = await createBalanceTopUpCheckout({
      accountId,
      amount: body.amount,
      currency: body.currency ?? DEFAULT_LEDGER_CURRENCY,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      email: callerEmail(req),
    });
    if (result.status === 'amount-not-representable') {
      throw new BadRequestError(
        `${result.amount} cannot be charged exactly in this currency's minor unit; there is no ` +
          'correct rounding of a top-up, so it is refused rather than adjusted'
      );
    }
    res.json({ data: { sessionId: result.sessionId, url: result.url } });
  })
);

/** `POST /billing/accounts/:accountId/portal` — payment methods and invoices. */
router.post(
  '/:accountId/portal',
  billingCheckoutLimiter,
  validate({ params: accountBillingParams, body: accountPortalBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:manage');

    const { returnUrl } = accountPortalBody.parse(req.body);
    if (!isAllowedRedirect(returnUrl)) {
      logger.warn('Rejected account portal with a disallowed return URL', { accountId });
      throw new BadRequestError('returnUrl must be on an allowed domain');
    }

    const url = await createAccountPortalSession(accountId, returnUrl, callerEmail(req));
    res.json({ data: { url } });
  })
);

/**
 * `GET /billing/accounts/:accountId/auto-recharge`
 *
 * Recent automatic top-ups. Read-only: the settings live on the profile, and the
 * attempts are the record of what the sweep did with them.
 */
router.get(
  '/:accountId/auto-recharge',
  billingReadLimiter,
  validate({ params: accountBillingParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const billingAccountId = await requireBillingAccountId(accountId);
    const attempts = await listAutoRechargeAttempts(billingAccountId);
    // Through the contract's own serializer, never hand-built here: a body
    // assembled at the route is a shape the compatibility gate cannot see.
    const data = attempts.map(toAutoRechargeAttempt);
    res.json({ data, count: data.length });
  })
);

/**
 * `POST /billing/accounts/:accountId/grants` — issue promotional credit.
 *
 * STAFF ONLY. Granted credit lands in `promotional_funds`, never in
 * `purchased_funds`: it may expire, is never refundable, and is spent first.
 */
router.post(
  '/:accountId/grants',
  billingWriteLimiter,
  requireStaff,
  validate({ params: accountBillingParams, body: promotionalGrantBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    const body = promotionalGrantBody.parse(req.body);

    const result = await grantPromotionalCredit({
      accountId,
      currency: body.currency ?? DEFAULT_LEDGER_CURRENCY,
      amount: body.amount,
      // Namespaced so an operator's ticket id cannot collide with a processor
      // reference in the journal's single idempotency key space.
      idempotencyKey: `grant:${body.idempotencyKey}`,
    });
    if (result.status === 'no-billing-profile') {
      throw new NotFoundError('This account has no billing profile to credit');
    }
    res.status(result.status === 'recorded' ? 201 : 200).json({ data: result });
  })
);

/* -------------------------------------------------------------------------- */
/*  Invoices                                                                  */
/* -------------------------------------------------------------------------- */

/** `GET /billing/accounts/:accountId/invoices` — the account's own invoices. */
router.get(
  '/:accountId/invoices',
  billingReadLimiter,
  validate({ params: accountBillingParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const billingAccountId = await requireBillingAccountId(accountId);
    const invoices = await listAccountInvoices(billingAccountId);
    res.json({ data: invoices, count: invoices.length });
  })
);

/**
 * `POST /billing/accounts/:accountId/invoices` — close a period.
 *
 * STAFF ONLY, and only for an `invoiced` account. A prepaid account's charges
 * were settled from its own money at request time, so an invoice for one would
 * be a statement — and a statement that booked a rounding entry would move money
 * that has already been paid.
 */
router.post(
  '/:accountId/invoices',
  billingWriteLimiter,
  requireStaff,
  validate({ params: accountBillingParams, body: closeInvoicePeriodBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    const body = closeInvoicePeriodBody.parse(req.body);

    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);
    if (periodEnd <= periodStart) {
      throw new BadRequestError('periodEnd must be after periodStart');
    }

    const result = await closeInvoicePeriod({
      accountId,
      currency: body.currency ?? DEFAULT_LEDGER_CURRENCY,
      periodStart,
      periodEnd,
    });
    switch (result.status) {
      case 'issued':
        res.status(201).json({ data: result.invoice });
        return;
      case 'already-issued':
        res.json({ data: result.invoice });
        return;
      case 'nothing-to-invoice':
        throw new ConflictError('No unbilled settled charges in that period');
      case 'not-provisioned':
        throw new NotFoundError('This account has no billing profile');
      case 'not-invoiced':
        throw new ConflictError(
          'This account is prepaid: its charges were settled at request time, so there is ' +
            'nothing to invoice in arrears'
        );
    }
  })
);

/* -------------------------------------------------------------------------- */
/*  Entitlements                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `GET /billing/accounts/:accountId/entitlements`
 *
 * The interface a product (Alia) asks "what may this account do". Plan and
 * allowances in one section, pay-as-you-go money in another, and nothing that
 * sums them — the two are different units and #972 is explicit that confusing
 * them is the failure.
 *
 * A SERVICE credential may read its own owner account's entitlements with
 * `inference:usage:read`. That is the scope, rather than a new one, because
 * "what is this account entitled to consume" is the same question the usage
 * scope already answers — and adding a scope means a migration to the scope
 * CHECK for no additional authority.
 */
router.get(
  '/:accountId/entitlements',
  billingReadLimiter,
  validate({ params: accountBillingParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const resolution = await resolveProductEntitlement(accountId);
    if (resolution.status === 'unknown-account') {
      throw new NotFoundError('No billing profile is available for that account');
    }
    res.json({ data: resolution.entitlement });
  })
);

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `POST /billing/accounts/:accountId/reconciliation` — run a pass.
 *
 * STAFF ONLY. Compares Oxy's own record of processor payments against the
 * processor's, over a window, and PUBLISHES the difference. It repairs nothing:
 * a reconciliation that silently credited what it found would make Stripe the
 * ledger, which is the invariant this workstream exists to hold.
 */
router.post(
  '/:accountId/reconciliation',
  billingWriteLimiter,
  requireStaff,
  validate({ params: accountBillingParams, body: reconciliationBody }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    const body = reconciliationBody.parse(req.body);

    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);
    if (periodEnd <= periodStart) {
      throw new BadRequestError('periodEnd must be after periodStart');
    }

    const report = await reconcilePayments({
      ledger: stripePaymentProcessorLedger(),
      accountId,
      currency: body.currency ?? DEFAULT_LEDGER_CURRENCY,
      periodStart,
      periodEnd,
    });
    res.status(201).json({ data: report });
  })
);

/** `GET /billing/accounts/:accountId/reconciliation` — recent passes. */
router.get(
  '/:accountId/reconciliation',
  billingReadLimiter,
  requireStaff,
  validate({ params: accountBillingParams }),
  asyncHandler(async (req: BillingRequest, res: Response) => {
    const { accountId } = accountBillingParams.parse(req.params);
    const runs = await listReconciliationRuns(accountId);
    res.json({ data: runs, count: runs.length });
  })
);

export default router;
