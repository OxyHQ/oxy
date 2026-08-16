/**
 * The customer-visible usage, spend and budget surface (issue #972, workstream 8).
 *
 * Mounted at `/inference/reporting`. Everything here READS the ledger and the
 * telemetry rollups, except the two budget mutations, which are the only writes.
 * Nothing here meters, charges or refunds — that is `inferenceLedger.service.ts`.
 *
 * ## The two claims a reader should be able to check quickly
 *
 *  - **A usage figure and a billed figure come from different tables and say so
 *    in their own responses.** `/usage` reads `inference_usage_daily_rollups` and
 *    is stamped `{ source: 'usage_telemetry_rollups', consistency: 'eventual' }`;
 *    `/spend`, `/charges`, `/reservations` and `/balance` read the financial
 *    ledger and are stamped `{ source: 'financial_ledger', consistency:
 *    'authoritative' }`. Both stamps are required literals on the projection
 *    schemas, so neither can be dropped and neither can be swapped.
 *  - **Another account's numbers answer 404, never 403.** The entitlement answer
 *    and the existence answer are deliberately identical, so this surface cannot
 *    be used to discover which account, application, credential or budget ids
 *    exist — the pattern `/v1/generations/:id` and the BYOK routes already set.
 *
 * ## Two lanes, with a boundary that can be stated in one sentence
 *
 * **A service credential reaches only its OWN application's reports.** The
 * account lane — balance, account-wide usage and spend, reservations, charges,
 * exports and budgets — is USER-ONLY, because a machine credential belongs to
 * one application and an account-wide financial view is not scoped to it, and
 * because the epic treats organization-wide billing controls as high-privilege.
 * The application lane accepts either a user bearer (`usage:read` to read units,
 * `billing:read` to read money) or a service token carrying
 * `inference:usage:read` whose `appId` IS the application being asked about.
 *
 * ## Account-lane permissions
 *
 * `billing:read` for every read, `billing:manage` for a budget write. Account
 * usage is gated on `billing:read` rather than something looser because an
 * account-wide consumption report is the non-monetary half of the same financial
 * report; a developer who should see only their own application's usage reads it
 * through the application lane, where `usage:read` is enough.
 */

import { Router, type Response } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { verifyServiceToken, type ServiceTokenPayload } from '../middleware/serviceToken';
import {
  applicationSpendReportQuery,
  applicationUsageReportQuery,
  chargeExportQuery,
  chargeListQuery,
  LEDGER_AUTHORITATIVE_NOTE,
  MAX_REPORTING_ROWS,
  reportingAccountParams,
  reportingApplicationParams,
  reservationListQuery,
  spendingLimitCreateBody,
  spendingLimitParams,
  spendingLimitUpdateBody,
  spendingLimitAlertsQuery,
  spendingLimitAlertsSchema,
  spendingLimitsSchema,
  spendReportQuery,
  spendReportSchema,
  usageReportQuery,
  usageReportSchema,
  USAGE_EVENTUAL_CONSISTENCY_NOTE,
  accountBalanceSchema,
  pendingReservationsSchema,
  settledChargesSchema,
  type AccountBalanceDto,
  type PendingReservationDto,
  type PendingReservationsDto,
  type SettledChargeDto,
  type SettledChargesDto,
  type SpendAggregateRowDto,
  type SpendDimension,
  type SpendingLimitViewDto,
  type SpendingLimitAlertsDto,
  type SpendingLimitsDto,
  type SpendReportDto,
  type SpendTotalDto,
  type UsageAggregateRowDto,
  type UsageDimension,
  type UsageReportDto,
} from '../schemas/inferenceReporting.schemas';
import {
  resolveCallerAccountAccess,
  resolveCallerApplicationAccess,
} from '../services/attribution.service';
import {
  aggregateSpend,
  aggregateUsage,
  createSpendingLimit,
  listPendingReservations,
  listSettledCharges,
  listSpendingLimits,
  readAccountBalance,
  readSpendingLimitOwner,
  resolveReportingAccounts,
  resolveSpendingLimitScopeOwner,
  updateSpendingLimit,
  type SettledChargeRow,
  type SpendAggregateResult,
  type SpendingLimitReport,
  type UsageAggregateResult,
} from '../services/inferenceReporting.service';
import { listSpendingLimitAlerts } from '../services/spendingLimit.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import type { AccountPermission, ApplicationPermission } from '../utils/accountRoles';

