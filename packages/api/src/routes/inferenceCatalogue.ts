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
 * Every read resolves a {@link CatalogueViewer} first, from EITHER credential
 * lane — a verified service token or an `oxy_sk_…` machine credential, which is
 * the bearer a stock OpenAI SDK sends to `client.models.list()`. No principal, a
 * plain user bearer, or a credential of either kind belonging to an ordinary
 * application all resolve to the PUBLIC viewer; only an internal/system
 * application sees `internal_alia` routes. An internal-only route and a model
 * that does not exist are deliberately the same answer, so the catalogue is never
 * an oracle for what Oxy runs internally. See {@link viewerForRequest} for why
 * the lane order and its rollout flag are the inference edge's own.
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
import { z } from 'zod';
import { modelRevisionLabelSchema } from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { isCataloguePublished, isMachineCredentialLaneEnabled } from '../config/rolloutFlags';
import { applications } from '../db/schema';
import { extractTokenFromRequest } from '../middleware/authUtils';
import { resolveMachineCredential } from '../middleware/machineCredential';
import { rateLimit } from '../middleware/rateLimiter';
import { verifyServiceToken } from '../middleware/serviceToken';
import { validate } from '../middleware/validate';
import { getRevisionDocumentation } from '../services/inferenceModelDocumentation.service';
import { machineCredentialTokenPrefix } from '../utils/machineCredentialToken';
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
 * A missing or unresolvable bearer is not an error here: it resolves to the
 * public viewer, which is the default-deny direction. A failure to LOAD the
 * application resolves public for the same reason — a read that cannot establish
 * a principal must not fall through to the wider audience.
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

/**
 * The audience this request belongs to.
 *
 * ## BOTH credential lanes, because a stock SDK uses both endpoints
 *
 * `client.models.list()` is the second call every OpenAI-compatible client
 * makes, and it sends the same `oxy_sk_…` bearer that authenticated
 * `POST /v1/chat/completions`. A machine credential is NOT a JWT, so resolving
 * this header through `verifyServiceToken` alone made every such caller an
 * anonymous public viewer — authenticated on the edge and unknown here, with no
 * error to notice, at every flag setting.
 *
 * So both lanes resolve an APPLICATION ID and nothing else: this endpoint reads
 * an audience, not a spend authorization, and the two application columns below
 * are all an audience is derived from.
 *
 * ## The lane order and the flag are the EDGE's, deliberately
 *
 * `authenticateEdgeCaller` (`services/inferenceEdge.service.ts`) refuses a
 * machine-prefixed bearer outright when `INFERENCE_MACHINE_CREDENTIAL_AUTH` is
 * not `enabled`, before any lookup, rather than letting it fall through to the
 * service lane. This mirrors that exactly, so the two endpoints agree about who
 * the caller is in EVERY flag state and a machine credential can never be more
 * privileged on the catalogue than it is on the edge. What differs is only the
 * consequence of a refusal: the edge answers 401, and a catalogue read that
 * cannot establish a principal is served the public audience.
 *
 * ## One mapping, and it is `resolveCatalogueViewer`
 *
 * The edge's `viewerForPrincipal` is a two-line adapter over the very same
 * `resolveCatalogueViewer` call this function ends in — it is not a second
 * mapping, and calling it from here would mean fabricating five `EdgePrincipal`
 * fields it does not read (a lane, a credential id, an owner account, an
 * environment and a scope list) purely to reach the two it does. Both endpoints
 * therefore map through ONE function, which is the property that matters: a
 * widening of the internal audience cannot land on one endpoint and miss the
 * other.
 *
 * Scopes are deliberately not consulted, on either lane, exactly as the edge's
 * own audience resolution does not consult them. `inference:models:read` gates
 * what a credential may DO; the audience decides what EXISTS for it to see, and
 * conflating the two would make an unscoped credential see a different catalogue
 * from the one it is refused access to.
 */
