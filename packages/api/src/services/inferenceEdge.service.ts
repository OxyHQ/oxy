/**
 * The public inference edge — admission, attribution, authorization,
 * reservation, forwarding and settlement (issue #972 workstream 4, ADR 0010).
 *
 * ONE path to the data plane, shared by both public dialects. ADR 0010 rejected
 * "let each public endpoint build its own upstream request" because two code
 * paths mean two places a routing constraint or a reservation can be forgotten,
 * and only one of them would be well covered. `routes/inferenceEdge.ts` reads
 * the dialect and renders the answer; every decision between those two points
 * happens here.
 *
 * ## The order is load-bearing, and it is ADR 0010's
 *
 * ```text
 * 1. allocate requestId            before authentication — a rejected request is traceable
 * 2. authenticate the credential   machine key or verified service token
 * 3. resolve attribution           credential -> application -> owner account   (ADR 0007)
 * 4. authorize scopes              credential scopes ∩ application scopes
 * 5. resolve the routing policy, pin its version, then resolve the route UNDER it
 * 6. reserve spend                 (ADR 0009) — reject HERE, before the data plane
 * 7. forward the internal envelope
 * 8. settle and refund against the returned usage
 * ```
 *
 * Nothing is forwarded before step 6 completes, and every path out of step 7 —
 * including "there is no data plane" — settles the hold. A refusal that left a
 * reservation standing would take a customer's money out of circulation until
 * the sweeper expired it, for a request that never ran.
 *
 * ## There is no data plane, so every invoke refuses
 *
 * `services/relayClient.ts` declares the boundary and has no production
 * implementation. The edge therefore answers a typed `service_unavailable` with
 * a `requestId`, having reserved and released the hold. It never falls back to
 * the Alia proxy and never fabricates a completion. See
 * `__tests__/inferenceEdge.test.ts` — the refusal is asserted together with the
 * balance being whole afterwards, because a refusal that silently keeps the
 * money is the failure that looks like it worked.
 *
 * ## Prompts never enter this module's logs
 *
 * Every log line here names ids, codes and counts. The request body, the
 * messages, the tool arguments and the model's output are not passed to
 * `logger` on any path, and the test asserts it against a marker planted in a
 * prompt with a positive control proving the logger was called at all.
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import {
  inferenceRequestSchema,
  INFERENCE_SCOPES,
  normalizedUsageReportSchema,
  type ClientRequestMetadata,
  type InferenceEnvironment,
  type InferenceError,
  type InferenceErrorCode,
  type InferenceInput,
  type InferenceMessage,
  type InferenceRequest,
  type InferenceScope,
  type NormalizedUsageReport,
  type RoutingPolicyReference,
  type UsageUnit,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { USAGE_UNIT_COLUMN_KEYS } from '../db/schema/ledgerColumns';
import { usageReceipts, usageReceiptUnitPrices } from '../db/schema/usageReceipts';
import { usageReservations } from '../db/schema/usageReservations';
import { extractTokenFromRequest } from '../middleware/authUtils';
import {
  resolveMachineCredential,
  type MachineCredentialPrincipal,
} from '../middleware/machineCredential';
import { verifyServiceToken } from '../middleware/serviceToken';
import { resolveCredentialAttributionById } from './attribution.service';
import {
  resolveCatalogueViewer,
  resolveEdgeRoute,
  routingConstraintsOf,
  UNCONSTRAINED_ROUTING,
  type CatalogueViewer,
  type EdgeRoute,
} from './inferenceCatalogue.service';
import {
  quoteUnits,
  reserve,
  settle,
  type LedgerAttribution,
  type ReservationView,
} from './inferenceLedger.service';
import { resolveEffectiveRoutingPolicy } from './inferenceRoutingPolicy.service';
import { recordInferenceUsage } from './inferenceTelemetry.service';
import {
  DataPlaneNotConfiguredError,
  type RelayClient,
  type RelayCompletion,
} from './relayClient';
import { intersectScopes, type ApplicationScope } from '../utils/applicationScopes';
import { buildInferenceError, inferenceErrorStatus } from '../utils/inferenceEdgeErrors';
import { logger } from '../utils/logger';
import {
  generationReceiptSchema,
  type GenerationReceipt,
  type NormalizedEdgeRequest,
} from '../schemas/inferenceEdge.schemas';

/* -------------------------------------------------------------------------- */
/*  Limits                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The largest request body the edge accepts, in bytes.
 *
 * Deliberately BELOW the global `express.json({ limit: '1mb' })` ceiling, and
 * that ordering is the whole point: the parser runs before routing, so a limit
 * equal to its own would never fire and the customer would get the parser's
 * untyped 413 with no `requestId` on it. At 768 KiB the edge's own typed
 * `request_too_large` is what a customer actually receives, and the parser stays
 * the backstop for a body that declares no `Content-Length`.
 *
 * 768 KiB of JSON is far more text than fits the context window of any model
 * this edge serves — a request that large is refused by
 * `context_length_exceeded` long before its size matters — so the ceiling
 * rejects nothing a customer could have been served.
 */
export const MAX_REQUEST_BYTES = 786_432;

/**
 * Per-message allowance for the tokens a chat template adds around content —
 * role markers, turn delimiters, the tool-call framing.
 *
 * Part of the input CEILING (see {@link estimateInputTokens}), so it only ever
 * makes a hold larger. Eight is generous for every template in common use.
 */