const router = Router();

/**
 * Three budgets, because two limiters sharing one Redis key make
 * `rate-limit-redis` throw `ERR_ERL_DOUBLE_COUNT` and halve both. Exports get
 * their own, much smaller, because one export can be fifty thousand rows.
 */
const reportingReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  prefix: 'rl:inference:reporting:read:',
});

const reportingExportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  prefix: 'rl:inference:reporting:export:',
});

const reportingBudgetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  prefix: 'rl:inference:reporting:budget:',
});

/* -------------------------------------------------------------------------- */
/*  Principals                                                                */
/* -------------------------------------------------------------------------- */

type ReportingPrincipal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service'; readonly service: ServiceTokenPayload };

interface ReportingRequest extends AuthRequest {
  serviceApp?: ServiceTokenPayload;
}

/**
 * Dispatch between the package's two existing verifiers, adding no third
 * parsing path: a bearer that verifies as a service token takes the service
 * lane, and anything else is answered by `authMiddleware` — so an expired user
 * token gets the 401 from the middleware that understands user tokens.
 */
const reportingPrincipal = (
  req: ReportingRequest,
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

function principalOf(req: ReportingRequest): ReportingPrincipal {
  if (req.serviceApp !== undefined) {
    return { kind: 'service', service: req.serviceApp };
  }
  const userId = req.user?.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new UnauthorizedError('Authentication is required for this operation');
  }
  return { kind: 'user', userId };
}

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

/** The one refusal every account-lane check gives, whatever the reason. */
const ACCOUNT_NOT_FOUND = 'No usage or spend report is available for that account';

/** The one refusal every application-lane check gives. */
const APPLICATION_NOT_FOUND = 'No usage or spend report is available for that application';

/** The one refusal a budget gives, whether it is missing or simply not yours. */
const BUDGET_NOT_FOUND = 'No such budget';

/** The one refusal a proposed budget's scope target gives. */
const BUDGET_TARGET_NOT_FOUND = 'No such budget scope target';

/**
 * May this principal read or write the account's own reports?
 *
 * Throws the answer rather than returning it: every caller's response to a
 * refusal is identical, and a boolean would make "forgot to check the result" a
 * silent authorisation.
 *
 * A SERVICE token is refused outright here — not for want of a scope, but
 * because the account lane is not a machine surface at all. It gets the same 404
 * everyone unauthorised gets, so a credential cannot enumerate accounts either.
 *
 * `notFound` exists because a 404 whose MESSAGE differs by reason is still an
 * oracle. When this check guards a budget reached by its own id, the refusal has
 * to read exactly like the refusal for a budget that does not exist — otherwise
 * "no such budget" versus "that account is not yours" tells a stranger which
 * budget ids are real.
 */
