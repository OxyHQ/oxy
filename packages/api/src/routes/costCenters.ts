/**
 * Internal cost centres (issue #972, section 7.5).
 *
 * Mounted at `/billing/cost-centers`, BEFORE `/billing`, so Express matches the
 * literal segment rather than treating it as a parameter of the personal-billing
 * router.
 *
 * ## Staff-only, all of it
 *
 * A cost centre is how Oxy books its OWN first-party spend — Alia production
 * chat, Codea, research, voice, evaluations. It is not a customer-facing concept
 * and there is no self-service path to one, so every route here is behind
 * `requireStaff` rather than behind an account permission. A customer wanting to
 * split spend uses accounts and spending limits, which is what the account graph
 * is for.
 *
 * ## The rows are not seeded by this file
 *
 * #972 workstream 14 asks for cost centres for the five first-party workloads.
 * Those are real project accounts under the Oxy organization, and creating an
 * account is an account-graph operation, not a billing one. This surface is what
 * that work registers INTO. As of this commit the table is empty — a stated gap,
 * not something to assume was filled elsewhere.
 */

import { Router, type Response } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { requireStaff } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import {
  costCenterListQuery,
  costCenterSlugParams,
  costCenterSpendQuery,
  registerCostCenterBody,
} from '../schemas/accountBilling.schemas';
import {
  costCenterSpend,
  listCostCenters,
  registerCostCenter,
  retireCostCenter,
} from '../services/entitlement.service';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error';
import { DEFAULT_LEDGER_CURRENCY } from '../db/schema/ledgerColumns';

const router = Router();

/**
 * One budget for the whole surface. Unlike the account-billing routes there is
 * no processor round trip here and the caller set is a handful of staff, so
 * splitting reads from writes would buy nothing — but the prefix is still unique,
 * because two limiters sharing one Redis key make `rate-limit-redis` throw
 * `ERR_ERL_DOUBLE_COUNT`.
 */
const costCenterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  prefix: 'rl:billing:cost-centers:',
});

router.use(authMiddleware, requireStaff, costCenterLimiter);

/*
 * ORDER MATTERS. `/spend` is registered BEFORE `/:slug`, or Express captures the
 * literal `spend` as a slug and the report 404s against a cost centre that does
 * not exist.
 */

/**
 * `GET /billing/cost-centers/spend`
 *
 * What each cost centre spent over a window, from `usage_receipts` — the
 * FINANCIAL ledger, never a telemetry sum. Retired centres are included, because
 * a report over a past window has to be able to name a centre that has since
 * been retired or last quarter's spend silently rolls up to its parent.
 */
router.get(
  '/spend',
  validate({ query: costCenterSpendQuery }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = costCenterSpendQuery.parse(req.query);
    const periodStart = new Date(query.periodStart);
    const periodEnd = new Date(query.periodEnd);
    if (periodEnd <= periodStart) {
      throw new BadRequestError('periodEnd must be after periodStart');
    }

    const spend = await costCenterSpend({
      periodStart,
      periodEnd,
      currency: query.currency ?? DEFAULT_LEDGER_CURRENCY,
    });
    res.json({ data: spend, count: spend.length });
  })
);

/** `GET /billing/cost-centers` — the registered centres. */
router.get(
  '/',
  validate({ query: costCenterListQuery }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { includeRetired } = costCenterListQuery.parse(req.query);
    const centers = await listCostCenters(includeRetired);
    res.json({ data: centers, count: centers.length });
  })
);

/**
 * `POST /billing/cost-centers` — label an account as a cost centre.
 *
 * Idempotent on the ACCOUNT: re-registering the same account updates its label.
 * Re-using a slug for a DIFFERENT account is refused, because a slug is how
 * historical reports address a centre and silently re-pointing one would
 * re-attribute every report that names it.
 */
router.post(
  '/',
  validate({ body: registerCostCenterBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = registerCostCenterBody.parse(req.body);
    const result = await registerCostCenter(body);
    switch (result.status) {
      case 'registered':
        res.status(201).json({ data: result.costCenter });
        return;
      case 'unknown-account':
        throw new NotFoundError('No such account');
      case 'slug-taken':
        throw new ConflictError(
          `The slug ${result.slug} already names a different account; a slug is how historical ` +
            'reports address a cost centre and must never move'
        );
    }
  })
);

/**
 * `DELETE /billing/cost-centers/:slug` — retire a centre.
 *
 * A status change, not a delete. A retired centre still names the account past
 * spend was booked to, so historical reports keep resolving; new spend stops
 * being attributed to it because `resolveCostCenterForAccount` filters on
 * `active`.
 */
router.delete(
  '/:slug',
  validate({ params: costCenterSlugParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { slug } = costCenterSlugParams.parse(req.params);
    const result = await retireCostCenter(slug);
    if (result.status === 'unknown-cost-center') {
      throw new NotFoundError('No such cost centre');
    }
    res.json({ data: result.costCenter });
  })
);

export default router;
