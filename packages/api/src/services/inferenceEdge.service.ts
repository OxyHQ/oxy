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
 * `services/httpKaanaClient.ts` is the production implementation, but a
 * deployment that has not configured one (`config/kaanaDataPlane.ts`) is
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
  type RoutingTarget,
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
  exceedsAmount,
  resolveCatalogueViewer,
  resolveEdgeRoute,
  resolveRoutingProfileForEdge,
  resolveRoutingProfileForEdgeById,
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
  KaanaEnvelopeRejectedError,
  KaanaIncompleteError,
  KaanaProtocolError,
  type KaanaClient,
  type KaanaCompletion,
  type KaanaDeploymentAttestation,
  type KaanaUsageEvidence,
} from './kaanaClient';
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

/**
 * Whether an application served under {@link PLATFORM_DEFAULT_ROUTING_POLICY}
 * authorizes same-model failover in its envelope — `false`, deliberately.
 *
 * A NAMED constant for the same reason {@link UNCONSTRAINED_ROUTING} is one: "the
 * platform default grants no failover" has to be a sentence somebody wrote, not a
 * branch somebody forgot. Two reasons, and the second is the one that decides it:
 *
 *  - Same-model failover is a CUSTOMER control (`fallback.sameModelDeployment`),
 *    and under the platform default nobody set it. Withholding it grants no
 *    authority implicitly; an explicit, versioned policy is what makes any
 *    failover eligible for an envelope.
 *  - A switch made under the platform default cannot be RECORDED.
 *    `inference_route_switch_events.routing_policy_version_id` is `NOT NULL` and
 *    there is no version row to name, so {@link recordEdgeRouteSwitch} skips the
 *    notice. Authorizing a failover Oxy could not account for would put a silent
 *    hole in the route-switch history of the platform's most common
 *    configuration. Closing this needs a real platform-default policy version
 *    somebody decides to seed — the same fix `recordEdgeRouteSwitch` already
 *    names — after which this constant is what should be revisited.
 */
export const PLATFORM_DEFAULT_AUTHORIZES_SAME_MODEL_FAILOVER = false;

/* -------------------------------------------------------------------------- */
/*  Authentication                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A caller the edge has authenticated, in the ONE shape both lanes produce.
 *
 * `scopes` is current database authority, never an unverified token claim. For
 * machine/service callers it is `credential ∩ application`. For the private
 * product-session lane, the human session is the authorization and scopes are
 * the pinned application's current grants; its exact credential is a revocable
 * attribution anchor only.
 */
export interface EdgePrincipal {
  readonly lane: 'machine_credential' | 'service_token' | 'product_session';
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
   * `config/kaanaDataPlane.ts` — in which case every invoke refuses.
   */
  readonly kaanaClient?: KaanaClient;
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
  readonly finishReason: KaanaCompletion['finishReason'];
  readonly output: readonly InferenceMessage[];
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly routingPolicy: RoutingPolicyReference;
  /**
   * How long Oxy took over this request, in whole milliseconds.
   *
   * **The clock starts** at {@link EdgeExecutionContext.receivedAt} — the
   * monotonic reading `edgeGate` takes beside the request id, before
   * authentication — and **stops** at the telemetry write that follows
   * settlement. It therefore spans authentication, admission, scope
   * authorization, routing, the reservation, the forward to the data plane, and
   * the settlement of the hold: everything between the first byte this process
   * saw of the request and the last thing it did before rendering the answer.
   *
   * **Most of that interval is UPSTREAM.** The data plane generating tokens
   * dominates it, and this number does not separate the two — the part Oxy is
   * answerable for is the DIFFERENCE between this and the data plane's own
   * `completedAt - startedAt`, which is exactly why
   * {@link recordEdgeTelemetry} refuses to report the latter as the platform's.
   * It is also not the figure a caller measures: a client's own stopwatch
   * additionally covers DNS, TLS, both network legs and its own parse, so the
   * two are shown side by side and labelled rather than reconciled into one.
   *
   * It is the SAME reading `inference_usage_events.latency_ms` stores rather
   * than a second `performance.now()` taken here, so the number a customer reads
   * off their response and the number their usage dashboard reports cannot
   * disagree by the few hundred microseconds between the two statements.
   *
   * A STREAM has no equivalent and deliberately reports none: its head is
   * written before the first frame arrives, so there is no moment in a streamed
   * request at which this number both exists and can still be sent.
   */
  readonly latencyMs: number;
}

export type EdgeExecution =
  | { readonly status: 'completed'; readonly completion: EdgeCompletion }
  | { readonly status: 'refused'; readonly error: InferenceError };

/** The customer-visible frames one streamed request produces. */
export type EdgeStreamFrame =
  /**
   * The first thing a streaming route learns, yielded when the data plane's own
   * first frame arrives rather than at admission. That timing is what lets a
   * refusal Kaana makes at the ENVELOPE layer still be an HTTP status: nothing is
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
  /** The caller's concrete target or routing profile, preserved for the envelope. */
  readonly routingTarget: RoutingTarget;
  /**
   * Every route this request is authorized to be served on, in preference
   * order — `route` first, then the same-model failover destinations the
   * customer's `fallback` controls permit. What {@link buildEnvelope} sends as
   * `authorizedRoutes` (ADR 0017).
   *
   * NON-EMPTY, always: element 0 is `route`. A list of exactly one says "serve
   * this, no failover", which is what a policy with fallback off authorizes and
   * what an application on {@link PLATFORM_DEFAULT_ROUTING_POLICY} gets.
   *
   * The hold was sized against the most expensive entry, so no failover within
   * this list can settle above it — see {@link admitRequest}.
   */
  readonly authorizedRoutes: readonly EdgeRoute[];
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

/** UTF-16 code-unit order, with no locale, provider or display-name input. */
function compareExactDeploymentIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameRegionSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((region) => rightSet.has(region));
}

/**
 * Validate live data-plane evidence against the exact PostgreSQL routes the
 * request would sign. Equality is on all four identity fields. Regions are a
 * set because their wire order carries no meaning; an empty set remains the
 * explicit unattested state and therefore only equals another empty set.
 */