async function authorizeAccount(
  principal: ReportingPrincipal,
  accountId: string,
  permission: AccountPermission,
  notFound: string = ACCOUNT_NOT_FOUND
): Promise<void> {
  if (principal.kind === 'service') {
    throw new NotFoundError(notFound);
  }

  const access = await resolveCallerAccountAccess(principal.userId, accountId);
  if (access.status === 'no-access') {
    // Same answer as an unknown account: distinguishing them would make this an
    // existence oracle for other tenants' accounts.
    throw new NotFoundError(notFound);
  }
  if (!access.access.accountPermissions.includes(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`);
  }
}

/** May this principal read one application's reports? */
async function authorizeApplication(
  principal: ReportingPrincipal,
  applicationId: string,
  permission: ApplicationPermission
): Promise<void> {
  if (principal.kind === 'service') {
    if (!principal.service.scopes.includes('inference:usage:read')) {
      throw new ForbiddenError('This credential does not carry the inference:usage:read scope');
    }
    // A service token reaches only its OWN application. Without this, any
    // credential holding the scope could read any tenant's usage and spend.
    if (principal.service.appId !== applicationId) {
      throw new NotFoundError(APPLICATION_NOT_FOUND);
    }
    return;
  }

  // A historical report must still be able to name a soft-deleted application's
  // spend, so the caller's access is resolved WITH deleted applications
  // included; access itself still comes from the owning account.
  const access = await resolveCallerApplicationAccess(principal.userId, applicationId, {
    includeDeleted: true,
  });
  if (access.status !== 'resolved') {
    throw new NotFoundError(APPLICATION_NOT_FOUND);
  }
  if (!access.access.access.applicationPermissions.includes(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Account lane                                                              */
/* -------------------------------------------------------------------------- */

router.use(reportingPrincipal);

/**
 * `GET /inference/reporting/accounts/:accountId/balance`
 *
 * Purchased, promotional and reserved money as three distinct amounts, plus what
 * an invoiced account still owes. There is deliberately no single "balance"
 * number: a reservation is not money spent, and presenting the two as one makes
 * a balance appear to drop and recover on every request.
 */
router.get(
  '/accounts/:accountId/balance',
  reportingReadLimiter,
  validate({ params: reportingAccountParams }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const balance = await readAccountBalance(accountId);
    const dto: AccountBalanceDto =
      balance.status === 'not-provisioned'
        ? {
            schemaVersion: 1,
            consistency: 'authoritative',
            source: 'financial_ledger',
            note: LEDGER_AUTHORITATIVE_NOTE,
            accountId,
            provisioned: false,
            balances: [],
          }
        : {
            schemaVersion: 1,
            consistency: 'authoritative',
            source: 'financial_ledger',
            note: LEDGER_AUTHORITATIVE_NOTE,
            accountId,
            provisioned: true,
            billingAccountId: balance.billingAccountId,
            billingMode: balance.billingMode,
            creditLimit: balance.creditLimit,
            balances: balance.buckets.map((bucket) => ({
              currency: bucket.currency,
              purchased: bucket.purchased,
              promotional: bucket.promotional,
              reserved: bucket.reserved,
              invoicedOutstanding: bucket.invoicedOutstanding,
              availableToSpend: bucket.availableToSpend,
            })),
          };

    res.json({ data: accountBalanceSchema.parse(dto) });
  })
);

/**
 * `GET /inference/reporting/accounts/:accountId/usage`
 *
 * Served entirely by `inference_usage_daily_rollups`. Units and counts, never
 * money — and the response says so about itself.
 */
router.get(
  '/accounts/:accountId/usage',
  reportingReadLimiter,
  validate({ params: reportingAccountParams, query: usageReportQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    const query = usageReportQuery.parse(req.query);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const accountIds = await resolveReportingAccounts(accountId, query.includeDescendants);
    const usage = await aggregateUsage({
      accountIds,
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      applicationId: query.applicationId,
      applicationCredentialId: query.applicationCredentialId,
      environment: query.environment,
      limit: MAX_REPORTING_ROWS,
    });

    res.json({ data: usageReportSchema.parse(usageDto(query, usage)) });
  })
);

/**
 * `GET /inference/reporting/accounts/:accountId/spend`
 *
 * Served entirely by `usage_receipts`, with reversals from `usage_refunds`. This
 * is the number a bill reconciles against; the usage report above is not.
 */
router.get(
  '/accounts/:accountId/spend',
  reportingReadLimiter,
  validate({ params: reportingAccountParams, query: spendReportQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    const query = spendReportQuery.parse(req.query);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const accountIds = await resolveReportingAccounts(accountId, query.includeDescendants);
    const spend = await aggregateSpend({
      accountIds,
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      applicationId: query.applicationId,
      applicationCredentialId: query.applicationCredentialId,
      environment: query.environment,
      limit: MAX_REPORTING_ROWS,
    });

    res.json({ data: spendReportSchema.parse(spendDto(query, spend)) });
  })
);

/**
 * `GET /inference/reporting/accounts/:accountId/reservations`
 *
 * Money HELD against in-flight requests. Nothing on this list has been charged.
 */
router.get(
  '/accounts/:accountId/reservations',
  reportingReadLimiter,
  validate({ params: reportingAccountParams, query: reservationListQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    const query = reservationListQuery.parse(req.query);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const accountIds = await resolveReportingAccounts(accountId, query.includeDescendants);
    const held = await listPendingReservations({ accountIds, limit: query.limit });

    const dto: PendingReservationsDto = {
      schemaVersion: 1,
      consistency: 'authoritative',
      source: 'financial_ledger',
      note: LEDGER_AUTHORITATIVE_NOTE,
      rows: held.rows.map(
        (row): PendingReservationDto => ({
          reservationId: row.reservationId,
          requestId: row.requestId,
          applicationId: row.applicationId,
          applicationCredentialId: row.applicationCredentialId,
          environment: row.environment,
          reservedAmount: row.reservedAmount,
          currency: row.currency,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        })
      ),
      totals: held.totals.map((total) => ({
        currency: total.currency,
        reservationCount: total.reservationCount,
        heldAmount: total.heldAmount,
      })),
      truncated: held.truncated,
    };
    res.json({ data: pendingReservationsSchema.parse(dto) });
  })
);

/**
 * `GET /inference/reporting/accounts/:accountId/charges`
 *
 * Individual settled charges — the counterpart of the reservations list, and the
 * per-request detail behind the spend aggregate.
 */
router.get(
  '/accounts/:accountId/charges',
  reportingReadLimiter,
  validate({ params: reportingAccountParams, query: chargeListQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    const query = chargeListQuery.parse(req.query);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const accountIds = await resolveReportingAccounts(accountId, query.includeDescendants);
    const charges = await listSettledCharges({
      accountIds,
      from: query.from,
      to: query.to,
      applicationId: query.applicationId,
      applicationCredentialId: query.applicationCredentialId,
      limit: query.limit,
    });

    const dto: SettledChargesDto = {
      schemaVersion: 1,
      consistency: 'authoritative',
      source: 'financial_ledger',
      note: LEDGER_AUTHORITATIVE_NOTE,
      range: { from: query.from, to: query.to },
      rows: charges.rows.map(settledChargeDto),
      truncated: charges.truncated,
    };
    res.json({ data: settledChargesSchema.parse(dto) });
  })
);

/**
 * `GET /inference/reporting/accounts/:accountId/charges/export`
 *
 * The same settled charges as CSV, for enterprise reconciliation. Reads the
 * financial ledger, so a customer's spreadsheet and their invoice are computed
 * from one record.
 *
 * Registration order does not matter here, unlike the `/:policyId` trap the
 * routing-policy routes record: `/charges` ends at a literal segment and takes
 * no trailing parameter, so it cannot swallow `/charges/export`. It sits after
 * its sibling for the reader, not for the router.
 */
router.get(
  '/accounts/:accountId/charges/export',
  reportingExportLimiter,
  validate({ params: reportingAccountParams, query: chargeExportQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    const query = chargeExportQuery.parse(req.query);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const accountIds = await resolveReportingAccounts(accountId, query.includeDescendants);
    const charges = await listSettledCharges({
      accountIds,
      from: query.from,
      to: query.to,
      applicationId: query.applicationId,
      limit: query.limit,
    });

    // Every row goes through `settledChargesSchema` before it is rendered, so
    // the export cannot carry a field the JSON projection refuses — including
    // upstream wholesale cost.
    const exportDto: SettledChargesDto = {
      schemaVersion: 1,
      consistency: 'authoritative',
      source: 'financial_ledger',
      note: LEDGER_AUTHORITATIVE_NOTE,
      range: { from: query.from, to: query.to },
      rows: charges.rows.map(settledChargeDto),
      truncated: charges.truncated,
    };
    const validated = settledChargesSchema.parse(exportDto);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="oxy-charges-${query.from}-to-${query.to}.csv"`
    );
    // A truncated export is a silently short invoice, so it is announced in a
    // header rather than only in a field nothing in a CSV reader can show.
    res.setHeader('X-Oxy-Export-Truncated', validated.truncated ? 'true' : 'false');
    res.send(renderChargesCsv(charges.rows));
  })
);

