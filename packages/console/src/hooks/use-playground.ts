import { mutationOptions, useMutation } from '@tanstack/react-query';
import type { InferenceError, InferenceMessage } from '@oxyhq/contracts';
import config from '@/lib/config';

// ===========================================================================
// The playground's two calls to the public inference edge (issue #972,
// workstream 4), and the one thing that makes them different from every other
// hook in this Console.
//
// **These do NOT go through `oxyServices.makeRequest`.** That client attaches
// the signed-in user's device-first session bearer, and the edge does not accept
// one: it authenticates an `oxy_sk_…` machine credential or a verified service
// token and nothing else (ADR 0010). A session bearer is not a principal of this
// lane at all, so sending it would produce a refusal that looked like a bug. The
// call is a bare `fetch` carrying the credential the user supplied, and the
// session bearer appears nowhere in it.
//
// **The credential is handled the way the BYOK section already established for a
// customer secret** (`use-provider-connections.ts`): read out of component
// state, handed straight to the request, and never a query key, never a cached
// value, never a URL parameter, never logged. `retry: false` is part of that —
// it is what stops a refused call from re-sending a secret three more times over
// the following seconds.
//
// Both are `useMutation`, including the receipt read, which is a GET. A run is
// not idempotent from a cache's point of view, and a cached receipt read would
// need the credential in its query key — which is exactly what must not happen.
// ===========================================================================

/**
 * The body `POST /v1/responses` returns.
 *
 * Declared here because there is no shared contract for this response shape:
 * `routes/inferenceEdge.ts` builds the object inline and `@oxyhq/contracts`
 * carries the REQUEST vocabulary and the error, but not this envelope. The
 * fields it does own — `InferenceMessage`, `InferenceError` — are imported rather
 * than restated, so the half that is contracted cannot drift.
 *
 * `latencyMs` is OPTIONAL here for one reason and not the other: the field is
 * additive, so a Console build newer than the API deployment it is talking to
 * reads `undefined` and must render the run without it rather than showing
 * `NaN ms`. It is NOT optional because the number is unreliable — every served
 * `POST /v1/responses` sets it. See {@link PlaygroundRun.roundTripMs}, which is a
 * DIFFERENT number, is measured somewhere else, and is labelled as such.
 */
interface EdgeResponseBody {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly generationId?: string;
  /** Always revision-pinned: `<publisher>/<model>@<revision>`. */
  readonly model: string;
  readonly servingProvider: string;
  readonly finishReason: string;
  readonly output: ReadonlyArray<InferenceMessage>;
  readonly usage: ReadonlyArray<{ readonly unit: string; readonly quantity: number }>;
  readonly routingPolicy: {
    readonly routingPolicyId: string;
    readonly policyVersion: number;
  };
  /**
   * Oxy's own handling time, in whole milliseconds — the server's answer to
   * "how long did this take", as distinct from the browser's.
   *
   * The edge starts this clock when it receives the request, before
   * authentication, and stops it after the hold is settled, so it covers
   * authentication, admission, routing, the reservation, the call to the
   * inference data plane and the settlement. Most of that is the UPSTREAM
   * generating tokens; the server does not claim otherwise and neither does this
   * screen. What it contains no part of is the network between here and Oxy,
   * which is the whole reason it is rendered beside
   * {@link PlaygroundRun.roundTripMs} instead of replacing it.
   */
  readonly latencyMs?: number;
}

/** A completed run, plus the one measurement the client can honestly make. */
export interface PlaygroundRun extends EdgeResponseBody {
  /**
   * Wall-clock time from just before the `fetch` to just after the body was
   * read, measured in the BROWSER.
   *
   * This is NOT {@link EdgeResponseBody.latencyMs}. That figure is measured from
   * the monotonic clock at admission and covers authentication, admission, the
   * upstream call and the settlement, and it contains no network at all; this one
   * additionally covers DNS, TLS, the network in both directions and JSON
   * parsing, and it is the only number that describes what the person pressing
   * Run actually waited for.
   *
   * The two are rendered side by side and labelled, never collapsed. Showing only
   * the server's would hide the wait the user experienced; showing only this one
   * would attribute the network to the model; subtracting them would invent a
   * third figure neither side measured.
   */
  readonly roundTripMs: number;
}

/**
 * What a run resolves to.
 *
 * A refusal RESOLVES rather than throwing, mirroring the server's own
 * `EdgeExecution`: every refusal the edge produces is a structured
 * `InferenceError` carrying a request id and a retryability flag, and both are
 * things the user needs to see. Throwing would push them into an `unknown` error
 * and lose the request id, which is the one string that makes a refusal
 * reportable. A transport failure — no network, DNS, CORS — still throws, because
 * there is no server answer to report.
 */
export type PlaygroundResult =
  | { readonly status: 'completed'; readonly run: PlaygroundRun }
  | { readonly status: 'refused'; readonly error: InferenceError };

export interface PlaygroundRunInput {
  /**
   * An `oxy_sk_…` machine credential, held in the caller's component state for
   * this browser session only.
   */
  readonly apiKey: string;
  /** `<publisher>/<model>` or `<publisher>/<model>@<revision>`. */
  readonly model: string;
  readonly input: string;
}

/** True when a body looks like the edge's structured error rather than a result. */
function isInferenceError(body: unknown): body is InferenceError {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const candidate = body as Partial<InferenceError>;
  return typeof candidate.code === 'string' && typeof candidate.requestId === 'string';
}

