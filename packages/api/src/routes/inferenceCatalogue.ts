/**
 * The model catalogue's HTTP surface (issue #972, workstreams 5 and 11).
 *
 * Replaces `routes/models-stats.ts`, whose four `alia-*` entries were product
 * tiers wearing model names, with per-model statistics that were literals
 * (`uptime: 100`, `isHealthy: true`, `totalRequests: 0`). ADR 0008 retires those
 * identities rather than renaming them: a compatibility alias for a name that
 * never identified a model would preserve the exact ambiguity being removed.
 *
 * ## Why `GET /models/stats` still exists
 *
 * Console reads it today (`packages/console/src/hooks/use-models.ts`, consumed
 * by its models page and its playground). The URL therefore keeps its contract
 * and serves REAL catalogue data — the envelope `{ models, count, timestamp }`
 * is unchanged so the page renders, and every entry is now a
 * `ModelCatalogueEntry`. The fabricated fields (`tier`, `creditMultiplier`,
 * `uptime`, `successRate`, `isHealthy`) are simply gone; nothing invents them.
 * Console's own migration to `GET /models` is a later PR.
 *
 * The health-shaped fields are not coming back under another name here. Relay
 * owns technical deployment health and route availability (ADR 0006); Oxy
 * exposes the customer-safe catalogue. A "stats" endpoint served by the control
 * plane can only report what the control plane knows, and inventing the rest is
 * what the retired file did.
 *
 * ## Reads are audience-scoped, and the default audience is the public one
 *
 * Every read resolves a {@link CatalogueViewer} first. No principal, a plain
 * user bearer, or a service token belonging to an ordinary application all
 * resolve to the PUBLIC viewer; only an internal/system application sees
 * `internal_alia` routes. An internal-only route and a model that does not
 * exist are deliberately the same answer, so the catalogue is never an oracle
 * for what Oxy runs internally.
 *
 * ## Publication is a separate, flagged decision
 *
 * `INFERENCE_CATALOGUE_AUDIENCE` (`config/rolloutFlags.ts`) is `internal` unless
 * a deployment says otherwise, and while it is, the PUBLIC viewer is served an
 * empty catalogue — 200 with nothing in it, because the endpoint exists and
 * answers; there is simply nothing published to them yet. Internal viewers read
 * the catalogue in both positions, which is what lets a canary populate and
 * check it before anybody outside can see it.
 *
 * The gate is here rather than in the service because publication is what an
 * HTTP surface does; `services/inferenceCatalogue.service.ts` stays the one
 * selectability predicate, and the inference edge's own route resolution is
 * deliberately unaffected — whether a model is SELLABLE and whether it is
 * LISTED are two decisions, and conflating them would let opening a listing
 * change what a request may be served.
 */

import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { isCataloguePublished } from '../config/rolloutFlags';
import { applications } from '../db/schema';
import { rateLimit } from '../middleware/rateLimiter';
import { verifyServiceToken } from '../middleware/serviceToken';
import {
  type CatalogueViewer,
  getCatalogueEntryForViewer,
  isPublicCatalogueViewer,
  listCatalogueForViewer,
  listRoutingProfiles,
  PUBLIC_CATALOGUE_VIEWER,
  resolveCatalogueViewer,
} from '../services/inferenceCatalogue.service';
import { asyncHandler } from '../utils/asyncHandler';
import { NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Catalogue reads are cheap and cacheable but still a public surface, so they
 * get their own budget rather than sharing one — `rl:inference:catalogue:`.
 * The factory REQUIRES a unique prefix: two limiters sharing one Redis key make
 * `rate-limit-redis` throw `ERR_ERL_DOUBLE_COUNT` and halve the budget.
 */
const catalogueReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  prefix: 'rl:inference:catalogue:',
});

/**
 * Whether this request is served the catalogue, and as whom.
 *
 * `served: false` is the unpublished state seen by a public viewer — not an
 * error and not a 403, because the honest description is "nothing is published
 * to you", which is what an empty collection says.
 */