/* -------------------------------------------------------------------------- */
/*  Budgets                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `GET /inference/reporting/accounts/:accountId/spending-limits`
 *
 * Every budget the account owns, with what has been spent against each — read
 * through the same query the reservation path enforces with.
 */
router.get(
  '/accounts/:accountId/spending-limits',
  reportingReadLimiter,
  validate({ params: reportingAccountParams }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const rows = await listSpendingLimits(accountId);
    const dto: SpendingLimitsDto = {
      schemaVersion: 1,
      consistency: 'authoritative',
      source: 'financial_ledger',
      note: LEDGER_AUTHORITATIVE_NOTE,
      rows: rows.map(spendingLimitDto),
    };
    res.json({ data: spendingLimitsSchema.parse(dto) });
  })
);

/**
 * `GET /inference/reporting/accounts/:accountId/spending-limits/alerts`
 *
 * Threshold crossings on the account's budgets, newest first (#972 section 7.1).
 * `billing:read`, matching the budget listing above: seeing that a budget passed
 * 75% is the same right as seeing the budget.
 *
 * Registered BEFORE `POST /accounts/:accountId/spending-limits` only for
 * readability — the two differ by method — but ahead of any future
 * `/spending-limits/:id` under this prefix, which would otherwise capture
 * `alerts` as an id.
 */