const MESSAGE_TOKEN_OVERHEAD = 8;

/**
 * How long a hold stands before the expiry sweeper releases it.
 *
 * Long enough that a slow generation settles against its own hold rather than
 * against an expired one; short enough that a settlement lost to a crash returns
 * the customer's money within the quarter hour.
 */
export const RESERVATION_TTL_SECONDS = 900;

/** The longest customer-supplied `Idempotency-Key` the edge will key on. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * The reference recorded when an application has configured NO routing policy.
 *
 * `resolveEffectiveRoutingPolicy` returning `none` is a real answer, not a gap:
 * an application with no policy is served under the platform default. The
 * envelope still requires a reference, because a charge must be explainable
 * against the exact configuration that produced it — so the default is NAMED and
 * VERSIONED rather than omitted, and a receipt written today stays attributable
 * to something true after the customer configures a real policy tomorrow.
 *
 * `policyVersion` moves when the platform default's MEANING changes, not when
 * this file is edited. A receipt referencing it carries no
 * `routing_policy_version_id`, because there is no version row to point at —
 * which is exactly how a reader tells the two cases apart.
 */
export const PLATFORM_DEFAULT_ROUTING_POLICY: RoutingPolicyReference = {
  routingPolicyId: 'platform-default',
  policyVersion: 1,
};

/* -------------------------------------------------------------------------- */
/*  Authentication                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A caller the edge has authenticated, in the ONE shape both lanes produce.
 *
 * `scopes` is already `credential ∩ application` on both lanes — never the
 * credential's own list, and never the token's claim taken on trust. A service
 * token lives an hour; a credential can be revoked and an application can lose a
 * scope inside that hour, and both must lock the caller out on the next request.
 */
export interface EdgePrincipal {
  readonly lane: 'machine_credential' | 'service_token';
  readonly applicationId: string;
  readonly credentialId: string;
  /** `applications.owner_account_id` — the billing principal (ADR 0007). */
  readonly ownerAccountId: string;
  readonly environment: InferenceEnvironment;
  readonly scopes: readonly ApplicationScope[];
  /** What the catalogue audience is derived from. Never customer-facing. */
  readonly applicationType: string | null;
  readonly applicationIsInternal: boolean | null;
}

