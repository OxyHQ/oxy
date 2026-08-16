/**
 * One structured error shape for the inference edge, mapped to each public
 * surface's idiom at the boundary (ADR 0010).
 *
 * Three rules the ADR fixes, implemented here rather than restated at each
 * call site:
 *
 *  1. **`retryable` is asserted by the producer, never inferred from the HTTP
 *     status.** {@link RETRYABILITY} is a total map over the closed code set, so
 *     a new code cannot be added without somebody answering the question; the
 *     contract's own refinement then refuses the combinations that make no sense.
 *  2. **`requestId` appears on EVERY error**, including edge rejections that
 *     never reached the data plane. That is what makes a customer's report
 *     actionable without a reproduction.
 *  3. **Provider error text is not passed through verbatim** where it could
 *     carry upstream account or credential detail. `safeErrorTextSchema` refuses
 *     credential-shaped material outright, and {@link buildInferenceError}
 *     replaces a refused message rather than dropping the error.
 *
 * The status map is a total `Record` over `INFERENCE_ERROR_CODES` for the same
 * reason: a `switch` with a `default` silently gives a new code whatever the
 * default says, and the default that reads most naturally — 500 — would report
 * a customer's mistake as an Oxy outage.
 */

import type { Response } from 'express';
import {
  INFERENCE_CONTRACT_VERSION,
  inferenceErrorSchema,
  NON_RETRYABLE_INFERENCE_ERROR_CODES,
  safeErrorTextSchema,
  type InferenceError,
  type InferenceErrorCode,
} from '@oxyhq/contracts';

/** The header every response carries, success or failure. */
export const REQUEST_ID_HEADER = 'X-Oxy-Request-Id';

/** The contract version this edge speaks, so a client can detect a skew. */
export const CONTRACT_VERSION_HEADER = 'X-Oxy-Inference-Contract-Version';

const NON_RETRYABLE: ReadonlySet<string> = new Set(NON_RETRYABLE_INFERENCE_ERROR_CODES);

/**
 * Whether an IDENTICAL retry could succeed, per code.
 *
 * Every code the contract marks non-retryable is `false` here by construction —
 * asserting otherwise fails the parse. The remaining ones are decided
 * individually: `internal_error` is `false` because an unclassified failure is
 * not retryable by ADR 0010's own rule, while the four provider/capacity codes
 * are the cases a retry genuinely resolves.
 */
const RETRYABILITY: Readonly<Record<InferenceErrorCode, boolean>> = {
  invalid_request: false,
  authentication_failed: false,
  permission_denied: false,
  insufficient_scope: false,
  model_not_found: false,
  unsupported_modality: false,
  context_length_exceeded: false,
  request_too_large: false,
  output_limit_exceeded: false,
  idempotency_conflict: false,
  insufficient_balance: false,
  spending_limit_exceeded: false,
  quota_exceeded: false,
  byok_credential_invalid: false,
  policy_violation: false,
  commercial_permission_denied: false,
  no_route_available: false,
  upstream_content_filtered: false,
  cancelled: false,
  rate_limited: true,
  deployment_unavailable: true,
  provider_error: true,
  provider_timeout: true,
  provider_overloaded: true,
  // An upstream refusing the PLATFORM's own credential is the platform's to
  // fix, and no retry reaches the operator who has to rotate the key.
  provider_credential_invalid: false,
  // A data plane that is not configured is the platform's to fix, not the
  // client's to wait out — see `services/relayClient.ts`. `false` here is why
  // the no-data-plane refusal does not teach every SDK to retry forever.
  service_unavailable: false,
  internal_error: false,
};

/**
 * HTTP status per code.
 *
 * `402` for both money refusals: the customer's next action is to fund or raise
 * a limit, and every SDK already treats 402 as "not a bug, pay". `503` for
 * `no_route_available` rather than 404 — the MODEL exists (a model that does not
 * answers `model_not_found`), so this is a serving-side answer.
 */
const HTTP_STATUS: Readonly<Record<InferenceErrorCode, number>> = {
  invalid_request: 400,
  authentication_failed: 401,
  permission_denied: 403,
  insufficient_scope: 403,
  model_not_found: 404,
  unsupported_modality: 400,
  context_length_exceeded: 400,
  request_too_large: 413,
  output_limit_exceeded: 400,
  idempotency_conflict: 409,
  insufficient_balance: 402,
  spending_limit_exceeded: 402,
  quota_exceeded: 429,
  byok_credential_invalid: 400,
  policy_violation: 403,
  commercial_permission_denied: 403,
  no_route_available: 503,
  upstream_content_filtered: 400,
  // The client withdrew the request; 499 is nginx's spelling and the one every
  // log pipeline in this stack already understands.
  cancelled: 499,
  rate_limited: 429,
  deployment_unavailable: 503,
  provider_error: 502,
  provider_timeout: 504,
  provider_overloaded: 503,
  // 502 like `provider_error`: the failure is at the gateway to the upstream.
  // What separates them is `retryable`, which ADR 0010 makes the producer's
  // assertion precisely so a status code does not have to carry it.
  provider_credential_invalid: 502,
  service_unavailable: 503,
  internal_error: 500,
};