router.get(
  '/accounts/:accountId/spending-limits/alerts',
  reportingReadLimiter,
  validate({ params: reportingAccountParams, query: spendingLimitAlertsQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    const { limit } = spendingLimitAlertsQuery.parse(req.query);
    await authorizeAccount(principalOf(req), accountId, 'billing:read');

    const rows = await listSpendingLimitAlerts(accountId, limit);
    const dto: SpendingLimitAlertsDto = {
      schemaVersion: 1,
      consistency: 'authoritative',
      source: 'financial_ledger',
      note: LEDGER_AUTHORITATIVE_NOTE,
      rows: rows.map((row) => ({
        alertId: row.alertId,
        spendingLimitId: row.spendingLimitId,
        periodStart: row.periodStart.toISOString(),
        thresholdBps: row.thresholdBps,
        spendAmount: row.spendAmount,
        createdAt: row.createdAt.toISOString(),
      })),
    };
    res.json({ data: spendingLimitAlertsSchema.parse(dto) });
  })
);

/**
 * `POST /inference/reporting/accounts/:accountId/spending-limits`
 *
 * Create a budget. `billing:manage`, because the epic treats organization-wide
 * billing controls as high-privilege — a `billing:read` holder can see a budget
 * and cannot raise one.
 *
 * The scope target is resolved to its OWNING account server-side and checked
 * against the account in the path, so naming another tenant's application id in
 * the body attaches nothing to it.
 */
