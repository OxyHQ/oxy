/**
 * The Oxy → inference data plane boundary (issue #972 workstream 4, ADR 0006,
 * ADR 0010, ADR 0015).
 *
 * This module declares the SHAPE of the call the edge makes.
 * `services/httpRelayClient.ts` is the production implementation of it.
 *
 * ## What is built, and what is configured, are two different facts
 *
 * The data plane EXISTS: `OxyHQ/Relay` is a public Go repository with a build, a
 * test suite and a CI contract-drift gate. **No deployment of it is configured
 * here**, and that — not the absence of an implementation — is why every invoke
 * still refuses today. A deployment that has not set the three variables in
 * `config/relayDataPlane.ts` has NO data plane: every invoke resolves to
 * {@link DataPlaneNotConfiguredError} and the edge answers a typed
 * `service_unavailable`. It never falls through to the Alia proxy and never
 * pretends to serve.
 *
 * The distinction matters because this header is what a reader consults to
 * understand a refusal. "Nothing is built" and "nothing is configured" have
 * different fixes — the first is a project, the second is three environment
 * variables and a public key handed to Relay.
 *
 * ## What crosses the boundary
 *
 * Out: exactly one shape, {@link InferenceRequest} — the versioned internal
 * envelope from `@oxyhq/contracts`. Both public dialects normalize into it, which
 * is what keeps the OpenAI-compatible surface from becoming a second data path.
 *
 * Back: units and events, never money.
 *
 *  - {@link RelayCompletion} for a non-streaming request, whose `usage` is a
 *    {@link NormalizedUsageReport}.
 *  - a sequence of {@link RelayStreamFrame} for a streaming one: the contract's
 *    own {@link InferenceStreamEvent}s as they are produced, plus the terminal
 *    usage report.
 *
 * The data plane measures; the control plane prices. A cost quoted by the data
 * plane would be a second, unauthoritative answer to a question the ledger
 * already owns, which is why neither shape has a field for one.
 *
 * ## Two methods, one wire path
 *
 * Relay's transport is an event stream in BOTH directions of the `stream` flag:
 * `POST /internal/v1/inference` answers `200` and an SSE body whatever the
 * envelope asked for, because a status code chosen from a failure would have to
 * be chosen before the stream that fails exists. So {@link RelayClient.execute}
 * is a FOLD over {@link RelayClient.stream} in the real client — one HTTP call,
 * one decoder, one signature — and the second method exists only because the two
 * callers want different things from the same bytes. Declaring one method and
 * folding at the edge would move that fold into the module that also owns
 * reservation and settlement, where it is the least testable.
 *
 * ## Every path out of a call must settle the hold
 *
 * The edge has RESERVED spend by the time it reaches either method. That is why
 * failure here is expressed as typed errors that CARRY what the settlement needs
 * — {@link RelayIncompleteError} holds the usage that did arrive, when any did —
 * rather than as a bare throw the caller can only answer with a full refund.
 */

import type {
  InferenceError,
  InferenceFinishReason,
  InferenceMessage,
  InferenceRequest,
  InferenceStreamEvent,
  NormalizedUsageReport,
  UsageQuantity,
  UsageSource,
} from '@oxyhq/contracts';

/** What the data plane returns for a completed, non-streaming request. */
export interface RelayCompletion {
  /**
   * The generation this request produced, when it produced one that can be
   * looked up later. Absent for a request that failed before generating.
   */
  readonly generationId?: string;
  /**
   * The assistant output, in the normalized message shape. An array because a
   * response may carry several outputs; each public dialect renders it in its
   * own idiom.
   */
  readonly output: readonly InferenceMessage[];
  readonly finishReason: InferenceFinishReason;
  /** Units and route. Never money — see the module header. */
  readonly usage: NormalizedUsageReport;
}

/**
 * One thing the data plane sent while streaming.
 *
 * Two members rather than one, because the two are not the same kind of message
 * and only one of them is the customer's. A `usage` frame is the technical
 * record settlement runs against and is never forwarded to a customer as an
 * event; an `event` frame is exactly what the contract says a stream carries.
 * Collapsing them would leave the edge discriminating on `type` against a union
 * that has no member for a usage report.
 */
export type RelayStreamFrame =
  | { readonly kind: 'event'; readonly event: InferenceStreamEvent }
  | { readonly kind: 'usage'; readonly usage: NormalizedUsageReport };

/**
 * Everything a settlement can be computed from, in the two forms the data plane
 * actually offers — and NOTHING synthesized to make them look alike.
 *
 * `report` is the terminal {@link NormalizedUsageReport}: authoritative, and the
 * only form that names an outcome, a route and a route-switch count.
 *
 * `partial` is what survives when that report never arrived — a client
 * disconnect makes its frame undeliverable — and it is the units of the last
 * in-stream `usage` event. That event carries units and a source and nothing
 * else, so it CANNOT be widened into a report: `resolvedModelReference`,
 * `outcome`, `startedAt` and `routeSwitches` would all have to be invented, and
 * an invented field on the record a charge is computed from is the failure this
 * whole boundary exists to prevent. The edge already knows the route it admitted
 * and whether the client cancelled, so it supplies those from its own knowledge
 * rather than being handed a guess.
 */
