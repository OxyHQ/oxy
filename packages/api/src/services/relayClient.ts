/**
 * The Oxy → inference data plane boundary (issue #972 workstream 4, ADR 0006 and
 * ADR 0010).
 *
 * ## THERE IS NO PRODUCTION IMPLEMENTATION OF THIS INTERFACE, AND THAT IS THE
 * ## HONEST STATE OF THE PLATFORM
 *
 * The data plane (working name Relay, ADR 0011) does not exist: no repository,
 * no deployment, no endpoint. So this module declares the SHAPE of the call the
 * edge makes and nothing else. `createInferenceEdgeRouter()` is constructed with
 * no client, every invoke resolves to {@link DataPlaneNotConfiguredError}, and
 * the edge answers a typed `service_unavailable` — it never falls through to the
 * Alia proxy and never pretends to serve.
 *
 * A fake implementation belongs in a test and nowhere else. An
 * "in-process default" here would be a data plane in everything but name, and
 * the first thing it would have to invent is a usage report — i.e. the numbers a
 * customer is billed from.
 *
 * ## What crosses the boundary
 *
 * Exactly one shape in each direction, both from `@oxyhq/contracts`:
 *
 *  - out: {@link InferenceRequest}, the versioned internal envelope. Both public
 *    dialects normalize into it, which is what keeps the OpenAI-compatible
 *    surface from becoming a second data path.
 *  - back: {@link RelayCompletion}, whose `usage` is a
 *    {@link NormalizedUsageReport} — units and a route, never money. The data
 *    plane measures; the control plane prices. A cost quoted by the data plane
 *    would be a second, unauthoritative answer to a question the ledger already
 *    owns.
 *
 * ## Streaming is deliberately absent from this interface
 *
 * `stream: true` is refused at the edge with a typed `invalid_request` (see
 * `services/inferenceEdge.service.ts`). Declaring a streaming arm here that
 * nothing can produce, and writing the SSE rendering for both public dialects
 * against no implementation to check it, would be exactly the elaborate
 * untestable machinery the epic's edge-behaviour section warns off. The
 * cancellation half IS wired, because it is one parameter: `execute` takes an
 * `AbortSignal` derived from the client's own connection, so a disconnect
 * propagates the moment there is anything to propagate it to.
 */

import type {
  InferenceFinishReason,
  InferenceMessage,
  InferenceRequest,
  NormalizedUsageReport,
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

/** Options every call carries. */
export interface RelayExecuteOptions {
  /**
   * Aborted when the client disconnects. The data plane is expected to
   * propagate the cancellation upstream and to report the request as
   * `cancelled`, which is a settlement case (ADR 0009) rather than a discarded
   * one.
   */
  readonly signal: AbortSignal;
}

/**
 * The one call the edge makes into the data plane.
 *
 * A single method rather than a client object with routing, health and
 * catalogue methods: routing execution and provider health are the data plane's
 * to own (ADR 0006), and every one of those would be a second place a routing
 * constraint could be dropped.
 */
export interface RelayClient {
  execute(envelope: InferenceRequest, options: RelayExecuteOptions): Promise<RelayCompletion>;
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