router.post(
  '/accounts/:accountId/spending-limits',
  reportingBudgetLimiter,
  validate({ params: reportingAccountParams, body: spendingLimitCreateBody }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { accountId } = reportingAccountParams.parse(req.params);
    const body = spendingLimitCreateBody.parse(req.body);
    const principal = principalOf(req);
    await authorizeAccount(principal, accountId, 'billing:manage');

    const owner = await resolveSpendingLimitScopeOwner(body);
    if (owner.status === 'unknown-target') {
      throw new NotFoundError(BUDGET_TARGET_NOT_FOUND);
    }

    // The target must belong to the account paying for it, or to a descendant of
    // it. Reusing the caller's own `billing:manage` check on the TARGET's owner
    // is what makes that true through inheritance rather than by a second tree
    // walk that could disagree with the first — and it refuses with the SAME
    // message an unknown target gets, so an application id belonging to another
    // tenant is indistinguishable from one that does not exist.
    if (owner.ownerAccountId !== accountId) {
      await authorizeAccount(
        principal,
        owner.ownerAccountId,
        'billing:manage',
        BUDGET_TARGET_NOT_FOUND
      );
    }

    const created = await createSpendingLimit(accountId, body);
    if (created.status === 'scope-taken') {
      throw new ConflictError(
        'That scope already has a budget for this period; edit it or disable it first'
      );
    }

    const rows = await listSpendingLimits(accountId);
    const view = rows.find((row) => row.spendingLimitId === created.spendingLimitId);
    if (view === undefined) {
      throw new NotFoundError(BUDGET_NOT_FOUND);
    }
    res.status(201).json({ data: spendingLimitViewOf(view) });
  })
);

/**
 * `PATCH /inference/reporting/spending-limits/:spendingLimitId`
 *
 * Raise, lower, re-arm or disable a budget. The SCOPE is not editable:
 * re-pointing a budget would silently re-interpret every threshold alert already
 * recorded against it.
 */
router.patch(
  '/spending-limits/:spendingLimitId',
  reportingBudgetLimiter,
  validate({ params: spendingLimitParams, body: spendingLimitUpdateBody }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { spendingLimitId } = spendingLimitParams.parse(req.params);
    const body = spendingLimitUpdateBody.parse(req.body);

    const ownerAccountId = await readSpendingLimitOwner(spendingLimitId);
    if (ownerAccountId === undefined) {
      throw new NotFoundError(BUDGET_NOT_FOUND);
    }
    // Same message a missing budget gets: a 404 whose text differs by reason
    // still tells a stranger which budget ids are real.
    await authorizeAccount(principalOf(req), ownerAccountId, 'billing:manage', BUDGET_NOT_FOUND);

    const updated = await updateSpendingLimit(spendingLimitId, body);
    if (updated.status === 'unknown-limit') {
      throw new NotFoundError(BUDGET_NOT_FOUND);
    }

    const rows = await listSpendingLimits(ownerAccountId);
    const view = rows.find((row) => row.spendingLimitId === spendingLimitId);
    if (view === undefined) {
      throw new NotFoundError(BUDGET_NOT_FOUND);
    }
    res.json({ data: spendingLimitViewOf(view) });
  })
);

/* -------------------------------------------------------------------------- */
/*  Application lane                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `GET /inference/reporting/applications/:applicationId/usage`
 *
 * One application's usage. `usage:read` for a person; `inference:usage:read` for
 * a service token whose own `appId` is this application.
 */
router.get(
  '/applications/:applicationId/usage',
  reportingReadLimiter,
  validate({ params: reportingApplicationParams, query: applicationUsageReportQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { applicationId } = reportingApplicationParams.parse(req.params);
    const query = applicationUsageReportQuery.parse(req.query);
    await authorizeApplication(principalOf(req), applicationId, 'usage:read');

    const usage = await aggregateUsage({
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      applicationId,
      applicationCredentialId: query.applicationCredentialId,
      environment: query.environment,
      limit: MAX_REPORTING_ROWS,
    });

    res.json({ data: usageReportSchema.parse(usageDto(query, usage)) });
  })
);

/**
 * `GET /inference/reporting/applications/:applicationId/spend`
 *
 * One application's settled spend — the epic's "spending by application, model,
 * provider and time", grouped however the caller asks. `billing:read` for a
 * person: money is a stricter read than units.
 */