function deploymentAttestationMismatch(
  attestation: KaanaDeploymentAttestation,
  authorizedRoutes: readonly EdgeRoute[]
): string | undefined {
  if (
    typeof attestation?.snapshotId !== 'string' ||
    attestation.snapshotId.length === 0 ||
    !Array.isArray(attestation.deployments)
  ) {
    return 'kaana-attestation-malformed';
  }
  const expectedByID = new Map(
    authorizedRoutes.map((route) => [route.deploymentId, route] as const)
  );
  if (expectedByID.size !== authorizedRoutes.length) {
    return 'authorized-deployment-id-collision';
  }
  if (attestation.deployments.length !== expectedByID.size) {
    return 'kaana-attestation-cardinality-mismatch';
  }

  const seen = new Set<string>();
  for (const descriptor of attestation.deployments) {
    if (
      typeof descriptor?.deploymentId !== 'string' ||
      typeof descriptor.modelReference !== 'string' ||
      typeof descriptor.provider !== 'string' ||
      !Array.isArray(descriptor.regions)
    ) {
      return 'kaana-attestation-malformed';
    }
    if (seen.has(descriptor.deploymentId)) {
      return 'kaana-attestation-duplicate-id';
    }
    seen.add(descriptor.deploymentId);
    const expected = expectedByID.get(descriptor.deploymentId);
    if (expected === undefined) {
      return 'kaana-attestation-extra-id';
    }
    if (
      descriptor.modelReference !== expected.modelReference ||
      descriptor.provider !== expected.provider ||
      !sameRegionSet(descriptor.regions, expected.regions)
    ) {
      return 'kaana-attestation-identity-mismatch';
    }
  }
  return seen.size === expectedByID.size ? undefined : 'kaana-attestation-missing-id';
}