export type EdgeAuthentication =
  | {
      readonly ok: true;
      readonly principal: EdgePrincipal;
      /**
       * Present only on the machine lane. Handed back so the router can put it
       * on `req.machineCredential`, which is what the per-credential and
       * per-application limiters of `middleware/machineCredential.ts` key on —
       * those limiters are mounted, not reimplemented.
       */
      readonly machinePrincipal?: MachineCredentialPrincipal;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Authenticate an inference-edge caller.
 *
 * Two lanes, tried in the order that costs least: the machine lane matches on a
 * fixed token shape and refuses anything else without a query, so a service
 * token falls through to `verifyServiceToken` immediately.
 *
 * **A bare `oxy_dk_…` authenticates on neither.** It is an OAuth client id, and
 * the machine lane matches only `token_prefix` — a column no public identifier
 * is ever written to — while the service lane requires a signed JWT. That is not
 * a check that could be forgotten; it is a column it is not in.
 *
 * Every refusal is the same answer to the caller. `reason` is for the log.
 */
export async function authenticateEdgeCaller(req: Request): Promise<EdgeAuthentication> {
  const token = extractTokenFromRequest(req);
  if (!token) {
    return { ok: false, reason: 'no_bearer' };
  }

  const machine = await resolveMachineCredential(token);
  if (machine.ok) {
    const application = await loadCatalogueApplication(machine.principal.applicationId);
    return {
      ok: true,
      machinePrincipal: machine.principal,
      principal: {
        lane: 'machine_credential',
        applicationId: machine.principal.applicationId,
        credentialId: machine.principal.credentialId,
        ownerAccountId: machine.principal.ownerAccountId,
        environment: machine.principal.environment,
        scopes: machine.principal.scopes,
        applicationType: application?.type ?? null,
        applicationIsInternal: application?.isInternal ?? null,
      },
    };
  }

  if (machine.reason !== 'not_machine_token') {
    return { ok: false, reason: `machine_${machine.reason}` };
  }

  const verification = verifyServiceToken(token);
  if (!verification.ok) {
    return { ok: false, reason: `service_${verification.reason}` };
  }

  // The credential ROW, not the token's claims, is the authority for the
  // application and owner hop (ADR 0007) — and re-reading it is what makes a
  // revocation effective inside the token's own hour of life.
  const attribution = await resolveCredentialAttributionById(verification.payload.credentialId);
  if (attribution.status !== 'resolved') {
    return { ok: false, reason: `credential_${attribution.status}` };
  }
  if (attribution.attribution.application.applicationStatus !== 'active') {
    return { ok: false, reason: 'application_inactive' };
  }

  const application = await loadCatalogueApplication(
    attribution.attribution.application.applicationId
  );

  return {
    ok: true,
    principal: {
      lane: 'service_token',
      applicationId: attribution.attribution.application.applicationId,
      credentialId: attribution.attribution.credentialId,
      ownerAccountId: attribution.attribution.application.ownerAccountId,
      environment: attribution.attribution.credentialEnvironment,
      scopes: intersectScopes(
        attribution.attribution.credentialScopes,
        attribution.attribution.applicationScopes
      ),
      applicationType: application?.type ?? null,
      applicationIsInternal: application?.isInternal ?? null,
    },
  };
}

/** The two application columns the catalogue audience is derived from. */
async function loadCatalogueApplication(
  applicationId: string
): Promise<{ type: string | null; isInternal: boolean | null } | undefined> {
  const [row] = await getDb()
    .select({ type: applications.type, isInternal: applications.isInternal })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  return row;
}

/** The catalogue audience this principal may be served from. */
export function viewerForPrincipal(principal: EdgePrincipal): CatalogueViewer {
  return resolveCatalogueViewer({
    type: principal.applicationType,
    isInternal: principal.applicationIsInternal,
  });
}

/* -------------------------------------------------------------------------- */
/*  Execution                                                                 */
/* -------------------------------------------------------------------------- */

export interface EdgeExecutionContext {
  /** Allocated before authentication, so a rejected request is traceable. */
  readonly requestId: string;
  readonly principal: EdgePrincipal;
  readonly request: NormalizedEdgeRequest;
  /** `X-Oxy-User-Id`, or the OpenAI `user` field. Attribution only. */
  readonly delegatedUserId?: string;
  /** The customer's `Idempotency-Key`, when they sent one. */
  readonly idempotencyKey?: string;
  readonly apiFormat: ClientRequestMetadata['apiFormat'];
  readonly endpoint: string;
  /** Aborted when the client disconnects. */
  readonly signal: AbortSignal;
  /** Absent in every deployment today — see `services/relayClient.ts`. */
  readonly relayClient?: RelayClient;
}

export interface EdgeCompletion {
  readonly requestId: string;
  readonly generationId?: string;
  readonly resolvedModelReference: string;
  readonly servingProvider: string;
  readonly finishReason: RelayCompletion['finishReason'];
  readonly output: readonly InferenceMessage[];
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly routingPolicy: RoutingPolicyReference;
}

export type EdgeExecution =
  | { readonly status: 'completed'; readonly completion: EdgeCompletion }
  | { readonly status: 'refused'; readonly error: InferenceError };

/**
 * Admit, reserve, forward and settle one non-streaming inference request.
 *
 * Returns a refusal rather than throwing for every outcome a caller can be told
 * about, so the two route handlers have exactly one branch each and cannot
 * disagree about which failures are 4xx.
 */
export async function executeInferenceRequest(
  context: EdgeExecutionContext
): Promise<EdgeExecution> {
  const { requestId, principal, request } = context;

  const refuse = (
    code: InferenceErrorCode,
    message: string,
    options: { param?: string; reason?: string } = {}
  ): EdgeExecution => {
    logger.warn('inference.edge.refused', {
      requestId,
      code,
      applicationId: principal.applicationId,
      credentialId: principal.credentialId,
      lane: principal.lane,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    return {
      status: 'refused',
      error: buildInferenceError({
        code,
        message,
        requestId,
        ...(options.param === undefined ? {} : { param: options.param }),
      }),
    };
  };

  // 4. Authorize. `inference:invoke` spends the OWNING ACCOUNT's balance, which
  //    is why it is checked before anything is resolved or reserved.
  if (!principal.scopes.includes('inference:invoke')) {
    return refuse(
      'insufficient_scope',
      'This credential does not hold the inference:invoke scope.'
    );
  }

  if (request.stream) {
    return refuse(
      'invalid_request',
      'Streaming responses are not served by this edge yet. Send stream: false.',
      { param: 'stream' }
    );
  }

  // Only the text modality is served. Refusing here rather than forwarding is
  // what keeps the input CEILING sound: an image or audio part has no
  // character-count bound, so a hold sized from one would be a guess.
  const nonText = firstNonTextPart(request.input);
  if (nonText !== undefined) {
    return refuse(
      'unsupported_modality',
      `Input parts of type ${nonText} are not served by this edge yet.`,
      { param: 'input' }
    );
  }

  // 5a. Resolve the policy this request is admitted under, and PIN its version.
  //     The application's own policy wins, then the owner account's; `none`
  //     means the platform default, which is a real answer rather than a gap.
  const policy = await resolveEffectiveRoutingPolicy(principal.applicationId);
  const routingPolicy: RoutingPolicyReference =
    policy.status === 'resolved'
      ? {
          routingPolicyId: policy.stored.policy.routingPolicyId,
          policyVersion: policy.stored.policy.policyVersion,
        }
      : PLATFORM_DEFAULT_ROUTING_POLICY;
  const routingPolicyVersionId =
    policy.status === 'resolved' ? policy.stored.versionId : undefined;

  // The same version's data-handling, provider, residency, licence and hosting
  // controls, in the shape the route resolver filters candidates on. Passed
  // explicitly on BOTH arms: an application with no policy is served under the
  // platform default, which imposes no constraints, and saying so by name is
  // what stops "unconstrained" from being the answer nobody chose (issue #1011).
  const routingConstraints =
    policy.status === 'resolved'
      ? routingConstraintsOf(policy.stored.policy)
      : UNCONSTRAINED_ROUTING;

  // The caller's target, or the policy's own default when they named none —
  // "per-application default model or routing profile", read from the version
  // that was just pinned rather than from whatever is current at settlement.
  const target =
    request.target ??
    (policy.status === 'resolved' ? policy.stored.policy.defaultTarget : undefined);

  if (target === undefined) {
    return refuse(
      'invalid_request',
      'Name a model, or configure a default target on this application’s routing policy.',
      { param: 'model' }
    );
  }

  if (target.kind !== 'model') {
    // A routing profile names a SET of candidates and choosing among them is
    // routing EXECUTION, which is the data plane's (ADR 0006) — and there is no
    // data plane. Refusing is the honest answer; picking a candidate here would
    // be the control plane inventing a routing decision, and doing it with no
    // way to test the choice.
    return refuse(
      'no_route_available',
      'Routing profiles are not yet served by this edge. Name a concrete model.',
      { param: 'routingProfile' }
    );
  }

  const requestedModelReference = target.modelReference;

  // 5. Resolve the route, under this request's own policy.
  const resolution = await resolveEdgeRoute(
    viewerForPrincipal(principal),
    requestedModelReference,
    routingConstraints
  );
  if (resolution.status === 'unknown-model') {
    // A model that does not exist and one this credential may not see are
    // deliberately the same answer — the catalogue is not an oracle for what Oxy
    // runs internally.
    await recordEdgeTelemetry(context, {
      requestedModelReference,
      statusCode: inferenceErrorStatus('model_not_found'),
      units: {},
    });
    return refuse(
      'model_not_found',
      `No model ${requestedModelReference} is available to you.`,
      { param: 'model' }
    );
  }
  if (resolution.status === 'policy-excluded') {
    // The request is refused, not downgraded. Nothing has been reserved and
    // nothing is forwarded: a request that cannot be served under its own policy
    // must fail rather than fall back to a route that policy forbade, which is
    // the whole of issue #1011. `policy_violation` rather than
    // `no_route_available` because the constraint is the customer's own and the
    // fix is theirs — and it is non-retryable, so an SDK does not spend a retry
    // budget on a configuration decision.
    await recordEdgeTelemetry(context, {
      requestedModelReference,
      statusCode: inferenceErrorStatus('policy_violation'),
      units: {},
    });
    return refuse(
      'policy_violation',
      `Every route for ${requestedModelReference} is excluded by this application’s routing policy: ${resolution.constraints.join(', ')}.`,
      { reason: `policy_excluded:${resolution.constraints.join(',')}` }
    );
  }
  if (resolution.status === 'unpriced-route') {
    await recordEdgeTelemetry(context, {
      requestedModelReference,
      statusCode: inferenceErrorStatus('no_route_available'),
      units: {},
    });
    return refuse(
      'no_route_available',
      `No priced route is available for ${requestedModelReference}.`,
      { reason: 'unpriced_route' }
    );
  }
  const route = resolution.route;

  // 6a. Explicit context and output ceilings, enforced at the edge rather than
  //     inherited from whatever the upstream provider happens to enforce.
  const requestedOutput = request.maxOutputTokens;
  if (requestedOutput !== undefined && requestedOutput > route.maxOutputTokens) {
    return refuse(
      'output_limit_exceeded',
      `${requestedModelReference} generates at most ${route.maxOutputTokens} output tokens.`,
      { param: 'max_output_tokens' }
    );
  }
  const maxOutputTokens = requestedOutput ?? route.maxOutputTokens;
  const estimatedInputTokens = estimateInputTokens(request);
  if (estimatedInputTokens + maxOutputTokens > route.maxContextTokens) {
    return refuse(
      'context_length_exceeded',
      `The request and its maximum output exceed the ${route.maxContextTokens}-token context of ${requestedModelReference}.`,
      { param: 'input' }
    );
  }

  // 6b. Size the hold at the CEILING: everything the request could consume, at
  //     the price of the route it was admitted against.
  //
  //     Two units, not four, and that rests on an assumption worth stating now
  //     that the contract's units are declared a PARTITION: a cache hit is
  //     charged as `cached_input_tokens` out of the SAME prompt budget this
  //     estimate bounds, and a reasoning token as `reasoning_tokens` out of the
  //     same `maxOutputTokens` budget. So this ceiling covers the whole
  //     partition exactly while each child unit is priced no higher than its
  //     parent, which is how every provider prices them. A price version that
  //     charged MORE for a cached or reasoning token than for its parent would
  //     produce a settlement above its own hold — refused, loudly, as
  //     `settlement-exceeds-reservation`, after the request has already run.
  const ceilingUnits: Partial<Record<UsageUnit, number>> = {
    input_tokens: estimatedInputTokens,
    output_tokens: maxOutputTokens,
  };
  const quote = await quoteUnits(route.priceVersionId, ceilingUnits);
  if (quote.status !== 'quoted') {
    logger.error(
      'inference.edge.unquotable_route',
      new Error(`route ${route.modelReference} could not be priced: ${quote.status}`),
      { requestId, modelReference: route.modelReference, priceVersionId: route.priceVersionId }
    );
    return refuse(
      'no_route_available',
      `No priced route is available for ${requestedModelReference}.`,
      { reason: quote.status }
    );
  }

  const ledgerKey = ledgerIdempotencyKey(context);

  // Idempotency is a CHARGE guarantee, not response replay: prompts and
  // responses are not persisted by default, so there is no stored response to
  // return for a repeated key. A key already bound to a reservation — held or
  // settled — is therefore refused rather than re-executed, which is what makes
  // "a retried request must not produce a second charge" structural.
  if (context.idempotencyKey !== undefined && (await reservationExists(ledgerKey))) {
    return refuse(
      'idempotency_conflict',
      'This Idempotency-Key has already been used. Responses are not retained, so it cannot be replayed.',
      { param: 'Idempotency-Key' }
    );
  }

  const ledgerAttribution: LedgerAttribution = {
    accountId: principal.ownerAccountId,
    applicationId: principal.applicationId,
    applicationCredentialId: principal.credentialId,
    ...(context.delegatedUserId === undefined
      ? {}
      : { delegatedUserId: context.delegatedUserId }),
    requestId,
    environment: principal.environment,
  };

  // 6c. Reserve. NOTHING is forwarded before this returns `reserved`.
  const reservation = await reserve({
    idempotencyKey: ledgerKey,
    attribution: ledgerAttribution,
    knownUnits: { input_tokens: estimatedInputTokens },
    maxOutputTokens,
    ceilingPriceVersionId: route.priceVersionId,
    maxAmount: quote.amount,
    currency: quote.currency,
    expiresInSeconds: RESERVATION_TTL_SECONDS,
  });

  const held = reservationOrRefusal(reservation, requestId, quote.currency);
  if ('error' in held) {
    await recordEdgeTelemetry(context, {
      requestedModelReference,
      statusCode: inferenceErrorStatus(held.error.code),
      units: {},
      resolvedModelReference: route.modelReference,
      servingProvider: route.provider,
    });
    logger.warn('inference.edge.reservation_refused', {
      requestId,
      code: held.error.code,
      accountId: principal.ownerAccountId,
      applicationId: principal.applicationId,
      reservationStatus: reservation.status,
    });
    return { status: 'refused', error: held.error };
  }

  // 7. Build and forward the versioned internal envelope.
  const envelope = buildEnvelope(context, route, maxOutputTokens, routingPolicy);

  let completion: RelayCompletion;
  try {
    if (context.relayClient === undefined) {
      throw new DataPlaneNotConfiguredError();
    }
    completion = await context.relayClient.execute(envelope, { signal: context.signal });
  } catch (error) {
    const failure = classifyForwardFailure(error, context.signal);
    await settleFailure(
      context,
      route,
      held.reservation,
      ledgerKey,
      failure.outcome,
      routingPolicyVersionId
    );
    await recordEdgeTelemetry(context, {
      requestedModelReference,
      statusCode: inferenceErrorStatus(failure.code),
      units: {},
      resolvedModelReference: route.modelReference,
      servingProvider: route.provider,
      outcome: failure.outcome,
    });
    return refuse(failure.code, failure.message, { reason: failure.reason });
  }

  // The data plane answering about a different request, or serving a model the
  // edge did not admit, are both refusals rather than warnings: no routing
  // policy authorizes any substitution today, so a differing model reference is
  // a substitution nobody permitted.
  const mismatch = validateCompletion(completion, requestId, route);
  if (mismatch !== undefined) {
    await settleFailure(
      context,
      route,
      held.reservation,
      ledgerKey,
      'failed',
      routingPolicyVersionId
    );
    await recordEdgeTelemetry(context, {
      requestedModelReference,
      statusCode: inferenceErrorStatus(mismatch.code),
      units: {},
      resolvedModelReference: route.modelReference,
      servingProvider: route.provider,
      outcome: 'failed',
    });
    return refuse(mismatch.code, mismatch.message, { reason: mismatch.reason });
  }

  // 8. Settle against the exact usage, releasing the rest of the hold in the
  //    same transaction.
  const units = unitsFromReport(completion.usage);
  const settlement = await settle({
    idempotencyKey: ledgerKey,
    reservationId: held.reservation.reservationId,
    attribution: ledgerAttribution,
    ...(completion.generationId === undefined
      ? {}
      : { generationId: completion.generationId }),
    outcome: completion.usage.outcome,
    usageSource: completion.usage.usageSource,
    units,
    resolvedModelReference: route.modelReference,
    servingProvider: route.provider,
    priceVersionId: route.priceVersionId,
    ...(routingPolicyVersionId === undefined ? {} : { routingPolicyVersionId }),
  });

  if (settlement.status !== 'settled' && settlement.status !== 'already-settled') {
    // The generation happened and could not be charged for. That is an Oxy
    // failure, and it is loud: the hold stands until the sweeper releases it, so
    // the customer's money comes back on its own while the discrepancy is
    // visible.
    logger.error(
      'inference.edge.settlement_failed',
      new Error(`settlement returned ${settlement.status}`),
      {
        requestId,
        reservationId: held.reservation.reservationId,
        accountId: principal.ownerAccountId,
        settlementStatus: settlement.status,
      }
    );
    return refuse('internal_error', 'The request completed but could not be settled.', {
      reason: settlement.status,
    });
  }

  await recordEdgeTelemetry(context, {
    requestedModelReference,
    statusCode: 200,
    units,
    resolvedModelReference: route.modelReference,
    servingProvider: route.provider,
    outcome: completion.usage.outcome,
    usageSource: completion.usage.usageSource,
    ...(completion.generationId === undefined
      ? {}
      : { generationId: completion.generationId }),
  });

  return {
    status: 'completed',
    completion: {
      requestId,
      ...(completion.generationId === undefined
        ? {}
        : { generationId: completion.generationId }),
      resolvedModelReference: route.modelReference,
      servingProvider: route.provider,
      finishReason: completion.finishReason,
      output: completion.output,
      units,
      routingPolicy,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The key every ledger call for this request is idempotent on.
 *
 * Namespaced by the CREDENTIAL when the customer supplied one, so two customers
 * choosing the same key cannot collide with each other; namespaced by the
 * request id otherwise, so an internal retry of one HTTP request never
 * double-charges even without a customer key.
 */
function ledgerIdempotencyKey(context: EdgeExecutionContext): string {
  return context.idempotencyKey === undefined
    ? `oxy-edge:req:${context.requestId}`
    : `oxy-edge:idem:${context.principal.credentialId}:${context.idempotencyKey}`;
}

/** Whether a reservation — held, settled or expired — already carries this key. */
async function reservationExists(idempotencyKey: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: usageReservations.id })
    .from(usageReservations)
    .where(eq(usageReservations.idempotencyKey, idempotencyKey))
    .limit(1);
  return row !== undefined;
}

/**
 * Map a reservation outcome onto either the hold or the customer's refusal.
 *
 * `no-billing-profile` and `insufficient-funds` become the SAME customer-facing
 * code, and the distinction the ledger fought to keep survives where it matters
 * — in the log line and in the message. The customer's next action is identical
 * for both (fund the account that owns this application), and giving them two
 * codes would be two branches in their client for one decision.
 */
function reservationOrRefusal(
  result: Awaited<ReturnType<typeof reserve>>,
  requestId: string,
  currency: string
): { reservation: ReservationView } | { error: InferenceError } {
  switch (result.status) {
    case 'reserved':
    case 'already-reserved':
      return { reservation: result.reservation };
    case 'no-billing-profile':
      return {
        error: buildInferenceError({
          code: 'insufficient_balance',
          message:
            'The account that owns this application has no inference billing profile. Add one in the Oxy Console.',
          requestId,
        }),
      };
    case 'insufficient-funds':
      return {
        error: buildInferenceError({
          code: 'insufficient_balance',
          message: `This request needs ${result.required} ${result.currency} and ${result.available} ${result.currency} is available.`,
          requestId,
        }),
      };
    case 'spending-limit-exceeded':
      return {
        error: buildInferenceError({
          code: 'spending_limit_exceeded',
          message: 'A spending limit on this account stops this request.',
          requestId,
        }),
      };
    case 'currency-mismatch':
      return {
        error: buildInferenceError({
          code: 'internal_error',
          message: `This route is priced in ${currency} and the account is billed in ${result.expected}.`,
          requestId,
        }),
      };
  }
}

/**
 * Release a hold for a request that produced nothing.
 *
 * A zero-unit settlement rather than a bare release, because ADR 0009 has one
 * terminal write for a hold and `usage_receipts` legitimately carries a
 * zero-unit, zero-amount receipt for an upstream failure. The customer then has
 * a `GET /v1/generations/:id` record saying the request failed and cost nothing,
 * which a silent release would not give them.
 *
 * A failure to settle is logged and swallowed: the caller is already returning
 * an error, and the sweeper releases the hold at its deadline regardless.
 */
async function settleFailure(
  context: EdgeExecutionContext,
  route: EdgeRoute,
  reservation: ReservationView,
  ledgerKey: string,
  outcome: 'failed' | 'cancelled',
  routingPolicyVersionId: string | undefined
): Promise<void> {
  try {
    const result = await settle({
      idempotencyKey: ledgerKey,
      reservationId: reservation.reservationId,
      attribution: {
        accountId: context.principal.ownerAccountId,
        applicationId: context.principal.applicationId,
        applicationCredentialId: context.principal.credentialId,
        ...(context.delegatedUserId === undefined
          ? {}
          : { delegatedUserId: context.delegatedUserId }),
        requestId: context.requestId,
        environment: context.principal.environment,
      },
      outcome,
      usageSource: 'oxy_measured',
      units: {},
      resolvedModelReference: route.modelReference,
      servingProvider: route.provider,
      priceVersionId: route.priceVersionId,
      ...(routingPolicyVersionId === undefined
        ? {}
        : { routingPolicyVersionId }),
    });
    if (result.status !== 'settled' && result.status !== 'already-settled') {
      logger.error(
        'inference.edge.release_failed',
        new Error(`zero settlement returned ${result.status}`),
        { requestId: context.requestId, reservationId: reservation.reservationId }
      );
    }
  } catch (error) {
    logger.error(
      'inference.edge.release_threw',
      error instanceof Error ? error : new Error(String(error)),
      { requestId: context.requestId, reservationId: reservation.reservationId }
    );
  }
}

interface ForwardFailure {
  readonly code: InferenceErrorCode;
  readonly message: string;
  readonly reason: string;
  readonly outcome: 'failed' | 'cancelled';
}

/**
 * What a failed forward means to the customer.
 *
 * The no-data-plane case is `service_unavailable` and NOT retryable: an
 * unconfigured deployment is fixed by an operator, and telling every SDK to
 * retry would turn one misconfiguration into a retry storm.
 */
function classifyForwardFailure(error: unknown, signal: AbortSignal): ForwardFailure {
  if (error instanceof DataPlaneNotConfiguredError) {
    return {
      code: 'service_unavailable',
      message: 'No inference data plane is configured for this deployment.',
      reason: 'no_data_plane',
      outcome: 'failed',
    };
  }
  if (signal.aborted) {
    return {
      code: 'cancelled',
      message: 'The client closed the connection before the request completed.',
      reason: 'client_disconnected',
      outcome: 'cancelled',
    };
  }
  return {
    code: 'provider_error',
    message: 'The inference data plane could not serve this request.',
    reason: 'relay_error',
    outcome: 'failed',
  };
}

/**
 * Refuse a completion that does not answer the request that was admitted.
 *
 * The usage report is PARSED, not trusted. It is the input to a charge, it
 * crosses a service boundary from an independently deployed producer, and the
 * contract's whole versioning rule is that a producer running ahead of a
 * consumer must fail at the parse rather than be silently reinterpreted. A
 * malformed report reaching `settle` would be a number nobody validated turning
 * into money.
 */
function validateCompletion(
  completion: RelayCompletion,
  requestId: string,
  route: EdgeRoute
): { code: InferenceErrorCode; message: string; reason: string } | undefined {
  const report = normalizedUsageReportSchema.safeParse(completion.usage);
  if (!report.success) {
    return {
      code: 'internal_error',
      message: 'The inference data plane returned a usage report Oxy could not read.',
      reason: `usage_report_invalid:${report.error.issues[0]?.path.join('.') ?? 'unknown'}`,
    };
  }

  if (completion.usage.requestId !== requestId) {
    return {
      code: 'internal_error',
      message: 'The inference data plane answered a different request.',
      reason: 'request_id_mismatch',
    };
  }
  if (completion.usage.resolvedModelReference !== route.modelReference) {
    return {
      code: 'policy_violation',
      message: 'The request was served by a model no routing policy authorized.',
      reason: 'model_substituted',
    };
  }
  return undefined;
}

/** The contract's unit array as the `{ unit: quantity }` map the ledger takes. */
function unitsFromReport(report: NormalizedUsageReport): Partial<Record<UsageUnit, number>> {
  const units: Partial<Record<UsageUnit, number>> = {};
  for (const quantity of report.units) {
    units[quantity.unit] = quantity.quantity;
  }
  return units;
}

/** Build and VALIDATE the versioned envelope the data plane receives. */
function buildEnvelope(
  context: EdgeExecutionContext,
  route: EdgeRoute,
  maxOutputTokens: number,
  routingPolicy: RoutingPolicyReference
): InferenceRequest {
  const { principal, request } = context;

  return inferenceRequestSchema.parse({
    schemaVersion: 1,
    attribution: {
      principal: {
        billing: { accountId: principal.ownerAccountId },
        applicationId: principal.applicationId,
        credentialId: principal.credentialId,
        environment: principal.environment,
        inferenceScopes: principal.scopes.filter(isInferenceScope),
      },
      ...(context.delegatedUserId === undefined
        ? {}
        : { userId: context.delegatedUserId }),
      requestId: context.requestId,
    },
    // The route is always revision-PINNED, even when the customer named only
    // the model line: the data plane must serve the exact weights the edge
    // priced and reserved against.
    target: { kind: 'model', modelReference: route.modelReference },
    modality: 'text',
    input: request.input,
    stream: false,
    maxOutputTokens,
    sampling: request.sampling,
    tools: request.tools,
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(request.responseFormat === undefined
      ? {}
      : { responseFormat: request.responseFormat }),
    client: {
      apiFormat: context.apiFormat,
      endpoint: context.endpoint,
      ...(request.clientRequestId === undefined
        ? {}
        : { clientRequestId: request.clientRequestId }),
      receivedAt: new Date().toISOString(),
      ...(request.labels === undefined ? {} : { labels: request.labels }),
    },
    ...(context.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: context.idempotencyKey }),
    routingPolicy,
  });
}

const INFERENCE_SCOPE_SET: ReadonlySet<string> = new Set<string>(INFERENCE_SCOPES);

function isInferenceScope(scope: ApplicationScope): scope is ApplicationScope & InferenceScope {
  return INFERENCE_SCOPE_SET.has(scope);
}

/**
 * A strict UPPER BOUND on the input tokens a request can encode.
 *
 * Not an approximation and not a tokenizer: every token a BPE tokenizer emits
 * consumes at least one character of its input, so the character count is a
 * ceiling on the token count for any text. {@link MESSAGE_TOKEN_OVERHEAD} covers
 * the template tokens a chat format adds around each turn, and tool definitions
 * are counted because they are serialized into the prompt.
 *
 * Over-estimating is the SAFE direction and costs the customer nothing: a hold
 * is released in full at settlement, and the alternative — a hold sized from a
 * typical response — is how a balance goes negative on a long generation. It is
 * a ceiling precisely because non-text parts, whose token cost has no character
 * bound, are refused before this runs.
 */
export function estimateInputTokens(request: NormalizedEdgeRequest): number {
  let characters = 0;
  let messages = 0;

  if (request.input.format === 'messages') {
    messages = request.input.messages.length;
    for (const message of request.input.messages) {
      for (const part of message.content) {
        if (part.type === 'text') characters += part.text.length;
      }
      if (message.name !== undefined) characters += message.name.length;
      for (const call of message.toolCalls ?? []) {
        characters += call.name.length + call.arguments.length;
      }
    }
  } else if (request.input.format === 'text') {
    messages = 1;
    characters += request.input.text.length;
  } else {
    messages = request.input.texts.length;
    for (const text of request.input.texts) characters += text.length;
  }

  for (const tool of request.tools) {
    characters += JSON.stringify(tool).length;
  }

  return characters + messages * MESSAGE_TOKEN_OVERHEAD;
}

/** The first non-text content part in an input, if there is one. */
function firstNonTextPart(input: InferenceInput): string | undefined {
  if (input.format !== 'messages') return undefined;
  for (const message of input.messages) {
    for (const part of message.content) {
      if (part.type !== 'text') return part.type;
    }
  }
  return undefined;
}

interface EdgeTelemetryInput {
  readonly requestedModelReference: string;
  readonly statusCode: number;
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly resolvedModelReference?: string;
  readonly servingProvider?: string;
  readonly generationId?: string;
  readonly outcome?: NormalizedUsageReport['outcome'];
  readonly usageSource?: NormalizedUsageReport['usageSource'];
}

/**
 * Record the request in the usage stream (workstream 8).
 *
 * Best effort, and deliberately so: telemetry is eventually consistent by
 * contract, and a dashboard write must never fail a request that has already
 * been charged. The exact billed amount comes from `usage_receipts`, never from
 * here.
 */
async function recordEdgeTelemetry(
  context: EdgeExecutionContext,
  input: EdgeTelemetryInput
): Promise<void> {
  try {
    await recordInferenceUsage({
      accountId: context.principal.ownerAccountId,
      applicationId: context.principal.applicationId,
      applicationCredentialId: context.principal.credentialId,
      ...(context.delegatedUserId === undefined
        ? {}
        : { delegatedUserId: context.delegatedUserId }),
      requestId: context.requestId,
      ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
      environment: context.principal.environment,
      endpoint: context.endpoint,
      statusCode: input.statusCode,
      outcome: input.outcome ?? 'failed',
      requestedModelReference: input.requestedModelReference,
      ...(input.resolvedModelReference === undefined
        ? {}
        : { resolvedModelReference: input.resolvedModelReference }),
      ...(input.servingProvider === undefined
        ? {}
        : { servingProvider: input.servingProvider }),
      usageSource: input.usageSource ?? 'oxy_measured',
      units: input.units,
    });
  } catch (error) {
    logger.error(
      'inference.edge.telemetry_failed',
      error instanceof Error ? error : new Error(String(error)),
      { requestId: context.requestId }
    );
  }
}

/** Allocate the id every response, error and ledger record correlates on. */
export function allocateRequestId(): string {
  return randomUUID();
}

/* -------------------------------------------------------------------------- */
/*  GET /v1/generations/:id                                                   */
/* -------------------------------------------------------------------------- */

export type GenerationReceiptLookup =
  | { readonly status: 'found'; readonly receipt: GenerationReceipt }
  | { readonly status: 'not-found' };

/**
 * Read back the settled receipt for one request.
 *
 * `:id` is the `requestId` the caller already holds — it is on every response
 * and every error of this edge, in `X-Oxy-Request-Id` — or the `generationId`
 * the endpoint is named for. Both are matched, in that order; each has its own
 * index on `usage_receipts`.
 *
 * **Entitlement is the application, and a caller who is not entitled gets 404.**
 * A receipt belongs to the application that spent the money, so a credential of
 * a different application is told the receipt does not exist rather than that it
 * exists and is somebody else's — the same reasoning the catalogue applies to
 * internal-only routes. Reading another account's spend history through an
 * application you can reach is exactly what the epic's negative test forbids.
 */
export async function readGenerationReceipt(
  principal: EdgePrincipal,
  id: string
): Promise<GenerationReceiptLookup> {
  if (!principal.scopes.includes('inference:usage:read')) {
    return { status: 'not-found' };
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(usageReceipts)
    .where(
      and(
        eq(usageReceipts.applicationId, principal.applicationId),
        or(eq(usageReceipts.requestId, id), eq(usageReceipts.generationId, id))
      )
    )
    .orderBy(desc(usageReceipts.settledAt))
    .limit(1);

  if (!row) {
    return { status: 'not-found' };
  }

  const snapshotRows = await db
    .select({
      unit: usageReceiptUnitPrices.unit,
      amount: usageReceiptUnitPrices.amount,
      per: usageReceiptUnitPrices.per,
    })
    .from(usageReceiptUnitPrices)
    .where(eq(usageReceiptUnitPrices.receiptId, row.id))
    .orderBy(asc(usageReceiptUnitPrices.unit));

  return {
    status: 'found',
    receipt: generationReceiptSchema.parse({
      schemaVersion: 1,
      receiptId: row.id,
      requestId: row.requestId,
      ...(row.generationId === null ? {} : { generationId: row.generationId }),
      applicationId: row.applicationId,
      credentialId: row.applicationCredentialId,
      ...(row.delegatedUserId === null ? {} : { delegatedUserId: row.delegatedUserId }),
      environment: row.environment,
      outcome: row.outcome,
      usageSource: row.usageSource,
      // EVERY unit column, including the zeros. The row records eleven
      // quantities and reporting only the non-zero ones would make "the provider
      // reported zero output tokens" indistinguishable from "output tokens were
      // never metered" — a distinction `usage_source` is what actually carries.
      units: Object.entries(USAGE_UNIT_COLUMN_KEYS).map(([unit, key]) => ({
        unit,
        quantity: row[key],
      })),
      resolvedModelReference: row.resolvedModelReference,
      servingProvider: row.servingProvider,
      priceSnapshot: {
        priceVersionId: row.priceVersionId,
        currency: row.currency,
        unitPrices: snapshotRows.map((price) => ({
          unit: price.unit,
          amount: price.amount,
          per: price.per,
          currency: row.currency,
        })),
      },
      billedAmount: row.billedAmount,
      currency: row.currency,
      platformFeeOnly: row.platformFeeOnly,
      settledAt: row.settledAt.toISOString(),
    }),
  };
}