router.get(
  '/applications/:applicationId/spend',
  reportingReadLimiter,
  validate({ params: reportingApplicationParams, query: applicationSpendReportQuery }),
  asyncHandler(async (req: ReportingRequest, res: Response) => {
    const { applicationId } = reportingApplicationParams.parse(req.params);
    const query = applicationSpendReportQuery.parse(req.query);
    await authorizeApplication(principalOf(req), applicationId, 'billing:read');

    const spend = await aggregateSpend({
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      applicationId,
      applicationCredentialId: query.applicationCredentialId,
      environment: query.environment,
      limit: MAX_REPORTING_ROWS,
    });

    res.json({ data: spendReportSchema.parse(spendDto(query, spend)) });
  })
);

/* -------------------------------------------------------------------------- */
/*  Serialization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The usage response, with its provenance stamp.
 *
 * Every row is written out FIELD BY FIELD rather than spread, and every literal
 * carries a declared type. That is load-bearing rather than decorative: an
 * object literal with a declared type gets TypeScript's excess-property check,
 * so adding a money field — or an upstream wholesale cost — is a compile error
 * here, not something the runtime `.strict()` parse alone has to catch. A spread
 * would switch that check off at exactly the boundary it is guarding.
 */
function usageDto(
  query: { from: string; to: string; groupBy: readonly UsageDimension[] },
  usage: UsageAggregateResult
): UsageReportDto {
  const dto: UsageReportDto = {
    schemaVersion: 1,
    consistency: 'eventual',
    source: 'usage_telemetry_rollups',
    note: USAGE_EVENTUAL_CONSISTENCY_NOTE,
    range: { from: query.from, to: query.to },
    groupBy: [...query.groupBy],
    rows: usage.rows.map(
      (row): UsageAggregateRowDto => ({
        day: row.day,
        accountId: row.accountId,
        applicationId: row.applicationId,
        applicationCredentialId: row.applicationCredentialId,
        environment: row.environment,
        requestedModelReference: row.requestedModelReference,
        servingProvider: row.servingProvider,
        outcome: row.outcome,
        requestCount: row.requestCount,
        errorCount: row.errorCount,
        units: row.units,
      })
    ),
    truncated: usage.truncated,
  };
  return dto;
}

/** The spend response, with its provenance stamp. */
function spendDto(
  query: { from: string; to: string; groupBy: readonly SpendDimension[] },
  spend: SpendAggregateResult
): SpendReportDto {
  const dto: SpendReportDto = {
    schemaVersion: 1,
    consistency: 'authoritative',
    source: 'financial_ledger',
    note: LEDGER_AUTHORITATIVE_NOTE,
    range: { from: query.from, to: query.to },
    groupBy: [...query.groupBy],
    rows: spend.rows.map(
      (row): SpendAggregateRowDto => ({
        day: row.day,
        accountId: row.accountId,
        applicationId: row.applicationId,
        applicationCredentialId: row.applicationCredentialId,
        environment: row.environment,
        resolvedModelReference: row.resolvedModelReference,
        servingProvider: row.servingProvider,
        outcome: row.outcome,
        currency: row.currency,
        receiptCount: row.receiptCount,
        billedAmount: row.billedAmount,
        refundedAmount: row.refundedAmount,
        netAmount: row.netAmount,
      })
    ),
    totals: spend.totals.map(
      (total): SpendTotalDto => ({
        currency: total.currency,
        receiptCount: total.receiptCount,
        billedAmount: total.billedAmount,
        refundedAmount: total.refundedAmount,
        netAmount: total.netAmount,
      })
    ),
    truncated: spend.truncated,
  };
  return dto;
}