/** OpenAI's coarse error `type`, for the compatibility surface only. */
const OPENAI_ERROR_TYPE: Readonly<Record<InferenceErrorCode, string>> = {
  invalid_request: 'invalid_request_error',
  authentication_failed: 'authentication_error',
  permission_denied: 'permission_error',
  insufficient_scope: 'permission_error',
  model_not_found: 'invalid_request_error',
  unsupported_modality: 'invalid_request_error',
  context_length_exceeded: 'invalid_request_error',
  request_too_large: 'invalid_request_error',
  output_limit_exceeded: 'invalid_request_error',
  idempotency_conflict: 'invalid_request_error',
  insufficient_balance: 'insufficient_quota',
  spending_limit_exceeded: 'insufficient_quota',
  quota_exceeded: 'insufficient_quota',
  byok_credential_invalid: 'invalid_request_error',
  policy_violation: 'permission_error',
  commercial_permission_denied: 'permission_error',
  no_route_available: 'api_error',
  upstream_content_filtered: 'invalid_request_error',
  cancelled: 'api_error',
  rate_limited: 'rate_limit_error',
  deployment_unavailable: 'api_error',
  provider_error: 'api_error',
  provider_timeout: 'api_error',
  provider_overloaded: 'api_error',
  provider_credential_invalid: 'api_error',
  service_unavailable: 'api_error',
  internal_error: 'api_error',
};

/** The text substituted when a message is refused as credential-shaped. */
const REDACTED_MESSAGE = 'The request failed. Details were withheld from this message.';

export interface BuildInferenceErrorInput {
  readonly code: InferenceErrorCode;
  readonly message: string;
  readonly requestId: string;
  /** The request field at fault. Only meaningful for `invalid_request`. */
  readonly param?: string;
  readonly retryAfterMs?: number;
}

/**
 * Build the one error body every inference surface returns.
 *
 * Retryability is looked up, never passed in: a caller that could choose it
 * would eventually choose optimistically, and an optimistic `retryable` on a
 * request that can never pass is a retry storm.
 *
 * A message the contract refuses is REPLACED rather than allowed to fail the
 * parse. Losing an error's text is a degraded answer; throwing while building an
 * error body turns a handled refusal into a 500 with no `requestId` at all.
 */
export function buildInferenceError(input: BuildInferenceErrorInput): InferenceError {
  const retryable = RETRYABILITY[input.code];
  const message = safeErrorTextSchema.safeParse(input.message).success
    ? input.message
    : REDACTED_MESSAGE;

  return inferenceErrorSchema.parse({
    schemaVersion: 1,
    code: input.code,
    message,
    retryable,
    requestId: input.requestId,
    ...(input.param === undefined ? {} : { param: input.param }),
    ...(retryable && input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  });
}

/** True when an identical retry of `code` could succeed. */
export function isRetryableInferenceCode(code: InferenceErrorCode): boolean {
  return RETRYABILITY[code] && !NON_RETRYABLE.has(code);
}

/** The HTTP status an inference error is returned with. */
export function inferenceErrorStatus(code: InferenceErrorCode): number {
  return HTTP_STATUS[code];
}

/**
 * Headers every inference-edge response carries — the normalized vocabulary a
 * client reads without knowing which provider served it.
 */
export function applyInferenceHeaders(res: Response, requestId: string): void {
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader(CONTRACT_VERSION_HEADER, INFERENCE_CONTRACT_VERSION);
}

/**
 * Send a structured error on an Oxy-native surface (`/v1/responses`,
 * `/v1/generations/:id`).
 *
 * The body IS the contract shape, at the top level rather than inside the
 * platform's `{ error, message }` envelope. That envelope carries no
 * retryability and no request id, and both are load-bearing here: a client that
 * has to infer "should I retry" from a status code is exactly what ADR 0010's
 * retryability rule exists to prevent.
 */
export function sendInferenceError(res: Response, error: InferenceError): void {
  applyInferenceHeaders(res, error.requestId);
  if (error.retryAfterMs !== undefined) {
    res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
  }
  res.status(inferenceErrorStatus(error.code)).json(error);
}

/**
 * Send the same error in the OpenAI idiom, for `/v1/chat/completions`.
 *
 * The body stays exactly what a stock client parses — `{ error: { message,
 * type, param, code } }` — and everything Oxy-specific rides in headers, which
 * is the rule that keeps the compatibility surface compatible.
 */
export function sendOpenAiError(res: Response, error: InferenceError): void {
  applyInferenceHeaders(res, error.requestId);
  if (error.retryAfterMs !== undefined) {
    res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
  }
  res.setHeader('X-Oxy-Error-Code', error.code);
  res.setHeader('X-Oxy-Error-Retryable', String(error.retryable));
  res.status(inferenceErrorStatus(error.code)).json({
    error: {
      message: error.message,
      type: OPENAI_ERROR_TYPE[error.code],
      param: error.param ?? null,
      code: error.code,
    },
  });
}
