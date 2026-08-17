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
 * Steps 1 to 6 are {@link admitRequest}, and both entry points below call it.
 * That is the ONE admission path ADR 0010 asks for: a streaming request and a
 * non-streaming one are authorized, routed, limited and reserved by the same
 * code, so a constraint cannot be enforced on one and forgotten on the other.
 *
 * ## Two entry points, because a stream is not a value
 *
 *  - {@link executeInferenceRequest} returns one completion.
 *  - {@link streamInferenceRequest} is an async generator of
 *    {@link EdgeStreamFrame}, so the route writes and flushes each frame as it
 *    arrives and NOTHING is buffered. Its `finally` settles the hold whatever
 *    ends the iteration — a terminal event, a transport failure, or a route that
 *    stopped consuming because its own client went away. Abandoning a
 *    `for await` runs that cleanup, which is what makes "the customer left"
 *    propagate all the way to the provider without any caller remembering to say
 *    so.
 *
 * ## A deployment with no data plane refuses, exactly as it did before
 *
 * `services/httpRelayClient.ts` is the production implementation, but a
 * deployment that has not configured one (`config/relayDataPlane.ts`) is
 * constructed with no client: the edge answers a typed `service_unavailable` with
 * a `requestId`, having reserved and released the hold, and `stream: true` is
 * refused with a typed `invalid_request`. It never falls back to the Alia proxy
 * and never fabricates a completion. See `__tests__/inferenceEdge.test.ts` — the
 * refusal is asserted together with the balance being whole afterwards, because a
 * refusal that silently keeps the money is the failure that looks like it worked.
 *
 * ## Settlement is one function, and it never depends on a completion
 *
 * {@link settleMeasured} takes the units, the source and the outcome, and every
 * path reaches it: a clean completion, a stream that ended in an error, a client
 * disconnect, and a request that produced output nobody could measure. The last
 * of those settles ZERO units with `usageSource: 'estimated'`, which the ledger
 * records as the refund reason `usage_unavailable` — the conservative answer, and
 * a deliberately reconcilable one. What Oxy SHOULD charge when a provider reports
 * no usage is an open policy question that belongs with the estimation and
 * reconciliation work, not here.
 *
 * ## Two providers, and they are allowed to differ
 *
 * `route.provider` is the provider this request was ADMITTED against: the one
 * whose price version sized the hold and whose constraints the routing policy was
 * checked over. `usage.servingProvider` is the provider the data plane REPORTS as
 * having actually served it. A same-model deployment failover makes them
 * different, and the epic declares that failover LEGITIMATE — so a mismatch is
 * not an error to refuse, it is a fact to record.
 *
 * Every record that describes what was SERVED therefore names the REPORTED
 * provider: the receipt, the usage event (and so the daily rollup, whose primary
 * key includes it), the customer's response body and its `X-Oxy-Provider` header.
 * Every record that describes a request nothing served names the ADMITTED one,
 * because there is no reported value to name — a reservation refused before the
 * forward, and a completion repudiated as unreadable or model-substituted, are
 * both in that class. The pattern mirrors `requestedModelReference` beside
 * `resolvedModelReference`, which the schema already carries for the same reason.
 *
 * {@link settlementFrom} resolves the two into ONE value per request, so the
 * receipt and the telemetry event can never name different providers for the same
 * charge. A streaming response is the one place the admitted provider reaches a
 * customer: `X-Oxy-Provider` is a header, headers go out before the first frame,
 * and a switch that happens afterwards is delivered as a `route_switch` event
 * instead — see {@link streamInferenceRequest}.
 *
 * ## A reported route switch is RECORDED, never validated
 *
 * See {@link recordEdgeRouteSwitch}.
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
  type InferenceStreamEvent,
  type InferenceStreamRouteSwitchEvent,
  type NormalizedUsageReport,
  type RoutingPolicyReference,
  type UsageSource,
  type UsageUnit,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { isChargingAuthorized, isMachineCredentialLaneEnabled } from '../config/rolloutFlags';
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
  TEXT_COMPLETION_MODALITY,
  UNCONSTRAINED_ROUTING,
  type CatalogueViewer,
  type EdgeModalityRequirement,
  type EdgeRoute,
} from './inferenceCatalogue.service';
import {
  quoteUnits,
  reserve,
  settle,
  type LedgerAttribution,
  type ReservationView,
} from './inferenceLedger.service';
import {
  recordRouteSwitch,
  resolveEffectiveRoutingPolicy,
  type RouteSwitchDetail,
} from './inferenceRoutingPolicy.service';
import { recordInferenceUsage } from './inferenceTelemetry.service';
import {
  DataPlaneNotConfiguredError,
  RelayEnvelopeRejectedError,
  RelayIncompleteError,
  RelayProtocolError,
  type RelayClient,
  type RelayCompletion,
  type RelayUsageEvidence,
} from './relayClient';
import { intersectScopes, type ApplicationScope } from '../utils/applicationScopes';
import { buildInferenceError, inferenceErrorStatus } from '../utils/inferenceEdgeErrors';
import { logger } from '../utils/logger';
import {
  generationReceiptSchema,
  type EdgeOperation,
  type GenerationReceipt,
  type NormalizedEdgeRequest,
} from '../schemas/inferenceEdge.schemas';
import { machineCredentialTokenPrefix } from '../utils/machineCredentialToken';

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
 * **The machine lane is closed unless this deployment opens it**
 * (`INFERENCE_MACHINE_CREDENTIAL_AUTH`, `config/rolloutFlags.ts`). The check sits
 * before the lookup rather than after it, so a machine token costs no query while
 * the lane is shut — and it is a lane refusal rather than a fall-through to the
 * service lane, so the log says which lane was closed instead of reporting a
 * malformed JWT.
 *
 * Every refusal is the same answer to the caller. `reason` is for the log.
 */