/** One settled charge, field by field, for the same reason `usageDto` is. */
function settledChargeDto(row: SettledChargeRow): SettledChargeDto {
  return {
    receiptId: row.receiptId,
    requestId: row.requestId,
    generationId: row.generationId,
    reservationId: row.reservationId,
    correctsReceiptId: row.correctsReceiptId,
    applicationId: row.applicationId,
    applicationCredentialId: row.applicationCredentialId,
    environment: row.environment,
    outcome: row.outcome,
    usageSource: row.usageSource,
    resolvedModelReference: row.resolvedModelReference,
    servingProvider: row.servingProvider,
    platformFeeOnly: row.platformFeeOnly,
    billedAmount: row.billedAmount,
    refundedAmount: row.refundedAmount,
    netAmount: row.netAmount,
    currency: row.currency,
    settledAt: row.settledAt,
    units: row.units,
  };
}

/** One budget, field by field. */
function spendingLimitDto(view: SpendingLimitReport): SpendingLimitViewDto {
  return {
    spendingLimitId: view.spendingLimitId,
    accountId: view.accountId,
    scope: view.scope,
    scopeAccountId: view.scopeAccountId,
    scopeApplicationId: view.scopeApplicationId,
    scopeApplicationCredentialId: view.scopeApplicationCredentialId,
    period: view.period,
    limitAmount: view.limitAmount,
    currency: view.currency,
    enforcement: view.enforcement,
    alertThresholdBps: view.alertThresholdBps,
    status: view.status,
    periodStart: view.periodStart,
    currentSpend: view.currentSpend,
    remaining: view.remaining,
    utilizationBps: view.utilizationBps,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/**
 * One budget, parsed through the LIST projection so a write answers exactly what
 * a read would — rather than a second serializer that could drift from it.
 */
function spendingLimitViewOf(view: SpendingLimitReport) {
  const dto: SpendingLimitsDto = {
    schemaVersion: 1,
    consistency: 'authoritative',
    source: 'financial_ledger',
    note: LEDGER_AUTHORITATIVE_NOTE,
    rows: [spendingLimitDto(view)],
  };
  return spendingLimitsSchema.parse(dto).rows[0];
}

/* -------------------------------------------------------------------------- */
/*  CSV                                                                       */
/* -------------------------------------------------------------------------- */

/** The export's columns, in order. Money and units side by side, never merged. */
const CSV_COLUMNS = [
  'receipt_id',
  'request_id',
  'generation_id',
  'reservation_id',
  'corrects_receipt_id',
  'settled_at',
  'application_id',
  'application_credential_id',
  'environment',
  'outcome',
  'usage_source',
  'resolved_model_reference',
  'serving_provider',
  'platform_fee_only',
  'currency',
  'billed_amount',
  'refunded_amount',
  'net_amount',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'requests',
  'images',
  'audio_input_milliseconds',
  'audio_output_milliseconds',
  'video_milliseconds',
  'characters',
  'embeddings',
] as const;

/**
 * One CSV cell.
 *
 * Quoted always, with embedded quotes doubled — RFC 4180. A cell whose first
 * character would make a spreadsheet evaluate it as a formula is prefixed with
 * an apostrophe: none of these values should ever begin that way, and the guard
 * costs nothing precisely because it never fires on well-formed data.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function renderChargesCsv(rows: readonly SettledChargeRow[]): string {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.receiptId,
        row.requestId,
        row.generationId ?? '',
        row.reservationId ?? '',
        row.correctsReceiptId ?? '',
        row.settledAt,
        row.applicationId,
        row.applicationCredentialId,
        row.environment,
        row.outcome,
        row.usageSource,
        row.resolvedModelReference,
        row.servingProvider,
        row.platformFeeOnly ? 'true' : 'false',
        row.currency,
        row.billedAmount,
        row.refundedAmount,
        row.netAmount,
        String(row.units.input_tokens),
        String(row.units.cached_input_tokens),
        String(row.units.output_tokens),
        String(row.units.reasoning_tokens),
        String(row.units.requests),
        String(row.units.images),
        String(row.units.audio_input_milliseconds),
        String(row.units.audio_output_milliseconds),
        String(row.units.video_milliseconds),
        String(row.units.characters),
        String(row.units.embeddings),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export default router;