/**
 * `POST /v1/responses` with a machine credential.
 *
 * The preferred endpoint rather than the OpenAI-compatible one, because its BODY
 * carries the request id, the resolved model revision, the serving provider, the
 * routing policy and the metered units. On the compat surface all of those live
 * only in `X-Oxy-*` headers, and a browser can read a response header only if
 * `Access-Control-Expose-Headers` names it — so reading them there is a CORS
 * question, while reading them here is not.
 *
 * Exported as OPTIONS rather than only as a hook so the request this builds is
 * testable as itself. What must be asserted about it is a NEGATIVE — that the
 * signed-in user's session bearer is not on it — and a test that had to render a
 * component to see the request would be measuring React as much as the request.
 */
export const playgroundRunOptions = mutationOptions({
  mutationKey: ['playground-run'],
  retry: false,
  mutationFn: async ({ apiKey, model, input }: PlaygroundRunInput): Promise<PlaygroundResult> => {
    const startedAt = performance.now();
    const response = await fetch(`${config.oxyUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      // No `credentials: 'include'`. The edge takes the credential from the
      // Authorization header and nothing else; sending ambient credentials
      // would put this call back on the session lane ADR 0010 removed.
      body: JSON.stringify({ model, input }),
    });
    const roundTripMs = performance.now() - startedAt;

    const body: unknown = await response.json();

    if (!response.ok) {
      if (isInferenceError(body)) {
        return { status: 'refused', error: body };
      }
      // A non-OK response that is not the contract's error shape did not come
      // from the edge — a proxy or a gateway. Reported as itself rather than
      // dressed up as an inference refusal it cannot describe.
      throw new Error(`The inference edge returned HTTP ${response.status}.`);
    }

    return { status: 'completed', run: { ...(body as EdgeResponseBody), roundTripMs } };
  },
});

export function usePlaygroundRun() {
  return useMutation(playgroundRunOptions);
}

/**
 * The usage and cost receipt for one request.
 *
 * Fields taken from `generationReceiptSchema`, the shape
 * `GET /v1/generations/:id` actually parses its output with. Reduced to what this
 * screen renders — the full receipt also carries the application id, the
 * credential id and a delegated user id, none of which tell the person who just
 * pressed Run anything they did not already know.
 */
export interface PlaygroundReceipt {
  readonly receiptId: string;
  readonly requestId: string;
  readonly environment: 'development' | 'staging' | 'production';
  readonly outcome: 'completed' | 'partial' | 'cancelled' | 'failed';
  readonly usageSource: 'provider_reported' | 'oxy_measured' | 'estimated';
  readonly resolvedModelReference: string;
  readonly servingProvider: string;
  readonly billedAmount: string;
  readonly currency: string;
  /** A BYOK request: `billedAmount` is Oxy's fee, not the cost of the tokens. */
  readonly platformFeeOnly: boolean;
  readonly settledAt: string;
  readonly priceSnapshot: {
    readonly priceVersionId: string;
    readonly currency: string;
    readonly unitPrices: ReadonlyArray<{
      readonly unit: string;
      readonly amount: string;
      readonly per: number;
      readonly currency: string;
    }>;
  };
}

/**
 * What a receipt read resolves to.
 *
 * `unavailable` is a NORMAL outcome and must never render as an error. Three
 * different, entirely ordinary situations produce it, and the endpoint
 * deliberately cannot tell them apart:
 *
 *  1. **Shadow metering.** `INFERENCE_CHARGING_AUTHORIZED` is unset by default,
 *     and while it is, a request is admitted, routed, metered and priced but NO
 *     receipt is written at all. So "no receipt" is the expected answer for every
 *     run today.
 *  2. **The credential lacks `inference:usage:read`.** A key scoped only to
 *     `inference:invoke` cannot read receipts — by design, so this endpoint
 *     cannot be used to probe another application's spend.
 *  3. **The request belonged to another application.** Same answer as (2), also
 *     by design: the entitlement answer and the existence answer are identical.
 *
 * The refusal arrives as `model_not_found`, which is a documented compromise —
 * the closed error vocabulary has no generic "not found" and that is its only
 * 404. Rendering its message verbatim would tell the user their MODEL was not
 * found, which is both false and the most confusing thing this screen could say.
 */
export type PlaygroundReceiptResult =
  | { readonly status: 'found'; readonly receipt: PlaygroundReceipt }
  | { readonly status: 'unavailable' };

/**
 * `GET /v1/generations/:requestId`, with the same credential the run used.
 *
 * On demand rather than automatic: it is a second billed call against the
 * customer's own rate limit, and under shadow metering it can only ever answer
 * "no receipt". A button that the user presses when they want the number is
 * honest about that; a poll that quietly returned nothing would not be.
 */
export const playgroundReceiptOptions = mutationOptions({
  mutationKey: ['playground-receipt'],
  retry: false,
  mutationFn: async ({
    apiKey,
    requestId,
  }: {
    readonly apiKey: string;
    readonly requestId: string;
  }): Promise<PlaygroundReceiptResult> => {
    const response = await fetch(
      // Encoded rather than interpolated. The id is server-generated today, but
      // this is a URL path segment built from a value a component holds, and the
      // cheap version of that mistake is a `../` that addresses another route.
      `${config.oxyUrl}/v1/generations/${encodeURIComponent(requestId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );

    const body: unknown = await response.json();

    if (response.status === 404) {
      return { status: 'unavailable' };
    }

    if (!response.ok) {
      if (isInferenceError(body)) {
        throw new Error(body.message);
      }
      throw new Error(`The receipt could not be read (HTTP ${response.status}).`);
    }

    // The route wraps the receipt in `{ data }`, unlike `/v1/responses`.
    return {
      status: 'found',
      receipt: (body as { data: PlaygroundReceipt }).data,
    };
  },
});

export function usePlaygroundReceipt() {
  return useMutation(playgroundReceiptOptions);
}