export type RelayUsageEvidence =
  | { readonly kind: 'report'; readonly report: NormalizedUsageReport }
  | {
      readonly kind: 'partial';
      readonly units: readonly UsageQuantity[];
      readonly usageSource: UsageSource;
    };

/** Options every call carries. */
export interface RelayExecuteOptions {
  /**
   * Aborted when the client disconnects. The data plane propagates the
   * cancellation to its upstream provider and reports the request as
   * `cancelled`, which is a settlement case (ADR 0009) rather than a discarded
   * one — a cancelled request still measured the units it consumed before the
   * cut, and those are what an exact refund is computed from.
   */
  readonly signal: AbortSignal;
}

/**
 * The two calls the edge makes into the data plane.
 *
 * No routing, health or catalogue methods: routing execution and provider health
 * are the data plane's to own (ADR 0006), and every one of those would be a
 * second place a routing constraint could be dropped.
 */
export interface RelayClient {
  execute(envelope: InferenceRequest, options: RelayExecuteOptions): Promise<RelayCompletion>;
  /**
   * The normalized events as they are produced, then the usage report.
   *
   * An async iterable rather than a callback so the caller's `for await` loop IS
   * the backpressure: nothing is buffered on this side, and abandoning the loop
   * runs the generator's own cleanup, which aborts the upstream hop.
   */
  stream(
    envelope: InferenceRequest,
    options: RelayExecuteOptions
  ): AsyncIterable<RelayStreamFrame>;
}

/**
 * Thrown — and caught by the edge — when no data plane is configured.
 *
 * A named error rather than a `null` check at the call site so the refusal has
 * one origin: the edge has already RESERVED spend by the time it reaches the
 * forward step, and every path out of that step has to release the hold. A
 * missing client that read as "skip the call" would leave a customer's money
 * held with nothing to settle it.
 */
export class DataPlaneNotConfiguredError extends Error {
  constructor() {
    super('No inference data plane is configured for this deployment.');
    this.name = 'DataPlaneNotConfiguredError';
  }
}

/**
 * The data plane refused the ENVELOPE, before executing anything.
 *
 * A `4xx` from `POST /internal/v1/inference` is never the customer's fault: the
 * only things Relay refuses at that layer are an unsigned or badly signed
 * envelope, an unrecognised `schemaVersion`, a body over its own limit, and an
 * envelope with no `attribution.requestId`. Every one of those is something Oxy
 * built or failed to sign, so surfacing Relay's own code to the customer would
 * tell them their API key is bad when it is Oxy's signing key that is.
 *
 * `status` and `upstreamCode` are for the log. Neither reaches a customer.
 */
export class RelayEnvelopeRejectedError extends Error {
  readonly status: number;
  readonly upstreamCode: string | undefined;

  constructor(status: number, upstreamCode: string | undefined) {
    super(`The inference data plane refused the envelope with HTTP ${status}.`);
    this.name = 'RelayEnvelopeRejectedError';
    this.status = status;
    this.upstreamCode = upstreamCode;
  }
}

/**
 * Why a non-streaming request produced no completion.
 *
 * Three arms rather than one message, because they are three different answers
 * to the customer and the edge must not guess which: a data plane that ended the
 * request deliberately, one that stopped talking, and one that finished but left
 * nothing to charge from.
 */
export type RelayIncompleteReason =
  /** The stream's terminal `error` event. `failure` carries it. */
  | 'terminal_error'
  /** The stream ended with no terminal event — the data plane or its upstream died. */
  | 'stream_truncated'
  /** It completed, and no usage report arrived, so nothing can be charged exactly. */
  | 'usage_missing';

/**
 * A non-streaming request that produced no completion, carrying whatever the
 * settlement can be computed from.
 *
 * One shape for all three of {@link RelayIncompleteReason}, because the edge
 * answers all three the same WAY — an error to the customer and a settlement of
 * exactly what was measured — while `reason` is what decides which error.
 *
 * `usage` is the evidence that did arrive. Absent means no usage measurement
 * exists for this request at all, and the edge then refunds the whole hold
 * against a receipt marked `estimated` — see `inferenceEdge.service.ts`, which
 * names the open policy question that behaviour stands in for.
 */
export class RelayIncompleteError extends Error {
  readonly reason: RelayIncompleteReason;
  /** The data plane's own terminal error, already validated. */
  readonly failure: InferenceError | undefined;
  /** Everything that can be settled exactly, when anything can. */
  readonly usage: RelayUsageEvidence | undefined;

  constructor(
    reason: RelayIncompleteReason,
    message: string,
    detail: {
      readonly failure?: InferenceError;
      readonly usage?: RelayUsageEvidence;
    } = {}
  ) {
    super(message);
    this.name = 'RelayIncompleteError';
    this.reason = reason;
    this.failure = detail.failure;
    this.usage = detail.usage;
  }
}

/**
 * The data plane sent something this build cannot read: a frame that is not
 * JSON, or a message the published schema rejects.
 *
 * Refused rather than skipped, and that is the contract's own versioning rule
 * rather than strictness for its own sake: a producer running ahead of its
 * consumer must fail at the parse instead of being silently reinterpreted. For a
 * usage report the stake is money — it is the input to a charge — and for a
 * stream event it is output a customer would otherwise never learn was dropped.
 */
export class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayProtocolError';
  }
}
