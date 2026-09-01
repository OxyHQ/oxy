/**
 * Request schemas for the staff catalogue-admin surface (`/inference/admin/*`).
 *
 * These lived as top-level `const`s inside `src/routes/inferenceAdmin.ts` until
 * the OpenAPI generator started resolving schema references through each route
 * file's own imports. A schema declared inside a route file cannot be resolved
 * that way — importing the route module would build its router, its rate limiters
 * and its clients — so eight operations here were published with no request body
 * and no query parameters at all. Nothing about the shapes changed in the move.
 */

import { z } from 'zod';
import { DEPLOYMENT_LEGAL_REVIEW_STATUSES } from '../db/schema';
import { DEPLOYMENT_PERMISSION_ACTIONS } from '../services/inferenceCatalogueAdmin.service';

export const deploymentParams = z.object({ deploymentId: z.string().min(1).max(128) });

export const revisionParams = z.object({ revisionId: z.string().min(1).max(128) });

/**
 * The widest window a metrics read may ask for.
 *
 * Ninety days is `inference_usage_events`' own retention, so a longer window
 * cannot produce a longer latency series — it would only widen the scan while
 * returning the same samples. Bounding it here makes that a refusal instead of a
 * quietly truncated answer.
 */
const METRICS_MAX_WINDOW_DAYS = 90;

/**
 * A UTC calendar day that EXISTS, the unit both the rollup and the window are
 * keyed in.
 *
 * The shape check alone is not enough. `Date.parse` accepts `2026-02-31` and
 * rolls it into March, so the ROUND TRIP is what rejects a day that does not
 * exist — the same check `config/rolloutFlags.ts` makes of a charging
 * authorization, and for the same reason. Without it a lexically valid impossible
 * date reaches Postgres as `'2026-02-31'::date`, which refuses it and turns the
 * caller's malformed query into a 500.
 */
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD UTC day')
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'expected a UTC day that exists');

/** Midnight UTC on a day already validated by {@link isoDay}. */
function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export const metricsQuery = z
  .object({
    from: isoDay,
    to: isoDay,
    accountId: z.string().min(1).max(128).optional(),
    applicationId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine(
    (value) =>
      (dayStart(value.to) - dayStart(value.from)) / (24 * 60 * 60 * 1000) <
      METRICS_MAX_WINDOW_DAYS,
    { message: `the window may span at most ${METRICS_MAX_WINDOW_DAYS} days`, path: ['to'] }
  );

/**
 * The action is a PATH segment from a closed set, not a body field.
 *
 * `POST /deployments/:id/approve` cannot be turned into a different action by a
 * malformed body, and an unknown verb 404s at the router before any handler
 * runs. A `{ action }` field would put the decision in mass-assignable data.
 */
export const permissionActionParams = deploymentParams.extend({
  action: z.enum(DEPLOYMENT_PERMISSION_ACTIONS),
});

export const permissionActionBody = z.object({ note: z.string().max(500).optional() }).strict();

/**
 * The spend-anomaly page size.
 *
 * A ceiling rather than an offset-paginated read: the question this answers is
 * "what fired recently", and 200 rows of it is an operator's screen. Anything
 * larger is a report, which belongs on the reporting surface with a window.
 *
 * `z.coerce.number()`, which is IDEMPOTENT and has to be: `middleware/validate`
 * writes its parsed output back onto `req.query` and the handler parses again, so
 * this schema is fed a number on the second pass. Coercing a number is the
 * identity, so both passes agree — where a transform that only accepted the string
 * form would raise `invalid_type` outside any validation boundary and answer 500.
 * That is not hypothetical; `GET /billing/cost-centers` carried exactly that
 * defect on every request.
 */
export const spendAnomalyQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();

/** The token half's read, bounded identically — see {@link spendAnomalyQuery}. */
export const tokenAnomalyQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();

export const legalReviewBody = z
  .object({
    status: z.enum(DEPLOYMENT_LEGAL_REVIEW_STATUSES),
    /**
     * A reference into the contract register. Bounded and trimmed; the schema
     * cannot tell a real matter reference from a plausible one, so the database
     * additionally refuses an approval whose reference is blank after trimming.
     */
    evidenceRef: z.string().min(1).max(200).optional(),
  })
  .strict();