export async function authenticateEdgeCaller(req: Request): Promise<EdgeAuthentication> {
  const token = extractTokenFromRequest(req);
  if (!token) {
    return { ok: false, reason: 'no_bearer' };
  }

  if (machineCredentialTokenPrefix(token) !== null && !isMachineCredentialLaneEnabled()) {
    return { ok: false, reason: 'machine_lane_disabled' };
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
  /**
   * When the edge received this request, on the MONOTONIC clock
   * (`performance.now()`), taken beside the request id in `edgeGate`.
   *
   * It is the origin of `inference_usage_events.latency_ms` — see
   * {@link recordEdgeTelemetry}. Monotonic rather than `Date.now()` because a
   * wall-clock step (NTP) between the two readings would produce a negative
   * latency, which the column's own CHECK refuses; the row would then be lost
   * on a path that swallows its errors, so the failure would be a silently
   * missing metric rather than a visible one.
   */
  readonly receivedAt: number;
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
  /**
   * The data plane. Absent when this deployment configured none — see
   * `config/relayDataPlane.ts` — in which case every invoke refuses.
   */
  readonly relayClient?: RelayClient;
}

export interface EdgeCompletion {
  readonly requestId: string;
  readonly generationId?: string;
  readonly resolvedModelReference: string;
  /**
   * The provider that actually served this request, as the data plane REPORTED
   * it — which after a same-model failover is not the provider the edge admitted.
   * The receipt and the daily rollup name the same value, so a customer reading
   * `X-Oxy-Provider` and a customer reading their usage dashboard see one answer.
   */
  readonly servingProvider: string;
  readonly finishReason: RelayCompletion['finishReason'];
  readonly output: readonly InferenceMessage[];
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly routingPolicy: RoutingPolicyReference;
}

export type EdgeExecution =
  | { readonly status: 'completed'; readonly completion: EdgeCompletion }
  | { readonly status: 'refused'; readonly error: InferenceError };

/** The customer-visible frames one streamed request produces. */
export type EdgeStreamFrame =
  /**
   * The first thing a streaming route learns, yielded when the data plane's own
   * first frame arrives rather than at admission. That timing is what lets a
   * refusal Relay makes at the ENVELOPE layer still be an HTTP status: nothing is
   * committed to the response until something real is about to be written to it.
   */
  | { readonly kind: 'open'; readonly head: EdgeStreamHead }
  | { readonly kind: 'event'; readonly event: InferenceStreamEvent }
  /** Terminal. Before an `open` it is an HTTP error; after one, a stream event. */
  | { readonly kind: 'error'; readonly error: InferenceError };

/** What a route needs before it writes the first byte of a stream. */
export interface EdgeStreamHead {
  readonly requestId: string;
  readonly resolvedModelReference: string;
  /**
   * The ADMITTED provider — the one exception to the rule that a
   * customer-visible provider is the reported one.
   *
   * This head becomes response HEADERS, and headers are sent before the first
   * frame. The reported provider is not knowable then: the usage report is
   * terminal, and a failover can happen at any point after. So a stream states
   * the route it opened on and reports a later change as a `route_switch` event,
   * which is the transport the contract provides for exactly this. The RECEIPT
   * for the same request still names the reported provider.
   */
  readonly servingProvider: string;
  readonly routingPolicy: RoutingPolicyReference;
}

/* -------------------------------------------------------------------------- */
/*  Steps 4-6: admission, shared by both entry points                         */
/* -------------------------------------------------------------------------- */

/** Everything admission resolved, and the hold it took. */
interface AdmittedRequest {
  readonly route: EdgeRoute;
  readonly requestedModelReference: string;
  readonly maxOutputTokens: number;
  readonly routingPolicy: RoutingPolicyReference;
  readonly routingPolicyVersionId: string | undefined;
  readonly ledgerKey: string;
  readonly ledgerAttribution: LedgerAttribution;
  /** Absent while shadow metering: nothing is held because nothing is charged. */
  readonly hold: ReservationView | undefined;
}

type Admission =
  | { readonly status: 'admitted'; readonly admitted: AdmittedRequest }
  | { readonly status: 'refused'; readonly error: InferenceError };

/** Log a refusal and build the customer's error. One origin for both. */
function refuseRequest(
  context: EdgeExecutionContext,
  code: InferenceErrorCode,
  message: string,
  options: { param?: string; reason?: string } = {}
): InferenceError {
  const { principal } = context;
  logger.warn('inference.edge.refused', {
    requestId: context.requestId,
    code,
    applicationId: principal.applicationId,
    credentialId: principal.credentialId,
    lane: principal.lane,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
  return buildInferenceError({
    code,
    message,
    requestId: context.requestId,
    ...(options.param === undefined ? {} : { param: options.param }),
  });
}

/**
 * Authorize, limit, route and reserve — ADR 0010's steps 4 to 6, for both a
 * streaming request and a non-streaming one.
 *
 * Nothing is forwarded before this returns `admitted`, and when it returns
 * `refused` nothing has been reserved on any arm except the one that says so.
 *
 * ## Charging is a flag, and until it is armed the edge SHADOW METERS
 *
 * `INFERENCE_CHARGING_AUTHORIZED` (`config/rolloutFlags.ts`) is unset by default,
 * and while it is, the reservation here and the settlement later are replaced by
 * one priced log line: the request is admitted, routed, forwarded and metered
 * exactly as it would be, the exact amount it WOULD have been billed is computed
 * from the same price version with the same `quoteUnits` arithmetic `settle` bills
 * with, and no reservation, receipt, refund, ledger entry or balance movement is
 * written. So a shadow period leaves nothing to reconcile away when charging is
 * armed, which is the property that makes it worth running at all.
 *
 * What is NOT enforced while shadow metering, stated rather than discovered: an
 * account with no billing profile is served, an empty balance is served, and a
 * spending limit stops nothing — all three of those refusals live in `reserve`,
 * which is the call being skipped. `GET /v1/generations/:id` has no receipt to
 * return for such a request either, and a repeated `Idempotency-Key` binds to no
 * reservation and so is not refused.
 *
 * The flag is read ONCE per request, here and nowhere else. Read twice, a flip
 * between the reservation and the settlement would either settle against a hold
 * that was never taken or take a hold nothing ever settles — which is why
 * `hold === undefined` is the single thing every later step branches on.
 */
async function admitRequest(context: EdgeExecutionContext): Promise<Admission> {
  const { requestId, principal, request } = context;
  const charging = isChargingAuthorized();

  const refuse = (
    code: InferenceErrorCode,
    message: string,
    options: { param?: string; reason?: string } = {}
  ): Admission => ({
    status: 'refused',
    error: refuseRequest(context, code, message, options),
  });

  // 4. Authorize. `inference:invoke` spends the OWNING ACCOUNT's balance, which
  //    is why it is checked before anything is resolved or reserved.
  if (!principal.scopes.includes('inference:invoke')) {
    return refuse(
      'insufficient_scope',
      'This credential does not hold the inference:invoke scope.'
    );
  }

  // A deployment with no data plane cannot stream, and says so with the same
  // typed refusal it always has. Checked here, before anything is reserved, and
  // after the scope check so an unauthorized caller is still told about their
  // scope rather than about a capability they could not have used either way.
  if (request.stream && context.relayClient === undefined) {
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
    // routing EXECUTION, which is the data plane's (ADR 0006) — and the envelope
    // carries a routing policy REFERENCE rather than the candidate list, so no
    // data plane can resolve one either. Refusing is the honest answer; picking a
    // candidate here would be the control plane inventing a routing decision, and
    // doing it with no way to test the choice.
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
    routingConstraints,
    modalityForOperation(request.operation)
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
  if (resolution.status === 'modality-unsupported') {
    // `unsupported_modality` and not `model_not_found`: the model exists and this
    // credential can see it, it just cannot do what this endpoint asks. Telling a
    // caller the model does not exist would send them to change a correct id.
    await recordEdgeTelemetry(context, {
      requestedModelReference,
      statusCode: inferenceErrorStatus('unsupported_modality'),
      units: {},
    });
    const wanted =
      resolution.required.output === undefined
        ? `${resolution.required.input} input`
        : `${resolution.required.input} input and ${resolution.required.output} output`;
    return refuse(
      'unsupported_modality',
      `${requestedModelReference} does not serve ${wanted}. It accepts ${resolution.supportedInput.join(', ')} and produces ${resolution.supportedOutput.join(', ')}.`,
      { param: 'model' }
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
  // Zero for every operation that does not generate a token stream. The context
  // check below then bounds the INPUT alone for those, which is the right
  // question: an embeddings request still has to fit the model's context.
  const maxOutputTokens = outputTokenBudget(
    request.operation,
    requestedOutput ?? route.maxOutputTokens
  );
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
  const ceilingUnits: Partial<Record<UsageUnit, number>> = ceilingForOperation(
    request.operation,
    estimatedInputTokens,
    maxOutputTokens
  );
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

  // 6c. Reserve. NOTHING is forwarded before this returns `reserved` — unless
  //     this deployment is shadow metering, in which case nothing is held
  //     because nothing will be charged. `hold` being `undefined` is what every
  //     later step branches on, so the two modes cannot half-happen.
  let hold: ReservationView | undefined;
  if (charging) {
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
        // ADMITTED, and it can only be: this refusal happens BEFORE the forward,
        // so no provider has served anything and there is no reported value in
        // existence. The row says which route the request would have taken.
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
    hold = held.reservation;
  }

  return {
    status: 'admitted',
    admitted: {
      route,
      requestedModelReference,
      maxOutputTokens,
      routingPolicy,
      routingPolicyVersionId,
      ledgerKey,
      ledgerAttribution,
      hold,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Steps 7-8, non-streaming                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Admit, reserve, forward and settle one NON-streaming inference request.
 *
 * Returns a refusal rather than throwing for every outcome a caller can be told
 * about, so the two route handlers have exactly one branch each and cannot
 * disagree about which failures are 4xx.
 *
 * A `stream: true` request never reaches here — the router dispatches it to
 * {@link streamInferenceRequest} — and if one somehow did, {@link admitRequest}
 * would refuse rather than quietly answer it non-streamed.
 */
export async function executeInferenceRequest(
  context: EdgeExecutionContext
): Promise<EdgeExecution> {
  const { requestId, principal } = context;

  const admission = await admitRequest(context);
  if (admission.status === 'refused') {
    return { status: 'refused', error: admission.error };
  }
  const { admitted } = admission;
  const { route, hold } = admitted;

  // 7. Build and forward the versioned internal envelope.
  const envelope = buildEnvelope(context, admitted, false);

  let completion: RelayCompletion;
  try {
    if (context.relayClient === undefined) {
      throw new DataPlaneNotConfiguredError();
    }
    completion = await context.relayClient.execute(envelope, { signal: context.signal });
  } catch (error) {
    const failure = classifyForwardFailure(error, context.signal);
    // Whatever the data plane DID measure before it stopped — `RelayIncompleteError`
    // carries it — is what this settles against. A full refund on a request that
    // produced two hundred tokens would be Oxy absorbing a cost it can account
    // for, which is the mirror of the over-charge the reservation prevents.
    //
    // Built ONCE and shared with the telemetry row below, so the receipt and the
    // event name the same provider: a failure whose evidence was a full report
    // names the REPORTED provider on both, and one with no report names the
    // admitted route on both. Two `settlementFrom` calls would be two chances to
    // disagree about a request that already failed.
    const settlement = settlementFrom(
      usageEvidenceOf(error),
      failure.outcome,
      route.provider
    );
    await settleMeasured(context, admitted, settlement);
    await recordEdgeTelemetry(context, {
      requestedModelReference: admitted.requestedModelReference,
      statusCode: inferenceErrorStatus(failure.code),
      units: {},
      resolvedModelReference: route.modelReference,
      servingProvider: settlement.servingProvider,
      outcome: failure.outcome,
    });
    return {
      status: 'refused',
      error: refuseRequest(context, failure.code, failure.message, { reason: failure.reason }),
    };
  }

  // The data plane answering about a different request, or serving a model the
  // edge did not admit, are both refusals rather than warnings: no routing
  // policy authorizes any substitution today, so a differing model reference is
  // a substitution nobody permitted.
  const mismatch = validateCompletion(completion, requestId, route);
  if (mismatch !== undefined) {
    await settleMeasured(
      context,
      admitted,
      settlementFrom(undefined, 'failed', route.provider)
    );
    await recordEdgeTelemetry(context, {
      requestedModelReference: admitted.requestedModelReference,
      statusCode: inferenceErrorStatus(mismatch.code),
      units: {},
      resolvedModelReference: route.modelReference,
      // ADMITTED, deliberately, even though the rejected report carries a
      // `servingProvider`. The whole answer was just repudiated — it either did
      // not parse, or it named a model nobody authorized — so reading a field out
      // of it would attribute a refused request to a provider on the authority of
      // a document the edge declined to believe. The admitted route is the last
      // thing about this request Oxy itself established.
      servingProvider: route.provider,
      outcome: 'failed',
    });
    return {
      status: 'refused',
      error: refuseRequest(context, mismatch.code, mismatch.message, {
        reason: mismatch.reason,
      }),
    };
  }

  // 8. Settle against the exact usage, releasing the rest of the hold in the
  //    same transaction — or, while shadow metering, price the same usage and
  //    record what it would have cost without writing a financial record.
  //
  //    NOT `settleMeasured`: on this one path a settlement that fails is
  //    reportable, because the customer's response has not been sent yet. Every
  //    other path has either already answered with an error or already streamed
  //    the whole response, and refusing after the fact would turn a ledger
  //    discrepancy into a second failure the customer sees.
  const units = unitsFromReport(completion.usage);

  // The provider that actually served the request, as the data plane reports it —
  // not `route.provider`, which is the provider the edge ADMITTED. A same-model
  // deployment failover makes the two differ, and the epic authorizes that
  // failover, so this is the value the receipt, the telemetry event, the daily
  // rollup's primary key and the customer's own response body carry.
  //
  // Safe to read without a further check because {@link validateCompletion} has
  // already parsed `completion.usage` against `normalizedUsageReportSchema` above,
  // where `servingProvider` is a required provider slug.
  const servingProvider = completion.usage.servingProvider;

  if (hold === undefined) {
    await recordShadowMetering(context, route, units, {
      outcome: completion.usage.outcome,
      usageSource: completion.usage.usageSource,
      servingProvider,
      ...(completion.generationId === undefined
        ? {}
        : { generationId: completion.generationId }),
      routingPolicyVersionId: admitted.routingPolicyVersionId,
    });
  } else {
    const settlement = await settle({
      idempotencyKey: admitted.ledgerKey,
      reservationId: hold.reservationId,
      attribution: admitted.ledgerAttribution,
      ...(completion.generationId === undefined
        ? {}
        : { generationId: completion.generationId }),
      outcome: completion.usage.outcome,
      usageSource: completion.usage.usageSource,
      units,
      resolvedModelReference: route.modelReference,
      servingProvider,
      priceVersionId: route.priceVersionId,
      ...(admitted.routingPolicyVersionId === undefined
        ? {}
        : { routingPolicyVersionId: admitted.routingPolicyVersionId }),
    });

    if (settlement.status !== 'settled' && settlement.status !== 'already-settled') {
      // The generation happened and could not be charged for. That is an Oxy
      // failure, and it is loud: the hold stands until the sweeper releases it,
      // so the customer's money comes back on its own while the discrepancy is
      // visible.
      logger.error(
        'inference.edge.settlement_failed',
        new Error(`settlement returned ${settlement.status}`),
        {
          requestId,
          reservationId: hold.reservationId,
          accountId: principal.ownerAccountId,
          settlementStatus: settlement.status,
        }
      );
      return {
        status: 'refused',
        error: refuseRequest(
          context,
          'internal_error',
          'The request completed but could not be settled.',
          { reason: settlement.status }
        ),
      };
    }
  }

  // The switches the data plane reported, as the persisted customer-visible
  // notice. Written after the settlement so the row a customer joins to their
  // receipt exists by the time the receipt does; a failure to write one never
  // fails a request that has already been served — see
  // {@link recordEdgeRouteSwitch}.
  //
  // `?? []` because `RelayCompletion` is deserialized JSON, and a required
  // property on a wire-derived shape is a CLAIM about what the far side sends
  // rather than an enforcement of it: a producer that omits this leaves
  // `undefined` at runtime and `for…of` throws with `tsc` having signed off. The
  // set of producers is not closed by the type system, so the guard belongs here
  // and not in the annotation.
  //
  // It matters at THIS line in particular because it runs after the hold is
  // settled and the handler has no try/catch: measured, the throw became an
  // unhandled rejection with NO response written — not a 500, a request that
  // never answers, with the money already taken.
  for (const event of completion.routeSwitchEvents ?? []) {
    await recordEdgeRouteSwitch(context, admitted, event);
  }

  await recordEdgeTelemetry(context, {
    requestedModelReference: admitted.requestedModelReference,
    statusCode: 200,
    units,
    resolvedModelReference: route.modelReference,
    servingProvider,
    outcome: completion.usage.outcome,
    usageSource: completion.usage.usageSource,
    // The two figures only the data plane can know. `routeSwitches` is the
    // fallback metric workstream 16 names; `timeToFirstTokenMs` is optional on
    // the report and stays NULL when it is absent rather than being imputed.
    routeSwitches: completion.usage.routeSwitches,
    ...(completion.usage.timeToFirstTokenMs === undefined
      ? {}
      : { timeToFirstTokenMs: completion.usage.timeToFirstTokenMs }),
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
      servingProvider,
      finishReason: completion.finishReason,
      output: completion.output,
      units,
      routingPolicy: admitted.routingPolicy,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Steps 7-8, streaming                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admit, reserve, forward and settle one STREAMING inference request, yielding
 * each frame as the data plane produces it.
 *
 * ## Nothing is buffered, and that is structural rather than careful
 *
 * The route's `for await` is the only consumer, and it writes and flushes inside
 * the loop. There is no array of events anywhere in this function: an event is
 * read from the data plane, yielded, and forgotten. The two things that ARE kept
 * are the last usage measurement and the terminal error, both of which are single
 * values and both of which the settlement needs.
 *
 * ## The `finally` is the whole cancellation and settlement story
 *
 * It runs on every exit — the stream ending, a transport failure, and a consumer
 * that stopped consuming — because abandoning a `for await` resumes an async
 * generator with a return completion, which runs its `finally`. So:
 *
 *  - the hold is settled exactly once, whatever happened, and
 *  - `RelayClient.stream`'s own `finally` aborts the upstream hop, which is what
 *    propagates a client disconnect to Relay and from there to the provider.
 *
 * A cancelled request is a SETTLEMENT case (ADR 0009), never a discarded one: the
 * units measured before the cut are charged and the rest of the hold is released,
 * so a customer who cancels pays for what they received.
 *
 * ## Where the usage comes from, in order of authority
 *
 *  1. the terminal `usage_report` frame — the full normalized report;
 *  2. the last in-stream `usage` event, when the report never arrived, which is
 *     the ordinary case for a client disconnect: Relay still produces a report
 *     but can no longer deliver the frame to a connection that is gone;
 *  3. nothing, when neither arrived — settled as ZERO units marked `estimated`,
 *     which the ledger records as the refund reason `usage_unavailable`.
 *
 * (3) is the conservative answer to an open policy question — what Oxy should
 * charge for output it cannot measure — and it is deliberately the reconcilable
 * one: a receipt exists, it says the usage was unavailable, and a later
 * estimation policy can correct it with a compensating entry. It is NOT an
 * estimator, and this is not the place for one.
 */
export async function* streamInferenceRequest(
  context: EdgeExecutionContext
): AsyncGenerator<EdgeStreamFrame> {
  const admission = await admitRequest(context);
  if (admission.status === 'refused') {
    yield { kind: 'error', error: admission.error };
    return;
  }
  const { admitted } = admission;
  const { route } = admitted;

  const relayClient = context.relayClient;
  if (relayClient === undefined) {
    // Unreachable: `admitRequest` refuses a streaming request with no data plane
    // before reserving anything. Handled rather than asserted because the
    // alternative is a non-null assertion, and because a future edit to that
    // order would otherwise release nothing.
    await settleMeasured(
      context,
      admitted,
      settlementFrom(undefined, 'failed', route.provider)
    );
    yield {
      kind: 'error',
      error: refuseRequest(
        context,
        'invalid_request',
        'Streaming responses are not served by this edge yet. Send stream: false.',
        { param: 'stream', reason: 'no_data_plane' }
      ),
    };
    return;
  }

  const envelope = buildEnvelope(context, admitted, true);

  let report: NormalizedUsageReport | undefined;
  let partial: RelayUsageEvidence | undefined;
  let terminal: InferenceError | undefined;
  let forwardFailure: ForwardFailure | undefined;
  let opened = false;
  let sawOutput = false;

  try {
    for await (const frame of relayClient.stream(envelope, { signal: context.signal })) {
      if (frame.kind === 'usage') {
        report = frame.usage;
        // Never forwarded as a customer event: it is the technical record
        // settlement runs against, and the contract's stream union has no member
        // for it.
        continue;
      }

      const event = frame.event;
      if (!opened) {
        opened = true;
        yield {
          kind: 'open',
          head: {
            requestId: context.requestId,
            resolvedModelReference: route.modelReference,
            // ADMITTED — the head becomes headers, and the reported provider is
            // not knowable before the first frame. See {@link EdgeStreamHead}.
            servingProvider: route.provider,
            routingPolicy: admitted.routingPolicy,
          },
        };
      }

      if (event.type === 'usage') {
        partial = { kind: 'partial', units: event.units, usageSource: event.usageSource };
      } else if (event.type === 'delta' && event.text.length > 0) {
        sawOutput = true;
      } else if (event.type === 'error') {
        terminal = event.error;
      }

      yield { kind: 'event', event };

      // AFTER the yield, deliberately. A `yield` suspends until the route asks
      // for the next frame, so this insert sits between "the customer has the
      // notice" and "the edge reads the next frame from the data plane" — never
      // in front of a frame somebody is waiting for. Written here rather than
      // accumulated for the `finally` because a notice already shown to a
      // customer must survive a process that dies later in the same stream, and
      // because this function keeps no array of events by design.
      if (event.type === 'route_switch') {
        await recordEdgeRouteSwitch(context, admitted, event);
      }
    }
  } catch (error) {
    forwardFailure = classifyForwardFailure(error, context.signal);
  } finally {
    // A report that answers a different request, or names a model this edge did
    // not admit, is DISCARDED rather than settled: it is the input to a charge and
    // it crosses a service boundary. Unlike the non-streaming path this cannot
    // also refuse the response — the customer already has it — so the request
    // settles as unmeasured and the discrepancy is loud in the log.
    const usable = report === undefined ? undefined : validateUsageReport(report, context.requestId, route);
    if (report !== undefined && usable === undefined) {
      logger.error(
        'inference.edge.stream_usage_report_rejected',
        new Error('the streamed usage report does not answer the request that was admitted'),
        {
          requestId: context.requestId,
          resolvedModelReference: route.modelReference,
          accountId: context.principal.ownerAccountId,
        }
      );
    }

    const evidence: RelayUsageEvidence | undefined =
      usable !== undefined ? { kind: 'report', report: usable } : partial;
    const outcome = streamOutcome(context, { terminal, sawOutput });
    const settlement = settlementFrom(evidence, outcome, route.provider);

    await settleMeasured(context, admitted, settlement);
    await recordEdgeTelemetry(context, {
      requestedModelReference: admitted.requestedModelReference,
      // A stream that produced any frame answered 200 and cannot un-answer it.
      statusCode: opened
        ? 200
        : inferenceErrorStatus(forwardFailure?.code ?? terminal?.code ?? 'internal_error'),
      units: settlement.units,
      resolvedModelReference: route.modelReference,
      // REPORTED when a usable report arrived, admitted otherwise — the same
      // value the receipt carries, resolved once in `settlementFrom`. A stream's
      // `X-Oxy-Provider` header deliberately differs here: see
      // {@link EdgeStreamHead}.
      servingProvider: settlement.servingProvider,
      outcome: settlement.outcome,
      usageSource: settlement.usageSource,
      ...(usable === undefined ? {} : { routeSwitches: usable.routeSwitches }),
      ...(usable?.timeToFirstTokenMs === undefined
        ? {}
        : { timeToFirstTokenMs: usable.timeToFirstTokenMs }),
      ...(settlement.generationId === undefined
        ? {}
        : { generationId: settlement.generationId }),
    });
  }

  // A transport or protocol failure produced no terminal event, so the customer
  // has not been told the stream ended. Relay's OWN terminal error was already
  // forwarded verbatim as an event, which is why there is nothing to add for it.
  if (forwardFailure !== undefined) {
    yield {
      kind: 'error',
      error: refuseRequest(context, forwardFailure.code, forwardFailure.message, {
        reason: forwardFailure.reason,
      }),
    };
  }
}

/**
 * What a stream that did not end in a usage report should be recorded as.
 *
 * `cancelled` is decided from the CLIENT's signal rather than from the absence of
 * a terminal event, because those are different facts: a client that disconnected
 * and an upstream that died both end the stream without one, and only the first is
 * the customer's own doing. `partial` needs output to have been seen — a stream
 * that failed before its first token is `failed`, not a partial delivery.
 */
function streamOutcome(
  context: EdgeExecutionContext,
  observed: { terminal: InferenceError | undefined; sawOutput: boolean }
): 'failed' | 'cancelled' | 'partial' {
  if (context.signal.aborted) return 'cancelled';
  if (observed.terminal?.code === 'cancelled') return 'cancelled';
  return observed.sawOutput ? 'partial' : 'failed';
}

/* -------------------------------------------------------------------------- */
/*  The customer-visible record of a route switch                             */
/* -------------------------------------------------------------------------- */

/**
 * Persist one route switch the data plane REPORTED, as the customer-visible
 * notice `inference_route_switch_events` was built for (issue #972 workstream 6,
 * "Emit a customer-visible event/receipt when an allowed route switch occurs").
 *
 * Reached from BOTH dialects and BOTH transports: a streaming request records
 * each `route_switch` event as it forwards it, and a non-streaming one records
 * the events `RelayCompletion.routeSwitchEvents` carried out of the fold. The
 * writer itself is `inferenceRoutingPolicy.service.ts`'s `recordRouteSwitch`,
 * which already owns the authorisation lookup and the idempotency — this function
 * is the edge's adapter onto it, not a second writer.
 *
 * ## What a recorded row DOES and does NOT claim
 *
 * It claims: the data plane reported this switch, and — for a `model`-scope
 * substitution only — the destination is named in the customer's own
 * authorisation rows, because `recordRouteSwitch` looks that up and refuses to
 * write a row it cannot find one for.
 *
 * It does NOT claim the switch respected the customer's routing policy. The
 * envelope this edge sends carries a policy REFERENCE and nothing more (see
 * {@link buildEnvelope}), so the data plane holds no provider allowlist, no
 * region residency requirement, no zero-retention requirement and no price
 * ceiling to check a replacement against; those were checked once, for the route
 * the request was ADMITTED on. **Do not upgrade this to a compliance assertion.**
 *
 * The contract half of the fix has LANDED — `inferenceRequestSchema` now accepts
 * an optional ordered `authorizedRoutes` list — and this edge does not populate it
 * yet, which is the whole of what keeps the claim narrow. The condition to watch
 * for is therefore concrete rather than pending: once {@link buildEnvelope} sends
 * that list, "a switch happened" starts to imply "to a route Oxy authorized" and
 * this comment is what should be revisited. Until then the row is a NOTICE, and
 * reading it as an approval would be reading a fact about the past as a
 * permission.
 *
 * ## Failing to write one never fails the request
 *
 * By the time this runs the customer has been served and the hold has been
 * settled. Every refusal and every exception is logged and swallowed, for the
 * same reason `recordEdgeTelemetry` is best-effort: turning a bookkeeping gap
 * into a second, customer-visible failure trades one lost row for one lost
 * response.
 *
 * ## The platform default cannot be recorded, and that is a configuration gap
 *
 * `routing_policy_version_id` is `NOT NULL`: a switch that cannot name the
 * configuration which allowed it explains nothing, and for a same-model failover
 * the authorising configuration is a policy version's `sameModelDeployment`. An
 * application served under {@link PLATFORM_DEFAULT_ROUTING_POLICY} has NO version
 * row — deliberately, that is how a reader tells the platform default from a
 * configured policy — so there is nothing to point at and the notice is skipped
 * with a named log line rather than written against an invented authority.
 * Closing that needs a real platform-default policy version somebody decides to
 * seed, not a nullable column here.
 */
async function recordEdgeRouteSwitch(
  context: EdgeExecutionContext,
  admitted: AdmittedRequest,
  event: InferenceStreamRouteSwitchEvent
): Promise<void> {
  if (event.requestId !== context.requestId) {
    // Same reasoning as `validateUsageReport`: a record that crosses a service
    // boundary and names a different request is discarded, not stored under this
    // one's id.
    logger.error(
      'inference.edge.route_switch_request_mismatch',
      new Error('the data plane reported a route switch for a different request'),
      { requestId: context.requestId, sequence: event.sequence }
    );
    return;
  }

  const routingPolicyVersionId = admitted.routingPolicyVersionId;
  if (routingPolicyVersionId === undefined) {
    logger.warn('inference.edge.route_switch_unrecordable', {
      requestId: context.requestId,
      sequence: event.sequence,
      scope: event.detail.scope,
      reason: 'platform_default_policy_has_no_version_row',
    });
    return;
  }

  // `authorizedByPolicy` is deliberately NOT forwarded. On the wire it is a
  // `z.literal(true)` — a producer asserting its own permission — and
  // `recordRouteSwitch` LOOKS the authorisation up instead, so there is no field
  // here for the data plane's claim about itself to travel in.
  const detail: RouteSwitchDetail =
    event.detail.scope === 'deployment'
      ? {
          scope: 'deployment',
          modelReference: event.detail.modelReference,
          toProvider: event.detail.toProvider,
          ...(event.detail.toDeploymentId === undefined
            ? {}
            : { toDeploymentId: event.detail.toDeploymentId }),
        }
      : {
          scope: 'model',
          requestedModelId: event.detail.requestedModelId,
          fromModelReference: event.detail.fromModelReference,
          toModelReference: event.detail.toModelReference,
          toProvider: event.detail.toProvider,
        };

  try {
    const result = await recordRouteSwitch({
      requestId: context.requestId,
      sequence: event.sequence,
      accountId: context.principal.ownerAccountId,
      applicationId: context.principal.applicationId,
      environment: context.principal.environment,
      routingPolicyVersionId,
      reason: event.reason,
      detail,
      occurredAt: new Date(event.occurredAt),
    });

    // `already-recorded` is the idempotent answer, not a failure: the unique
    // `(request_id, sequence)` key makes a retried or redelivered event a no-op,
    // which is the same guarantee the ledger's own idempotency key gives the
    // charge. No second mechanism is introduced for it.
    if (result.status === 'recorded' || result.status === 'already-recorded') return;

    logger.error(
      'inference.edge.route_switch_refused',
      new Error(`the reported route switch could not be recorded: ${result.status}`),
      {
        requestId: context.requestId,
        sequence: event.sequence,
        scope: event.detail.scope,
        routingPolicyVersionId,
        status: result.status,
      }
    );
  } catch (error) {
    logger.error(
      'inference.edge.route_switch_write_failed',
      error instanceof Error ? error : new Error(String(error)),
      { requestId: context.requestId, sequence: event.sequence }
    );
  }
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
 * The log event a shadow-metered request produces. Named as a constant because
 * it is an operational contract — a dashboard, an alert and a reconciliation
 * query all key on it — and a renamed string that still compiles would take all
 * three down silently.
 */
export const SHADOW_METERING_EVENT = 'inference.edge.shadow_metered';

/**
 * Price a completed request exactly as it would be charged, and record the
 * amount without charging it.
 *
 * The charge comes from {@link quoteUnits} against the route's own price
 * version — the SAME function and the same price rows `settle` computes a bill
 * from — so the shadow figure and the eventual bill are two evaluations of one
 * expression rather than two implementations that agree until a price shape
 * changes.
 *
 * Nothing here writes to the database. The units are already recorded by
 * `recordInferenceUsage` (telemetry carries units and never money, by schema),
 * so this line is the money half and the two correlate on `requestId` — which is
 * the same correlation workstream 16's observability item asks for across the
 * edge, the data plane, the ledger and the receipt.
 *
 * A failure to price is `error`, not silence: an unpriceable completed request
 * is exactly the gap a shadow period exists to find before a customer's bill
 * depends on it. It does not fail the request — the customer has their
 * completion, and refusing it after the fact would turn a metering gap into an
 * outage.
 */
async function recordShadowMetering(
  context: EdgeExecutionContext,
  route: EdgeRoute,
  units: Partial<Record<UsageUnit, number>>,
  measured: {
    readonly outcome: NormalizedUsageReport['outcome'];
    readonly usageSource: UsageSource;
    /**
     * The provider the data plane reported, or the admitted route's when it
     * reported none. Passed rather than read off `route`, because a shadow record
     * that named the admitted provider while the eventual bill named the reported
     * one would not be the same figure a charged run produces — which is the ONE
     * property a shadow period exists to establish.
     */
    readonly servingProvider: string;
    readonly generationId?: string;
    readonly routingPolicyVersionId: string | undefined;
  }
): Promise<void> {
  const quote = await quoteUnits(route.priceVersionId, units);

  const attribution = {
    requestId: context.requestId,
    ...(measured.generationId === undefined
      ? {}
      : { generationId: measured.generationId }),
    accountId: context.principal.ownerAccountId,
    applicationId: context.principal.applicationId,
    credentialId: context.principal.credentialId,
    environment: context.principal.environment,
    resolvedModelReference: route.modelReference,
    servingProvider: measured.servingProvider,
    priceVersionId: route.priceVersionId,
    ...(measured.routingPolicyVersionId === undefined
      ? {}
      : { routingPolicyVersionId: measured.routingPolicyVersionId }),
  };

  if (quote.status !== 'quoted') {
    logger.error(
      'inference.edge.shadow_metering_unpriced',
      new Error(`shadow metering could not price the request: ${quote.status}`),
      attribution
    );
    return;
  }

  logger.info(SHADOW_METERING_EVENT, {
    ...attribution,
    outcome: measured.outcome,
    usageSource: measured.usageSource,
    units,
    // Named for what it is. `billedAmount` would read as a charge in every
    // dashboard that picked it up, which is the one thing this number is not.
    wouldHaveBilledAmount: quote.amount,
    currency: quote.currency,
  });
}

/** One settlement, however the units for it were arrived at. */
interface MeasuredSettlement {
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly usageSource: UsageSource;
  readonly outcome: NormalizedUsageReport['outcome'];
  readonly generationId: string | undefined;
  /**
   * The provider this request's receipt, telemetry event and rollup bucket name.
   *
   * Already resolved — reported when the data plane reported one, the admitted
   * route's provider otherwise — so no consumer of this shape has to decide, and
   * two records of one charge cannot disagree. See {@link settlementFrom}.
   */
  readonly servingProvider: string;
}

/**
 * Turn whatever the data plane measured into the one shape a settlement takes.
 *
 * Three arms, and only the first can be exact:
 *
 *  - a full report: its own units, source and outcome, because it is the record
 *    the contract designed for this;
 *  - the units of an in-stream `usage` event: exact units, but the outcome comes
 *    from the edge, which is the only party that knows whether the client
 *    cancelled;
 *  - nothing: ZERO units marked `estimated`. The ledger maps that to the refund
 *    reason `usage_unavailable`, so the receipt says "usage was never measured"
 *    rather than "usage was zero" — a distinction a later reconciliation depends
 *    on, and the reason this is not simply a release.
 *
 * The third arm is the conservative side of a genuinely open question: what a
 * customer should be charged for output nobody measured. Refunding the unknown is
 * chosen because the alternative — estimating — invents the number a bill is
 * computed from, and an estimator belongs with the reconciliation work rather than
 * inside a settlement path.
 *
 * ## Which provider the settlement names
 *
 * The REPORTED one on the first arm, and `admittedProvider` on the other two —
 * and that split is the whole of the reported-versus-admitted decision for every
 * failure and streaming path, made once here rather than at each write site.
 *
 * A report is the only form that names a provider at all. The in-stream `usage`
 * event carries units and a source and nothing else, and "nothing arrived" names
 * nothing by definition — so on both of those arms the admitted provider is not a
 * fallback chosen for convenience, it is the only provider anybody knows about.
 * Substituting a guess there would put a provider in a receipt on no evidence.
 */
function settlementFrom(
  evidence: RelayUsageEvidence | undefined,
  fallbackOutcome: 'failed' | 'cancelled' | 'partial',
  admittedProvider: string
): MeasuredSettlement {
  if (evidence === undefined) {
    return {
      units: {},
      usageSource: 'estimated',
      outcome: fallbackOutcome,
      generationId: undefined,
      servingProvider: admittedProvider,
    };
  }
  if (evidence.kind === 'report') {
    return {
      units: unitsFromReport(evidence.report),
      usageSource: evidence.report.usageSource,
      outcome: evidence.report.outcome,
      generationId: evidence.report.generationId,
      servingProvider: evidence.report.servingProvider,
    };
  }
  return {
    units: unitsFromQuantities(evidence.units),
    usageSource: evidence.usageSource,
    outcome: fallbackOutcome,
    generationId: undefined,
    servingProvider: admittedProvider,
  };
}

/** The usage evidence a data-plane failure carried, when it carried any. */
function usageEvidenceOf(error: unknown): RelayUsageEvidence | undefined {
  return error instanceof RelayIncompleteError ? error.usage : undefined;
}

/**
 * Write the terminal ledger record for a request whose response is already
 * decided — an error the caller is about to return, or a stream the customer has
 * already received.
 *
 * A settlement rather than a bare release, because ADR 0009 has one terminal
 * write for a hold and `usage_receipts` legitimately carries a zero-unit,
 * zero-amount receipt. The customer then has a `GET /v1/generations/:id` record
 * saying what happened and what it cost, which a silent release would not give
 * them.
 *
 * A failure to settle is logged and swallowed. That is not indifference: there is
 * no response left to turn into an error, and the expiry sweeper releases the hold
 * at its deadline regardless — so the customer's money comes back on its own while
 * the discrepancy stays visible in the log.
 *
 * While shadow metering (`hold === undefined`) this prices the same units and
 * records what they WOULD have cost, so a shadow period's records cover the
 * failure paths too rather than only the happy one.
 */
async function settleMeasured(
  context: EdgeExecutionContext,
  admitted: AdmittedRequest,
  settlement: MeasuredSettlement
): Promise<void> {
  const { route, hold } = admitted;

  if (hold === undefined) {
    await recordShadowMetering(context, route, settlement.units, {
      outcome: settlement.outcome,
      usageSource: settlement.usageSource,
      servingProvider: settlement.servingProvider,
      ...(settlement.generationId === undefined
        ? {}
        : { generationId: settlement.generationId }),
      routingPolicyVersionId: admitted.routingPolicyVersionId,
    });
    return;
  }

  try {
    const result = await settle({
      idempotencyKey: admitted.ledgerKey,
      reservationId: hold.reservationId,
      attribution: admitted.ledgerAttribution,
      ...(settlement.generationId === undefined
        ? {}
        : { generationId: settlement.generationId }),
      outcome: settlement.outcome,
      usageSource: settlement.usageSource,
      units: settlement.units,
      resolvedModelReference: route.modelReference,
      servingProvider: settlement.servingProvider,
      priceVersionId: route.priceVersionId,
      ...(admitted.routingPolicyVersionId === undefined
        ? {}
        : { routingPolicyVersionId: admitted.routingPolicyVersionId }),
    });
    if (result.status !== 'settled' && result.status !== 'already-settled') {
      logger.error(
        'inference.edge.release_failed',
        new Error(`settlement returned ${result.status}`),
        {
          requestId: context.requestId,
          reservationId: hold.reservationId,
          outcome: settlement.outcome,
          usageSource: settlement.usageSource,
        }
      );
    }
  } catch (error) {
    logger.error(
      'inference.edge.release_threw',
      error instanceof Error ? error : new Error(String(error)),
      { requestId: context.requestId, reservationId: hold.reservationId }
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
 * ## The data plane's own code is used; its retryability is not
 *
 * A terminal `error` event carries a code from the contract's closed set, and
 * that code is what the customer gets — passed through `buildInferenceError`,
 * which re-derives `retryable` from the edge's own total map. So there is ONE
 * authority for "should a client retry this" rather than two that can disagree,
 * and a data plane cannot teach every SDK to retry something the edge knows is
 * hopeless. The message is passed through too, and the contract's own
 * `safeErrorTextSchema` refuses it if it ever carries credential-shaped material.
 *
 * ## A 4xx from the data plane is never the customer's fault
 *
 * `RelayEnvelopeRejectedError` means Oxy's signature, envelope version or body
 * was refused. Surfacing Relay's code would tell a customer their API key is bad
 * when it is Oxy's signing key that is, so it becomes `internal_error` and the
 * real status goes to the log.
 *
 * ## The no-data-plane case is `service_unavailable` and NOT retryable
 *
 * An unconfigured deployment is fixed by an operator, and telling every SDK to
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
  if (error instanceof RelayIncompleteError) {
    if (error.reason === 'terminal_error' && error.failure !== undefined) {
      return {
        code: error.failure.code,
        message: error.failure.message,
        reason: `relay_error:${error.failure.code}`,
        outcome: error.failure.code === 'cancelled' ? 'cancelled' : 'failed',
      };
    }
    if (error.reason === 'usage_missing') {
      return {
        code: 'internal_error',
        message: 'The request ran and Oxy could not read the usage it produced.',
        reason: 'relay_usage_missing',
        outcome: 'failed',
      };
    }
    return {
      code: 'provider_error',
      message: 'The inference data plane stopped responding before the request completed.',
      reason: 'relay_stream_truncated',
      outcome: 'failed',
    };
  }
  if (error instanceof RelayEnvelopeRejectedError) {
    return {
      code: 'internal_error',
      message: 'The request could not be forwarded to the inference data plane.',
      reason: `relay_rejected_envelope:${error.status}`,
      outcome: 'failed',
    };
  }
  if (error instanceof RelayProtocolError) {
    return {
      code: 'internal_error',
      message: 'The inference data plane answered in a form Oxy could not read.',
      reason: 'relay_protocol',
      outcome: 'failed',
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

/**
 * The report, when it answers the request that was admitted; `undefined` when it
 * does not.
 *
 * The same two checks {@link validateCompletion} makes, in the form the streaming
 * path needs: there the response is already delivered, so a bad report can only
 * be discarded rather than turned into a refusal.
 */
function validateUsageReport(
  report: NormalizedUsageReport,
  requestId: string,
  route: EdgeRoute
): NormalizedUsageReport | undefined {
  if (report.requestId !== requestId) return undefined;
  if (report.resolvedModelReference !== route.modelReference) return undefined;
  return report;
}

/** The contract's unit array as the `{ unit: quantity }` map the ledger takes. */
function unitsFromReport(report: NormalizedUsageReport): Partial<Record<UsageUnit, number>> {
  return unitsFromQuantities(report.units);
}

function unitsFromQuantities(
  quantities: readonly { unit: UsageUnit; quantity: number }[]
): Partial<Record<UsageUnit, number>> {
  const units: Partial<Record<UsageUnit, number>> = {};
  for (const quantity of quantities) {
    units[quantity.unit] = quantity.quantity;
  }
  return units;
}

/**
 * Build and VALIDATE the versioned envelope the data plane receives.
 *
 * `stream` is passed rather than read off `context.request`, because it is the
 * EDGE's decision by the time this runs: a request that asked to stream and was
 * admitted by a deployment with a data plane streams, and there is exactly one
 * call site for each value.
 */
function buildEnvelope(
  context: EdgeExecutionContext,
  admitted: AdmittedRequest,
  stream: boolean
): InferenceRequest {
  const { principal, request } = context;
  const { route, maxOutputTokens, routingPolicy } = admitted;

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
    stream,
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
    // A policy REFERENCE — `{routingPolicyId, policyVersion}` — because that is
    // what `inferenceRequestSchema` publishes. The data plane therefore holds no
    // policy VALUES.
    //
    // What that costs, stated plainly rather than left to be discovered: Oxy has
    // already filtered every candidate route against this policy and resolved the
    // primary one (see `resolveEdgeRoute` above, issue #1011), so the route this
    // envelope is served on IS policy-compliant. But if the data plane fails over
    // to a DIFFERENT deployment after that route fails, it has no provider
    // allowlist, no region residency, no zero-retention requirement and no price
    // ceiling to check the replacement against — so a data-plane-initiated route
    // switch is unconstrained by the customer's policy today. It is bounded only
    // by the data plane's own refusal to substitute the MODEL, which is
    // structural there rather than policy-derived.
    //
    // The CONTRACT half of the fix has since landed (ADR 0017, #1041):
    // `inferenceRequestSchema` now accepts an optional ordered `authorizedRoutes`
    // list — routes Oxy filtered, each carrying its own substitution kind — so
    // failover becomes "take the next entry" and needs no policy semantics in the
    // data plane at all. This edge has NOT adopted it, which is why the paragraph
    // above still describes today accurately; populating it is the api half of that
    // workstream, plus a matching data-plane change. When it lands, `authorizedRoutes`
    // is the field to add — and do NOT invent a snapshot field beside it, because a
    // second, unpublished shape on this hop is exactly the divergence the contract
    // package exists to prevent.
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
/**
 * Which route capability an operation needs, before any route is resolved.
 *
 * Total over {@link EdgeOperation} with no default arm, so a new endpoint cannot
 * reach the router without declaring what it needs a model to do.
 */
export function modalityForOperation(operation: EdgeOperation): EdgeModalityRequirement {
  switch (operation.kind) {
    case 'completion':
      return TEXT_COMPLETION_MODALITY;
    case 'embeddings':
      return { input: 'text', output: 'embedding' };
    case 'rerank':
      // Input only. `INFERENCE_MODALITIES` has no member for a ranking, and
      // claiming `text` output would assert something false about the model.
      return { input: 'text' };
    case 'speech':
      return { input: 'text', output: 'audio' };
    case 'images':
      return { input: 'text', output: 'image' };
  }
}

/**
 * Output tokens an operation may generate, which is what the context check and
 * the hold both size against.
 *
 * Only a completion generates them. An embedding, a ranking, an audio clip and an
 * image are not token streams, and including `output_tokens: 0` in a ceiling would
 * be worse than omitting it: `quoteUnits` refuses a unit the route does not price,
 * so a zero would make every route that sensibly omits an `output_tokens` price
 * fail to quote.
 */
function outputTokenBudget(operation: EdgeOperation, resolved: number): number {
  return operation.kind === 'completion' ? resolved : 0;
}

/**
 * The CEILING — a provable upper bound, per priced unit, on what this request can
 * consume, derivable from the request body plus the route.
 *
 * Total over {@link EdgeOperation} with no default arm. That is the point: adding
 * a modality fails `tsc` here until its bound is written down, and an unsound
 * bound is the one defect in this file that costs money rather than availability.
 *
 * The soundness argument differs per arm and is recorded per arm, because "it
 * looked like the other ones" is how a guess enters:
 *
 *  - `input_tokens` is bounded by CHARACTERS for every arm, on the one argument
 *    that generalises: every BPE token consumes at least one character of its
 *    input, so a character count is a token ceiling. It is not a tight bound and
 *    does not need to be.
 *  - `embeddings`, `characters` and `images` are EXACT — the caller declared them.
 *    An exact figure is a valid ceiling.
 *  - Nothing here is derived from a byte length. No unit on this list is priced in
 *    bytes, and `bytes ÷ an assumed rate` is precisely the reasoning that makes a
 *    transcription hold unsound.
 */
export function ceilingForOperation(
  operation: EdgeOperation,
  estimatedInputTokens: number,
  maxOutputTokens: number
): Partial<Record<UsageUnit, number>> {
  switch (operation.kind) {
    case 'completion':
      return { input_tokens: estimatedInputTokens, output_tokens: maxOutputTokens };
    case 'embeddings':
      return { input_tokens: estimatedInputTokens, embeddings: operation.embeddings };
    case 'rerank':
      // `requests` is deliberately NOT included. A route priced only on tokens is
      // the common case, and adding a unit the route does not price would make
      // `quoteUnits` refuse it — turning a pricing convention into an outage.
      return { input_tokens: estimatedInputTokens };
    case 'speech':
      // `characters` alone. See the `speech` arm of `EdgeOperation` for why no
      // duration figure appears: a duration-priced route fails to quote and is
      // refused, which is the sound outcome.
      return { characters: operation.characters };
    case 'images':
      return { input_tokens: estimatedInputTokens, images: operation.images };
  }
}

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
  /**
   * How many allowed route switches the data plane performed. Absent on every
   * path that never reached one, where the recorder's own `0` is the truth.
   */
  readonly routeSwitches?: number;
  /**
   * The data plane's own time to first token. Forwarded, never measured here:
   * the first token is produced upstream and this edge does not stream, so the
   * only honest source is the usage report. Absent means unknown, which is what
   * the NULL column says — see {@link recordEdgeTelemetry}.
   */
  readonly timeToFirstTokenMs?: number;
}

/**
 * Record the request in the usage stream (workstream 8), including the timing
 * the observability item of workstream 16 asks for.
 *
 * Best effort, and deliberately so: telemetry is eventually consistent by
 * contract, and a dashboard write must never fail a request that has already
 * been charged. The exact billed amount comes from `usage_receipts`, never from
 * here.
 *
 * ## Why the timings are written here and not exported to a metrics library
 *
 * `inference_usage_events` already carries `latency_ms`, `time_to_first_token_ms`
 * and `route_switches`, and until now nothing wrote any of them — a metric
 * surface that existed and was empty, which reads exactly like a metric surface
 * that is correctly zero. Request rate, error rate and cancellation are already
 * derivable from this table (`request_count`, `error_count` and `outcome` on the
 * daily rollup); latency, time to first token and fallback were the three the
 * epic names that were NOT, and all three are one assignment away. Adding a
 * `prom-client` registry beside a durable table nothing scrapes would have added
 * a second, weaker copy of the same numbers. `docs/inference/observability.md`
 * argues it in full and names the infrastructure work the scrape side waits on.
 *
 * `latencyMs` is Oxy's own measurement — receipt of the request to this write —
 * so it includes authentication, admission, routing, the reservation, the
 * forward and the settlement. It is deliberately NOT the data plane's
 * `completedAt - startedAt`: that would measure the upstream and call it the
 * platform's, and the difference between the two is exactly the overhead a
 * control plane is answerable for.
 */
async function recordEdgeTelemetry(
  context: EdgeExecutionContext,
  input: EdgeTelemetryInput
): Promise<void> {
  // Rounded to a whole millisecond: the column is an integer, and drizzle would
  // otherwise hand Postgres a float for a `bigint` column.
  const latencyMs = Math.round(performance.now() - context.receivedAt);

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
      latencyMs,
      ...(input.timeToFirstTokenMs === undefined
        ? {}
        : { timeToFirstTokenMs: input.timeToFirstTokenMs }),
      ...(input.routeSwitches === undefined ? {} : { routeSwitches: input.routeSwitches }),
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