/** The stable model line shared by all revision-pinned references. */
function modelLineOf(reference: string): string {
  const separator = reference.indexOf('@');
  return separator === -1 ? reference : reference.slice(0, separator);
}

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

  const viewer = viewerForPrincipal(principal);
  const requiredModality = modalityForOperation(request.operation);
  const requestedOutput = request.maxOutputTokens;
  const estimatedInputTokens = estimateInputTokens(request);
  const requiredCapacity = {
    inputTokens: estimatedInputTokens,
    outputTokens:
      request.operation.kind !== 'completion'
        ? 0
        : requestedOutput ?? ('model-maximum' as const),
  };
  const authenticatedRoutingContext = {
    applicationId: principal.applicationId,
    environment: principal.environment,
  };
  const fallbackEnabled =
    policy.status === 'resolved' && !policy.stored.policy.fallback.disabled;
  const authorizesSameModelFailover =
    target.kind !== 'model'
      ? true
      : policy.status === 'resolved'
      ? fallbackEnabled && policy.stored.policy.fallback.sameModelDeployment
      : PLATFORM_DEFAULT_AUTHORIZES_SAME_MODEL_FAILOVER;
  const authorizesCrossModelFallback =
    target.kind !== 'model' || fallbackEnabled;

  type ResolvedRoutes = Extract<
    Awaited<ReturnType<typeof resolveEdgeRoute>>,
    { readonly status: 'resolved' }
  >;
  interface RouteGroup {
    readonly priority: number;
    readonly resolution: ResolvedRoutes;
  }
  interface RankedCandidate {
    readonly priority: number;
    readonly route: EdgeRoute;
  }

  const routingEvidenceRefusal = async (
    modelReference: string,
    reason: string
  ): Promise<Admission> => {
    await recordEdgeTelemetry(context, {
      requestedModelReference: modelReference,
      statusCode: inferenceErrorStatus('no_route_available'),
      units: {},
    });
    return refuse('no_route_available', 'No route is currently available.', {
      reason: `routing_evidence:${reason}`,
    });
  };

  const kaanaEvidenceRefusal = async (modelReference: string, reason: string): Promise<Admission> => {
    await recordEdgeTelemetry(context, {
      requestedModelReference: modelReference,
      statusCode: inferenceErrorStatus('service_unavailable'),
      units: {},
    });
    return refuse(
      'service_unavailable',
      'The inference routing evidence is temporarily unavailable.',
      { reason: `routing_evidence:${reason}` }
    );
  };

  const routeGroups: RouteGroup[] = [];
  const requestedTargetReference =
    target.kind === 'model'
      ? target.modelReference
      : target.kind === 'routing_profile_legacy'
        ? target.routingProfile
        : target.routingProfileId;
  let admittedRoutingTarget: RoutingTarget | undefined =
    target.kind === 'model' ? target : undefined;
  let requestedModelReference = target.kind === 'model' ? target.modelReference : '';
  let implicitOutputCeiling: number | undefined;
  let sawOutputLimit = false;
  let sawContextLimit = false;
  let sawRequestPriceExclusion = false;
  let concreteFailure: Exclude<
    Awaited<ReturnType<typeof resolveEdgeRoute>>,
    { readonly status: 'resolved' }
  > | undefined;
  const maxPricePerRequest = routingConstraints.maxPricePerRequest;
  const priceEligibleDeploymentIds = new Set<string>();
  const quotedCandidateCeilings = new Map<
    string,
    { readonly amount: string; readonly currency: string }
  >();

  const capacityForNextPriority = (): typeof requiredCapacity =>
    request.operation.kind === 'completion' &&
    requestedOutput === undefined &&
    implicitOutputCeiling !== undefined
      ? { inputTokens: estimatedInputTokens, outputTokens: implicitOutputCeiling }
      : requiredCapacity;

  const qualifyPriority = async (
    resolutions: readonly ResolvedRoutes[]
  ): Promise<Admission | undefined> => {
    const rankedAtPriority = resolutions
      .flatMap((resolution) => [resolution.route, ...resolution.alternates])
      .sort((left, right) => {
        if (routingConstraints.byokPreference === 'prefer') {
          const leftIsByok = left.availabilityScope === 'byok_only';
          const rightIsByok = right.availabilityScope === 'byok_only';
          if (leftIsByok !== rightIsByok) return leftIsByok ? -1 : 1;
        }
        const byScore = right.routingScore - left.routingScore;
        if (byScore !== 0) return byScore;
        return compareExactDeploymentIds(left.deploymentId, right.deploymentId);
      });

    // Without a request ceiling there is no price qualification to perform at
    // this stage. Preserve the original rule: the first resolvable priority's
    // score/ID winner fixes an omitted output ceiling before lower priorities
    // are resolved, so a smaller fallback is rejected on capacity before its
    // route evidence can affect this request.
    if (maxPricePerRequest === undefined) {
      if (
        request.operation.kind === 'completion' &&
        requestedOutput === undefined &&
        implicitOutputCeiling === undefined
      ) {
        implicitOutputCeiling = rankedAtPriority[0]?.maxOutputTokens;
      }
      return undefined;
    }

    const priceSurvivors: EdgeRoute[] = [];
    for (const route of rankedAtPriority) {
      const candidateMaxOutputTokens = outputTokenBudget(
        request.operation,
        requestedOutput ?? route.maxOutputTokens
      );
      let candidateQuote: { readonly amount: string; readonly currency: string } | undefined;
      for (const units of ceilingQuoteScenarios(
        request.operation,
        estimatedInputTokens,
        candidateMaxOutputTokens
      )) {
        const scenarioQuote = await quoteUnits(route.priceVersionId, units);
        if (scenarioQuote.status !== 'quoted') {
          logger.error(
            'inference.edge.routing_evidence_unavailable',
            new Error(`route ${route.deploymentId} could not be quoted: ${scenarioQuote.status}`),
            { requestId, deploymentId: route.deploymentId, reason: scenarioQuote.status }
          );
          return routingEvidenceRefusal(
            requestedModelReference || route.modelReference,
            'missing-price'
          );
        }
        if (
          candidateQuote === undefined ||
          exceedsAmount(scenarioQuote.amount, candidateQuote.amount)
        ) {
          candidateQuote = { amount: scenarioQuote.amount, currency: scenarioQuote.currency };
        }
      }
      if (candidateQuote === undefined) {
        return routingEvidenceRefusal(
          requestedModelReference || route.modelReference,
          'missing-price'
        );
      }
      quotedCandidateCeilings.set(route.deploymentId, candidateQuote);
      if (
        candidateQuote.currency === maxPricePerRequest.currency &&
        !exceedsAmount(candidateQuote.amount, maxPricePerRequest.amount)
      ) {
        priceEligibleDeploymentIds.add(route.deploymentId);
        priceSurvivors.push(route);
      } else {
        sawRequestPriceExclusion = true;
      }
    }

    // Price is a qualification control. Only a survivor at this priority may
    // fix an omitted output ceiling; if every route is over the cap, resolve the
    // next priority against its own model maximum instead. Once fixed, lower
    // priorities are capacity-filtered by resolveEdgeRoute BEFORE their exact
    // ID/price/score evidence is evaluated.
    if (
      request.operation.kind === 'completion' &&
      requestedOutput === undefined &&
      implicitOutputCeiling === undefined &&
      priceSurvivors[0] !== undefined
    ) {
      implicitOutputCeiling = priceSurvivors[0].maxOutputTokens;
    }
    return undefined;
  };

  if (target.kind === 'model') {
    if (policy.status !== 'resolved') {
      return routingEvidenceRefusal(target.modelReference, 'missing-versioned-optimisation');
    }
    const optimiseFor = policy.stored.policy.optimiseFor;
    const primary = await resolveEdgeRoute(
      viewer,
      target.modelReference,
      routingConstraints,
      requiredModality,
      optimiseFor,
      capacityForNextPriority(),
      authenticatedRoutingContext
    );
    if (primary.status === 'routing-evidence-unavailable') {
      return routingEvidenceRefusal(target.modelReference, primary.reason);
    }
    if (primary.status === 'resolved') {
      routeGroups.push({ priority: 0, resolution: primary });
      const qualification = await qualifyPriority([primary]);
      if (qualification !== undefined) return qualification;
    } else {
      concreteFailure = primary;
      if (primary.status === 'capacity-unavailable') {
        sawOutputLimit ||= primary.outputLimitExceeded;
        sawContextLimit ||= primary.contextLimitExceeded;
      }
    }

    if (
      fallbackEnabled &&
      !target.modelReference.includes('@') &&
      policy.status === 'resolved'
    ) {
      for (const [index, modelReference] of policy.stored.policy.fallback.authorizedCrossModel.entries()) {
        const fallback = await resolveEdgeRoute(
          viewer,
          modelReference,
          routingConstraints,
          requiredModality,
          optimiseFor,
          capacityForNextPriority(),
          authenticatedRoutingContext
        );
        if (fallback.status === 'routing-evidence-unavailable') {
          return routingEvidenceRefusal(target.modelReference, fallback.reason);
        }
        if (fallback.status === 'resolved') {
          routeGroups.push({ priority: index + 1, resolution: fallback });
          const qualification = await qualifyPriority([fallback]);
          if (qualification !== undefined) return qualification;
        } else if (fallback.status === 'capacity-unavailable') {
          sawOutputLimit ||= fallback.outputLimitExceeded;
          sawContextLimit ||= fallback.contextLimitExceeded;
        }
      }
    }
  } else {
    const exactIdTarget = target.kind === 'routing_profile_id';
    const profileResolution = exactIdTarget
      ? await resolveRoutingProfileForEdgeById(target.routingProfileId)
      : await resolveRoutingProfileForEdge(target.routingProfile);
    if (profileResolution.status === 'unknown-profile') {
      return refuse('no_route_available', 'No route is currently available.', {
        param: exactIdTarget ? 'routingProfileId' : 'routingProfile',
        reason: exactIdTarget ? 'unknown_routing_profile_id' : 'unknown_routing_profile',
      });
    }
    if (profileResolution.status === 'routing-evidence-unavailable') {
      return routingEvidenceRefusal(requestedTargetReference, profileResolution.reason);
    }
    const { profile } = profileResolution;
    // The deprecated public slug is resolved here and cannot cross the signed
    // boundary. Both public selectors emit the exact canonical catalogue PK.
    admittedRoutingTarget = {
      kind: 'routing_profile_id',
      routingProfileId: profile.routingProfileId,
    };

    const priorities = [...new Set(profile.candidates.map((candidate) => candidate.priority))].sort(
      (left, right) => left - right
    );
    for (const priority of priorities) {
      const resolvedAtPriority: ResolvedRoutes[] = [];
      for (const candidate of profile.candidates.filter((entry) => entry.priority === priority)) {
        const resolution = await resolveEdgeRoute(
          viewer,
          candidate.modelReference,
          routingConstraints,
          requiredModality,
          profile.optimiseFor,
          capacityForNextPriority(),
          authenticatedRoutingContext
        );
        if (resolution.status === 'routing-evidence-unavailable') {
          return routingEvidenceRefusal(candidate.modelReference, resolution.reason);
        }
        if (resolution.status === 'resolved') {
          resolvedAtPriority.push(resolution);
          routeGroups.push({ priority, resolution });
        } else if (resolution.status === 'capacity-unavailable') {
          sawOutputLimit ||= resolution.outputLimitExceeded;
          sawContextLimit ||= resolution.contextLimitExceeded;
        }
      }
      const qualification = await qualifyPriority(resolvedAtPriority);
      if (qualification !== undefined) return qualification;
    }
  }

  const rankedCandidates: RankedCandidate[] = [];
  for (const group of routeGroups) {
    for (const route of [group.resolution.route, ...group.resolution.alternates]) {
      if (
        maxPricePerRequest !== undefined &&
        !priceEligibleDeploymentIds.has(route.deploymentId)
      ) {
        continue;
      }
      if (requestedOutput !== undefined && requestedOutput > route.maxOutputTokens) {
        sawOutputLimit = true;
        continue;
      }
      const routeOutputTokens = outputTokenBudget(
        request.operation,
        requestedOutput ?? route.maxOutputTokens
      );
      if (estimatedInputTokens + routeOutputTokens > route.maxContextTokens) {
        sawContextLimit = true;
        continue;
      }
      rankedCandidates.push({ priority: group.priority, route });
    }
  }

  rankedCandidates.sort((left, right) => {
    const byPriority = left.priority - right.priority;
    if (byPriority !== 0) return byPriority;
    if (routingConstraints.byokPreference === 'prefer') {
      const leftIsByok = left.route.availabilityScope === 'byok_only';
      const rightIsByok = right.route.availabilityScope === 'byok_only';
      if (leftIsByok !== rightIsByok) return leftIsByok ? -1 : 1;
    }
    const byScore = right.route.routingScore - left.route.routingScore;
    if (byScore !== 0) return byScore;
    return compareExactDeploymentIds(left.route.deploymentId, right.route.deploymentId);
  });

  const uniqueCandidates: RankedCandidate[] = [];
  const seenDeploymentIds = new Set<string>();
  for (const candidate of rankedCandidates) {
    if (seenDeploymentIds.has(candidate.route.deploymentId)) {
      return routingEvidenceRefusal(
        requestedModelReference || candidate.route.modelReference,
        'duplicate-authorized-deployment'
      );
    }
    seenDeploymentIds.add(candidate.route.deploymentId);
    uniqueCandidates.push(candidate);
  }

  const primaryCandidate = uniqueCandidates[0];
  if (primaryCandidate === undefined) {
    if (maxPricePerRequest !== undefined && sawRequestPriceExclusion) {
      const refusedReference =
        requestedModelReference ||
        routeGroups[0]?.resolution.route.modelReference ||
        requestedTargetReference;
      await recordEdgeTelemetry(context, {
        requestedModelReference: refusedReference,
        statusCode: inferenceErrorStatus('policy_violation'),
        units: {},
      });
      return refuse(
        'policy_violation',
        `Every route for ${refusedReference} is excluded by this application’s routing policy: maxPricePerRequest.`,
        { reason: 'policy_excluded:maxPricePerRequest' }
      );
    }
    if (target.kind === 'model' && concreteFailure?.status === 'unknown-model') {
      await recordEdgeTelemetry(context, {
        requestedModelReference,
        statusCode: inferenceErrorStatus('model_not_found'),
        units: {},
      });
      return refuse('model_not_found', `No model ${requestedModelReference} is available to you.`, {
        param: 'model',
      });
    }
    if (target.kind === 'model' && concreteFailure?.status === 'policy-excluded') {
      await recordEdgeTelemetry(context, {
        requestedModelReference,
        statusCode: inferenceErrorStatus('policy_violation'),
        units: {},
      });
      return refuse(
        'policy_violation',
        `Every route for ${requestedModelReference} is excluded by this application’s routing policy: ${concreteFailure.constraints.join(', ')}.`,
        { reason: `policy_excluded:${concreteFailure.constraints.join(',')}` }
      );
    }
    if (target.kind === 'model' && concreteFailure?.status === 'modality-unsupported') {
      const wanted =
        concreteFailure.required.output === undefined
          ? `${concreteFailure.required.input} input`
          : `${concreteFailure.required.input} input and ${concreteFailure.required.output} output`;
      return refuse(
        'unsupported_modality',
        `${requestedModelReference} does not serve ${wanted}. It accepts ${concreteFailure.supportedInput.join(', ')} and produces ${concreteFailure.supportedOutput.join(', ')}.`,
        { param: 'model' }
      );
    }
    if (sawOutputLimit) {
      return refuse('output_limit_exceeded', 'No authorized route supports that output ceiling.', {
        param: 'max_output_tokens',
      });
    }
    if (sawContextLimit) {
      return refuse(
        'context_length_exceeded',
        'No authorized route can fit this request and its output ceiling.',
        { param: 'input' }
      );
    }
    return refuse('no_route_available', 'No route is currently available.', {
      ...(target.kind === 'routing_profile_legacy'
        ? { param: 'routingProfile' }
        : target.kind === 'routing_profile_id'
          ? { param: 'routingProfileId' }
          : {}),
      reason: 'no_ordinary_candidate',
    });
  }

  const route = primaryCandidate.route;
  if (target.kind !== 'model') requestedModelReference = route.modelReference;
  if (admittedRoutingTarget === undefined) {
    return routingEvidenceRefusal(requestedTargetReference, 'missing-resolved-routing-target');
  }
  const maxOutputTokens = outputTokenBudget(
    request.operation,
    requestedOutput ?? route.maxOutputTokens
  );
  const capacityCompatible = uniqueCandidates.filter(
    (candidate) =>
      candidate.route.maxOutputTokens >= maxOutputTokens &&
      candidate.route.maxContextTokens >= estimatedInputTokens + maxOutputTokens
  );

  const authorizedRoutes: EdgeRoute[] = [route];
  const admittedModelLine = modelLineOf(route.modelReference);
  const authorizedModelLines = new Set<string>([admittedModelLine]);
  for (const candidate of capacityCompatible.slice(1)) {
    const candidateModelLine = modelLineOf(candidate.route.modelReference);
    if (candidateModelLine === admittedModelLine) {
      if (authorizesSameModelFailover) authorizedRoutes.push(candidate.route);
      continue;
    }
    if (!authorizesCrossModelFallback) continue;
    if (!authorizedModelLines.has(candidateModelLine) || authorizesSameModelFailover) {
      authorizedRoutes.push(candidate.route);
      authorizedModelLines.add(candidateModelLine);
    }
  }

  // 6b. Reconcile Oxy's complete exact-ID authorization set with ONE live
  //     Kaana inventory snapshot before any hold or inference POST. This is
  //     identity attestation, not route selection: no name, provider, model or
  //     array position can substitute for an exact deployment id.
  //
  // This preflight cannot eliminate the TOCTOU between this snapshot and
  // execution on another Kaana replica. The signed inference envelope therefore
  // keeps the executor's exact-route revalidation, and the existing settlement
  // path releases/refunds a hold if the route is retired in that interval. A
  // snapshot id is deliberately not sent as a pretend lease: Kaana does not
  // retain snapshots globally across replicas, so that would create safety by
  // name without creating the state required to enforce it.
  if (context.kaanaClient === undefined) {
    return kaanaEvidenceRefusal(requestedModelReference, 'kaana-not-configured');
  }
  let attestation: KaanaDeploymentAttestation;
  try {
    attestation = await context.kaanaClient.attestDeployments(
      authorizedRoutes.map((authorized) => authorized.deploymentId),
      { signal: context.signal }
    );
  } catch (error) {
    logger.error(
      'inference.edge.routing_evidence_unavailable',
      error instanceof Error ? error : new Error(String(error)),
      { requestId, reason: 'kaana-attestation-failed' }
    );
    return kaanaEvidenceRefusal(requestedModelReference, 'kaana-attestation-failed');
  }
  const attestationMismatch = deploymentAttestationMismatch(attestation, authorizedRoutes);
  if (attestationMismatch !== undefined) {
    logger.error(
      'inference.edge.routing_evidence_unavailable',
      new Error('Kaana deployment attestation did not match the exact authorization set.'),
      { requestId, reason: attestationMismatch }
    );
    return kaanaEvidenceRefusal(requestedModelReference, attestationMismatch);
  }

  // 6c. Size the hold at the exact maximum of every partition the request can
  //     consume, for every route the signed envelope authorizes. Completion
  //     input is split between ordinary and cached tokens, and output between
  //     ordinary and reasoning tokens. Quoting all four extreme partitions is
  //     exactly `inputCeiling * max(input, cached) + outputCeiling *
  //     max(output, reasoning)`, while keeping all amount/per arithmetic inside
  //     the ledger's exact numeric implementation. It also makes an absent
  //     child price fail closed before a hold or Kaana call.
  const quoteScenarios = ceilingQuoteScenarios(
    request.operation,
    estimatedInputTokens,
    maxOutputTokens
  );
  const quotes = new Map<string, { readonly amount: string; readonly currency: string }>();
  let quoteCurrency: string | undefined;
  for (const authorized of authorizedRoutes) {
    let routeQuote = quotedCandidateCeilings.get(authorized.deploymentId);
    if (routeQuote === undefined || requestedOutput === undefined) {
      routeQuote = undefined;
      for (const units of quoteScenarios) {
        const scenarioQuote = await quoteUnits(authorized.priceVersionId, units);
        if (scenarioQuote.status !== 'quoted') {
          logger.error(
            'inference.edge.routing_evidence_unavailable',
            new Error(
              `route ${authorized.deploymentId} could not be quoted: ${scenarioQuote.status}`
            ),
            { requestId, deploymentId: authorized.deploymentId, reason: scenarioQuote.status }
          );
          return routingEvidenceRefusal(requestedModelReference, 'missing-price');
        }
        if (routeQuote === undefined || exceedsAmount(scenarioQuote.amount, routeQuote.amount)) {
          routeQuote = { amount: scenarioQuote.amount, currency: scenarioQuote.currency };
        }
      }
    }
    if (routeQuote === undefined) {
      return routingEvidenceRefusal(requestedModelReference, 'missing-price');
    }
    if (quoteCurrency !== undefined && routeQuote.currency !== quoteCurrency) {
      return routingEvidenceRefusal(requestedModelReference, 'price-currency-mismatch');
    }
    quoteCurrency = routeQuote.currency;
    quotes.set(authorized.deploymentId, routeQuote);
  }

  const quote = quotes.get(route.deploymentId);
  if (quote === undefined) {
    return routingEvidenceRefusal(requestedModelReference, 'missing-primary-price');
  }

  let ceilingPriceVersionId = route.priceVersionId;
  let maxAmount = quote.amount;
  for (const authorized of authorizedRoutes.slice(1)) {
    const authorizedQuote = quotes.get(authorized.deploymentId);
    if (authorizedQuote === undefined) {
      return routingEvidenceRefusal(requestedModelReference, 'missing-authorized-price');
    }
    if (exceedsAmount(authorizedQuote.amount, maxAmount)) {
      ceilingPriceVersionId = authorized.priceVersionId;
      maxAmount = authorizedQuote.amount;
    }
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

  // 6d. Reserve. NOTHING is forwarded before this returns `reserved` — unless
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
      ceilingPriceVersionId,
      maxAmount,
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
      routingTarget: admittedRoutingTarget,
      authorizedRoutes,
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

  let completion: KaanaCompletion;
  try {
    if (context.kaanaClient === undefined) {
      throw new DataPlaneNotConfiguredError();
    }
    completion = await context.kaanaClient.execute(envelope, { signal: context.signal });
  } catch (error) {
    const failure = classifyForwardFailure(error, context.signal);
    // Whatever the data plane DID measure before it stopped — `KaanaIncompleteError`
    // carries it — is what this settles against. A full refund on a request that
    // produced two hundred tokens would be Oxy absorbing a cost it can account
    // for, which is the mirror of the over-charge the reservation prevents.
    //
    // Built ONCE and shared with the telemetry row below, so the receipt and the
    // event name the same provider: a failure whose evidence was a full report
    // names the REPORTED provider on both, and one with no report names the
    // admitted route on both. Two `settlementFrom` calls would be two chances to
    // disagree about a request that already failed.
    const evidence = usageEvidenceOf(error);
    const evidenceValidation =
      evidence === undefined
        ? undefined
        : validateUsageEvidence(evidence, requestId, admitted.authorizedRoutes);
    if (evidenceValidation?.status === 'invalid') {
      logger.error(
        'inference.edge.incomplete_usage_report_rejected',
        new Error('the incomplete response carried usage outside the signed exact route list'),
        { requestId, accountId: principal.ownerAccountId, reason: evidenceValidation.reason }
      );
    }
    const trustedEvidence = evidenceValidation?.status === 'valid' ? evidence : undefined;
    const servedRoute = evidenceValidation?.status === 'valid' ? evidenceValidation.route : route;
    const settlement = settlementFrom(trustedEvidence, failure.outcome, servedRoute.provider);
    await settleMeasured(context, admitted, settlement, servedRoute);
    await recordEdgeTelemetry(context, {
      requestedModelReference: admitted.requestedModelReference,
      statusCode: inferenceErrorStatus(failure.code),
      units: {},
      resolvedModelReference: servedRoute.modelReference,
      servingProvider: settlement.servingProvider,
      outcome: failure.outcome,
    });
    return {
      status: 'refused',
      error: refuseRequest(context, failure.code, failure.message, { reason: failure.reason }),
    };
  }

  // The data plane answering about a different request, or naming any route not
  // present in the signed exact-ID authorization list, is a refusal rather than
  // a warning. Cross-model substitution is valid only when that exact route was
  // explicitly authorized in the envelope.
  const validation = validateCompletion(completion, requestId, admitted.authorizedRoutes);
  if (validation.status === 'invalid') {
    await settleMeasured(
      context,
      admitted,
      settlementFrom(undefined, 'failed', route.provider),
      route
    );
    await recordEdgeTelemetry(context, {
      requestedModelReference: admitted.requestedModelReference,
      statusCode: inferenceErrorStatus(validation.code),
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
      error: refuseRequest(context, validation.code, validation.message, {
        reason: validation.reason,
      }),
    };
  }
  const servedRoute = validation.route;

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
    await recordShadowMetering(context, servedRoute, units, {
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
      resolvedModelReference: servedRoute.modelReference,
      servingProvider,
      priceVersionId: servedRoute.priceVersionId,
      platformFeeOnly: servedRoute.availabilityScope === 'byok_only',
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
  // `?? []` because `KaanaCompletion` is deserialized JSON, and a required
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

  // The one reading of the clock this request gets. The telemetry row and the
  // customer's response both quote it — see {@link EdgeCompletion.latencyMs}.
  const latencyMs = await recordEdgeTelemetry(context, {
    requestedModelReference: admitted.requestedModelReference,
    statusCode: 200,
    units,
    resolvedModelReference: servedRoute.modelReference,
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
      resolvedModelReference: servedRoute.modelReference,
      servingProvider,
      finishReason: completion.finishReason,
      output: completion.output,
      units,
      routingPolicy: admitted.routingPolicy,
      latencyMs,
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
 *  - `KaanaClient.stream`'s own `finally` aborts the upstream hop, which is what
 *    propagates a client disconnect to Kaana and from there to the provider.
 *
 * A cancelled request is a SETTLEMENT case (ADR 0009), never a discarded one: the
 * units measured before the cut are charged and the rest of the hold is released,
 * so a customer who cancels pays for what they received.
 *
 * ## Where the usage comes from, in order of authority
 *
 *  1. the terminal `usage_report` frame — the full normalized report;
 *  2. the last in-stream `usage` event, when the report never arrived, which is
 *     the ordinary case for a client disconnect: Kaana still produces a report
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

  const kaanaClient = context.kaanaClient;
  if (kaanaClient === undefined) {
    // Unreachable: `admitRequest` refuses a streaming request with no data plane
    // before reserving anything. Handled rather than asserted because the
    // alternative is a non-null assertion, and because a future edit to that
    // order would otherwise release nothing.
    await settleMeasured(
      context,
      admitted,
      settlementFrom(undefined, 'failed', route.provider),
      route
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
  let partial: KaanaUsageEvidence | undefined;
  let terminal: InferenceError | undefined;
  let forwardFailure: ForwardFailure | undefined;
  let meteringProtocolRejected = false;
  let opened = false;
  let sawOutput = false;

  try {
    for await (const frame of kaanaClient.stream(envelope, { signal: context.signal })) {
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
        partial = {
          kind: 'partial',
          requestId: event.requestId,
          deploymentId: event.deploymentId,
          units: event.units,
          usageSource: event.usageSource,
        };
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
    // A known Kaana frame that failed its schema may have been the terminal
    // usage report itself. Treat the whole metering sequence as contradictory:
    // otherwise `report` remains undefined and an earlier partial frame could be
    // charged after the terminal record was explicitly unreadable.
    meteringProtocolRejected = error instanceof KaanaProtocolError;
    forwardFailure = classifyForwardFailure(error, context.signal);
  } finally {
    // A report that answers a different request, or names a model this edge did
    // not admit, is DISCARDED rather than settled: it is the input to a charge and
    // it crosses a service boundary. Unlike the non-streaming path this cannot
    // also refuse the response — the customer already has it — so the request
    // settles as unmeasured and the discrepancy is loud in the log.
    const usable =
      report === undefined
        ? undefined
        : validateUsageReport(report, context.requestId, admitted.authorizedRoutes);
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

    // A present but invalid terminal report invalidates the whole metering
    // record; never fall back from a contradictory report to an earlier partial
    // event. Partial evidence is usable only when no report arrived and its
    // request/deployment identity resolves to exactly one signed route.
    const partialValidation =
      report === undefined && !meteringProtocolRejected && partial !== undefined
        ? validateUsageEvidence(partial, context.requestId, admitted.authorizedRoutes)
        : undefined;
    if (meteringProtocolRejected && partial !== undefined) {
      logger.error(
        'inference.edge.stream_partial_usage_discarded_after_protocol_rejection',
        new Error('a later known Kaana frame failed schema validation'),
        { requestId: context.requestId }
      );
    }
    if (partialValidation?.status === 'invalid') {
      logger.error(
        'inference.edge.stream_partial_usage_rejected',
        new Error('the streamed partial usage did not name one signed exact route'),
        { requestId: context.requestId, reason: partialValidation.reason }
      );
    }
    const evidence: KaanaUsageEvidence | undefined =
      usable !== undefined
        ? { kind: 'report', report: usable.report }
        : partialValidation?.status === 'valid'
          ? partial
          : undefined;
    const outcome = streamOutcome(context, { terminal, sawOutput });
    const servedRoute = usable?.route ??
      (partialValidation?.status === 'valid' ? partialValidation.route : route);
    const settlement = settlementFrom(evidence, outcome, servedRoute.provider);

    await settleMeasured(context, admitted, settlement, servedRoute);
    await recordEdgeTelemetry(context, {
      requestedModelReference: admitted.requestedModelReference,
      // A stream that produced any frame answered 200 and cannot un-answer it.
      statusCode: opened
        ? 200
        : inferenceErrorStatus(forwardFailure?.code ?? terminal?.code ?? 'internal_error'),
      units: settlement.units,
      resolvedModelReference: servedRoute.modelReference,
      // REPORTED when a usable report arrived, admitted otherwise — the same
      // value the receipt carries, resolved once in `settlementFrom`. A stream's
      // `X-Oxy-Provider` header deliberately differs here: see
      // {@link EdgeStreamHead}.
      servingProvider: settlement.servingProvider,
      outcome: settlement.outcome,
      usageSource: settlement.usageSource,
      ...(usable === undefined ? {} : { routeSwitches: usable.report.routeSwitches }),
      ...(usable?.report.timeToFirstTokenMs === undefined
        ? {}
        : { timeToFirstTokenMs: usable.report.timeToFirstTokenMs }),
      ...(settlement.generationId === undefined
        ? {}
        : { generationId: settlement.generationId }),
    });
  }

  // A transport or protocol failure produced no terminal event, so the customer
  // has not been told the stream ended. Kaana's OWN terminal error was already
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
 * the events `KaanaCompletion.routeSwitchEvents` carried out of the fold. The
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
 * It does NOT claim the switch respected the customer's routing policy, and that
 * is unchanged now that {@link buildEnvelope} sends `authorizedRoutes` (ADR 0017).
 * What the list changes is where the guarantee comes from: a data plane that
 * takes the next ENTRY cannot leave the set Oxy filtered, because every entry
 * survived the customer's controls before it was sent. What it cannot do is prove
 * the data plane took an entry. A row here still records what the data plane
 * REPORTED, and a report is not evidence about the reporter.
 * **Do not upgrade this to a compliance assertion.**
 *
 * That is also why a deployment-scope switch is still WRITTEN when the customer's
 * `fallback.sameModelDeployment` is off. Under this edge such a switch is
 * unauthorized by construction — the envelope named exactly one route — so the
 * row is evidence that something served a route it was not given, and refusing to
 * record it would destroy exactly the evidence worth keeping.
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
    platformFeeOnly: route.availabilityScope === 'byok_only',
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
 *  - the units of a validated in-stream `usage` event: exact units tied to one
 *    exact authorized deployment, while the outcome comes from the edge, which
 *    is the only party that knows whether the client cancelled;
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
 * The REPORTED one on the first arm, the already-validated deployment provider
 * on the partial arm, and `admittedProvider` only when no usage evidence exists.
 *
 * A partial event names an exact deployment but not a provider; its caller must
 * resolve that ID against the signed route list and pass the resolved provider.
 * Nothing arrived names nothing by definition, so only that arm uses the
 * admitted provider.
 */
function settlementFrom(
  evidence: KaanaUsageEvidence | undefined,
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
function usageEvidenceOf(error: unknown): KaanaUsageEvidence | undefined {
  return error instanceof KaanaIncompleteError ? error.usage : undefined;
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
  settlement: MeasuredSettlement,
  servedRoute: EdgeRoute
): Promise<void> {
  const { hold } = admitted;

  if (hold === undefined) {
    await recordShadowMetering(context, servedRoute, settlement.units, {
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
      resolvedModelReference: servedRoute.modelReference,
      servingProvider: settlement.servingProvider,
      priceVersionId: servedRoute.priceVersionId,
      platformFeeOnly: servedRoute.availabilityScope === 'byok_only',
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
 * `KaanaEnvelopeRejectedError` means Oxy's signature, envelope version or body
 * was refused. Surfacing Kaana's code would tell a customer their API key is bad
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
  if (error instanceof KaanaIncompleteError) {
    if (error.reason === 'terminal_error' && error.failure !== undefined) {
      return {
        code: error.failure.code,
        message: error.failure.message,
        reason: `kaana_error:${error.failure.code}`,
        outcome: error.failure.code === 'cancelled' ? 'cancelled' : 'failed',
      };
    }
    if (error.reason === 'usage_missing') {
      return {
        code: 'internal_error',
        message: 'The request ran and Oxy could not read the usage it produced.',
        reason: 'kaana_usage_missing',
        outcome: 'failed',
      };
    }
    return {
      code: 'provider_error',
      message: 'The inference data plane stopped responding before the request completed.',
      reason: 'kaana_stream_truncated',
      outcome: 'failed',
    };
  }
  if (error instanceof KaanaEnvelopeRejectedError) {
    return {
      code: 'internal_error',
      message: 'The request could not be forwarded to the inference data plane.',
      reason: `kaana_rejected_envelope:${error.status}`,
      outcome: 'failed',
    };
  }
  if (error instanceof KaanaProtocolError) {
    return {
      code: 'internal_error',
      message: 'The inference data plane answered in a form Oxy could not read.',
      reason: 'kaana_protocol',
      outcome: 'failed',
    };
  }
  return {
    code: 'provider_error',
    message: 'The inference data plane could not serve this request.',
    reason: 'kaana_error',
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
type CompletionValidation =
  | { readonly status: 'valid'; readonly route: EdgeRoute }
  | {
      readonly status: 'invalid';
      readonly code: InferenceErrorCode;
      readonly message: string;
      readonly reason: string;
    };

function validateCompletion(
  completion: KaanaCompletion,
  requestId: string,
  authorizedRoutes: readonly EdgeRoute[]
): CompletionValidation {
  const report = normalizedUsageReportSchema.safeParse(completion.usage);
  if (!report.success) {
    return {
      status: 'invalid',
      code: 'internal_error',
      message: 'The inference data plane returned a usage report Oxy could not read.',
      reason: `usage_report_invalid:${report.error.issues[0]?.path.join('.') ?? 'unknown'}`,
    };
  }

  return validateReportRoute(report.data, requestId, authorizedRoutes);
}

function validateReportRoute(
  report: NormalizedUsageReport,
  requestId: string,
  authorizedRoutes: readonly EdgeRoute[]
): CompletionValidation {
  if (report.requestId !== requestId) {
    return {
      status: 'invalid',
      code: 'internal_error',
      message: 'The inference data plane answered a different request.',
      reason: 'request_id_mismatch',
    };
  }

  const candidates = authorizedRoutes.filter(
    (route) =>
      route.deploymentId === report.deploymentId &&
      route.modelReference === report.resolvedModelReference &&
      route.provider === report.servingProvider
  );
  if (candidates.length === 0) {
    return {
      status: 'invalid',
      code: 'policy_violation',
      message: 'The request was served by a deployment no routing policy authorized.',
      reason: 'route_not_authorized',
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'invalid',
      code: 'internal_error',
      message: 'The exact deployment identity matched more than one authorized route.',
      reason: 'deployment_id_ambiguous',
    };
  }
  return { status: 'valid', route: candidates[0] };
}

/** Validate either terminal or partial metering against one exact signed route. */
function validateUsageEvidence(
  evidence: KaanaUsageEvidence,
  requestId: string,
  authorizedRoutes: readonly EdgeRoute[]
): CompletionValidation {
  if (evidence.kind === 'report') {
    return validateReportRoute(evidence.report, requestId, authorizedRoutes);
  }
  if (evidence.requestId !== requestId) {
    return {
      status: 'invalid',
      code: 'internal_error',
      message: 'The inference data plane metered a different request.',
      reason: 'request_id_mismatch',
    };
  }
  const candidates = authorizedRoutes.filter(
    (route) => route.deploymentId === evidence.deploymentId
  );
  if (candidates.length === 0) {
    return {
      status: 'invalid',
      code: 'policy_violation',
      message: 'Partial usage named a deployment no routing policy authorized.',
      reason: 'route_not_authorized',
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'invalid',
      code: 'internal_error',
      message: 'Partial usage matched more than one authorized deployment.',
      reason: 'deployment_id_ambiguous',
    };
  }
  return { status: 'valid', route: candidates[0] };
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
  authorizedRoutes: readonly EdgeRoute[]
): { readonly report: NormalizedUsageReport; readonly route: EdgeRoute } | undefined {
  const validation = validateReportRoute(report, requestId, authorizedRoutes);
  if (validation.status === 'invalid') return undefined;
  return { report, route: validation.route };
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
  const { route, routingTarget, authorizedRoutes, maxOutputTokens, routingPolicy } = admitted;
  const authorizesCrossModel = authorizedRoutes.some(
    (authorized) => modelLineOf(authorized.modelReference) !== modelLineOf(route.modelReference)
  );

  return inferenceRequestSchema.parse({
    schemaVersion: 2,
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
    // The signed route list pins every executable destination. Preserve a
    // profile, and preserve an unpinned concrete target only when its versioned
    // policy authorized a cross-model fallback; otherwise pin the admitted
    // model revision itself.
    target:
      routingTarget.kind === 'routing_profile_id' || authorizesCrossModel
        ? routingTarget
        : { kind: 'model', modelReference: route.modelReference },
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
    // The routes Oxy has authorized for this request, in preference order, and a
    // policy REFERENCE beside them (ADR 0017). The reference is provenance only —
    // it lets a receipt name the exact configuration that produced the charge —
    // and the data plane still holds no policy VALUE: no provider allowlist, no
    // region residency, no zero-retention requirement, no price ceiling. It does
    // not need one. Every entry here already survived all of them, so failing over
    // is "take the next entry" and a switch outside the customer's policy is
    // impossible BY CONSTRUCTION rather than by two enforcement engines, in two
    // languages, agreeing.
    //
    // A one-entry list is not a degenerate case: it is what a policy with fallback
    // off, and what the platform default, authorize — serve this route or fail.
    // The list is never empty (`authorizedRoutes[0]` is the admitted route) and
    // Cross-model entries exist only when the concrete versioned policy or the
    // explicit profile authorized them; the exact deployment identities below
    // are the only destinations Kaana may execute.
    //
    // Do NOT add a policy snapshot field beside this. A second, unpublished shape
    // on this hop is exactly the divergence the contract package exists to
    // prevent, and it would put the eleven filtered controls back on the data
    // plane's side of the boundary.
    authorizedRoutes: authorizedRoutes.map((authorized) => {
      const crossModel =
        modelLineOf(authorized.modelReference) !== modelLineOf(route.modelReference);
      return {
        substitution: crossModel ? 'cross_model' : 'same_model',
        ...(crossModel ? { authorizedByPolicy: true as const } : {}),
        deploymentId: authorized.deploymentId,
        modelReference: authorized.modelReference,
        provider: authorized.provider,
        regions: authorized.regions,
        ...(authorized.customerProviderCredential === undefined
          ? {}
          : { customerProviderCredential: authorized.customerProviderCredential }),
      };
    }),
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
 *  - `requests: 1` is exact for every operation: one admitted envelope is one
 *    provider request, and Kaana reports that unit even when its price is zero.
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
      return { requests: 1, input_tokens: estimatedInputTokens, output_tokens: maxOutputTokens };
    case 'embeddings':
      return {
        requests: 1,
        input_tokens: estimatedInputTokens,
        embeddings: operation.embeddings,
      };
    case 'rerank':
      return { requests: 1, input_tokens: estimatedInputTokens };
    case 'speech':
      // `characters` alone. See the `speech` arm of `EdgeOperation` for why no
      // duration figure appears: a duration-priced route fails to quote and is
      // refused, which is the sound outcome.
      return { requests: 1, characters: operation.characters };
    case 'images':
      return { requests: 1, input_tokens: estimatedInputTokens, images: operation.images };
  }
}

/**
 * Exact extreme partitions used to size a hold.
 *
 * A completion's prompt and generation budgets are each partitions, not four
 * independent budgets. Their maximum charge is therefore attained by putting
 * the whole prompt budget on either `input_tokens` or
 * `cached_input_tokens`, and the whole generation budget on either
 * `output_tokens` or `reasoning_tokens`. The Cartesian product below covers all
 * four extrema. Requiring every scenario to quote also proves all four unit
 * prices exist before execution.
 */
export function ceilingQuoteScenarios(
  operation: EdgeOperation,
  estimatedInputTokens: number,
  maxOutputTokens: number
): readonly Partial<Record<UsageUnit, number>>[] {
  if (operation.kind !== 'completion') {
    return [ceilingForOperation(operation, estimatedInputTokens, maxOutputTokens)];
  }
  return [
    { requests: 1, input_tokens: estimatedInputTokens, output_tokens: maxOutputTokens },
    { requests: 1, input_tokens: estimatedInputTokens, reasoning_tokens: maxOutputTokens },
    { requests: 1, cached_input_tokens: estimatedInputTokens, output_tokens: maxOutputTokens },
    { requests: 1, cached_input_tokens: estimatedInputTokens, reasoning_tokens: maxOutputTokens },
  ];
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
   * the edge observes a forwarded frame only after Kaana has received it from
   * the upstream provider, so the only honest source is Kaana's usage report.
   * Absent means unknown, which is what the NULL column says — see
   * {@link recordEdgeTelemetry}.
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
 *
 * ## Why it RETURNS the number it recorded
 *
 * {@link EdgeCompletion.latencyMs} reports the same figure to the customer, and
 * taking a second `performance.now()` at the point the completion is built would
 * make the response and the usage dashboard disagree by however long this write
 * took. One reading, reported twice. It is returned even when the write below
 * fails, because a failed telemetry insert makes the measurement unstored, not
 * untrue — and the response is already owed an answer.
 */
async function recordEdgeTelemetry(
  context: EdgeExecutionContext,
  input: EdgeTelemetryInput
): Promise<number> {
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

  return latencyMs;
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