type CatalogueAccess =
  | { readonly served: true; readonly viewer: CatalogueViewer }
  | { readonly served: false };

/**
 * Resolve the audience for this request, and whether this deployment publishes
 * to it.
 *
 * Reuses `verifyServiceToken` — the SAME verification the shared service-auth
 * middleware performs — rather than parsing the header itself, so there is no
 * second token-decoding path to drift. What differs is only that a missing or
 * unverifiable token is not an error here: it resolves to the public viewer,
 * which is the default-deny direction.
 *
 * A failure to LOAD the application also resolves public. A read that cannot
 * establish a principal must not fall through to the wider audience.
 *
 * The publication check is applied to the RESOLVED viewer rather than to the
 * request, so an internal application still reads the catalogue while it is
 * unpublished, and a caller cannot become internal by presenting nothing.
 */
async function catalogueAccess(req: Request): Promise<CatalogueAccess> {
  const viewer = await viewerForRequest(req);
  if (isPublicCatalogueViewer(viewer) && !isCataloguePublished()) {
    return { served: false };
  }
  return { served: true, viewer };
}

async function viewerForRequest(req: Request): Promise<CatalogueViewer> {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return PUBLIC_CATALOGUE_VIEWER;

  const verification = verifyServiceToken(header.slice('Bearer '.length));
  if (!verification.ok) return PUBLIC_CATALOGUE_VIEWER;

  const [application] = await getDb()
    .select({ type: applications.type, isInternal: applications.isInternal })
    .from(applications)
    .where(eq(applications.id, verification.payload.appId));

  return resolveCatalogueViewer(application);
}

/**
 * `GET /models/routing-profiles`
 *
 * Registered BEFORE `/:publisher/:model` so `routing-profiles` is not captured
 * as a publisher segment. Profiles are a separate collection with a separate
 * identifier space — a profile slug can never contain `/`, which is what keeps
 * "did I ask for a concrete model or for Oxy to choose one" decidable.
 */
router.get(
  '/routing-profiles',
  catalogueReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const access = await catalogueAccess(req);
    const profiles = access.served ? await listRoutingProfiles() : [];
    res.json({ data: profiles, count: profiles.length });
  })
);

/**
 * `GET /models/stats` — the URL Console still calls.
 *
 * Real catalogue data in the envelope Console already parses. See this module's
 * header for why the URL survives and why the fabricated per-model statistics
 * do not.
 */
router.get(
  '/stats',
  catalogueReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const access = await catalogueAccess(req);
    const models = access.served ? await listCatalogueForViewer(access.viewer) : [];
    res.json({ models, count: models.length, timestamp: new Date().toISOString() });
  })
);

/**
 * `GET /models` — the customer-safe catalogue.
 */
router.get(
  '/',
  catalogueReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const access = await catalogueAccess(req);
    const models = access.served ? await listCatalogueForViewer(access.viewer) : [];
    res.json({ data: models, count: models.length });
  })
);

/**
 * `GET /models/:publisher/:model` — one entry by canonical id.
 *
 * Two path segments rather than one, because a canonical model id CONTAINS a
 * slash (`openai/gpt-5`) and a single `:id` segment would never match it.
 *
 * A model the viewer may not see answers 404, identically to one that does not
 * exist. Distinguishing them would make this endpoint an existence oracle for
 * the internal catalogue — and an unpublished catalogue answers the same 404 for
 * the same reason.
 */
router.get(
  '/:publisher/:model',
  catalogueReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const access = await catalogueAccess(req);
    const modelId = `${req.params.publisher}/${req.params.model}`;
    const entry = access.served
      ? await getCatalogueEntryForViewer(access.viewer, modelId)
      : undefined;

    if (entry === undefined) {
      logger.debug(`Catalogue entry ${modelId} is not available to this viewer`);
      throw new NotFoundError(`No model ${modelId} is available to you`);
    }

    res.json({ data: entry });
  })
);

export default router;