async function viewerForRequest(req: Request): Promise<CatalogueViewer> {
  const token = extractTokenFromRequest(req);
  if (token === undefined) return PUBLIC_CATALOGUE_VIEWER;

  const applicationId = await applicationForBearer(token);
  if (applicationId === undefined) return PUBLIC_CATALOGUE_VIEWER;

  const [application] = await getDb()
    .select({ type: applications.type, isInternal: applications.isInternal })
    .from(applications)
    .where(eq(applications.id, applicationId));

  return resolveCatalogueViewer(application);
}

/**
 * The application a bearer identifies, or `undefined` when it identifies none.
 *
 * `undefined` covers every distinguishable failure — a plain user session token,
 * an unverifiable JWT, a revoked or expired machine credential, a machine bearer
 * presented while the lane is shut — because the caller's next move is the same
 * for all of them and the catalogue never reports which it was. Distinguishing
 * them would turn a public read into an oracle on a credential's lifecycle.
 */
async function applicationForBearer(token: string): Promise<string | undefined> {
  if (machineCredentialTokenPrefix(token) !== null) {
    if (!isMachineCredentialLaneEnabled()) return undefined;
    const machine = await resolveMachineCredential(token);
    return machine.ok ? machine.principal.applicationId : undefined;
  }

  const verification = verifyServiceToken(token);
  return verification.ok ? verification.payload.appId : undefined;
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
 * The revision a documentation read may name.
 *
 * `modelRevisionLabelSchema` and nothing looser: the label is interpolated into
 * an equality predicate, and the contract's own grammar is what says which
 * strings can be one.
 */
const documentationQuery = z.object({ revision: modelRevisionLabelSchema.optional() }).strict();

/**
 * `GET /models/:publisher/:model/documentation[?revision=]`
 *
 * The customer-safe documentation of ONE revision (#972 §12: "store/publicize the
 * customer-safe documentation needed by downstream developers").
 *
 * ## Why this is not part of `GET /models/:publisher/:model`
 *
 * A catalogue entry documents whichever revision is CURRENT. The catalogue also
 * invites a customer to pin `<publisher>/<model>@<revision>` — that is what
 * `available_revisions` is for, and what the revision immutability trigger
 * exists to make meaningful — and until this endpoint the model card,
 * evaluations, safety metadata and artifact digest of the revision a customer was
 * ACTUALLY calling were unreadable. A model card that only ever describes the
 * newest weights is the exact conflation ADR 0008 separates revisions to prevent.
 *
 * Omitting `?revision=` answers for the CURRENT revision, not the newest: that is
 * what a bare model id resolves to, so anything else would document weights the
 * customer's own request would not reach.
 *
 * Audience-scoped like every other read here, and by the same predicate — the
 * service asks `getCatalogueEntryForViewer` first, so a model this viewer may not
 * see is a 404 identical to one that does not exist. A retired revision DOES
 * answer: its documentation is what a developer needs in order to migrate off it,
 * and `retiredAt` says plainly that it is retired.
 *
 * Registered BEFORE `/:publisher/:model` for readability only — a two-segment
 * route cannot match a three-segment path either way.
 */
router.get(
  '/:publisher/:model/documentation',
  catalogueReadLimiter,
  validate({ query: documentationQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = documentationQuery.parse(req.query);
    const access = await catalogueAccess(req);
    const modelId = `${req.params.publisher}/${req.params.model}`;
    const documentation = access.served
      ? await getRevisionDocumentation(access.viewer, modelId, query.revision)
      : undefined;

    if (documentation === undefined) {
      logger.debug(`Documentation for ${modelId} is not available to this viewer`);
      throw new NotFoundError(
        query.revision === undefined
          ? `No documentation for ${modelId} is available to you`
          : `No documentation for ${modelId}@${query.revision} is available to you`
      );
    }

    res.json({ data: documentation });
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
