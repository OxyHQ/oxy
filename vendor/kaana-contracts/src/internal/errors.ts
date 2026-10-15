/**
 * The complete error vocabulary Oxy and Kaana exchange, including the codes
 * that name a provider-side failure and never reach a public client.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/errors.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import {
  type PublicError,
  type PublicErrorCode,
  publicErrorSchema,
  safeErrorTextSchema,
  upstreamErrorCategorySchema,
} from '../public/errors.js';
import { requestIdSchema } from '../public/identifiers.js';
import { inferenceProviderSlugSchema } from './identifiers.js';

/**
 * The closed set of inference error codes.
 *
 * Grouped by who must act: the caller (`invalid_request` … `idempotency_conflict`),
 * the account owner (`insufficient_balance`, `spending_limit_exceeded`,
 * `quota_exceeded`, `byok_credential_invalid`), routing/permission policy
 * (`policy_violation`, `commercial_permission_denied`, `no_route_available`),
 * and the platform or its upstreams (everything from `deployment_unavailable`).
 *
 * The platform group is NOT uniformly retryable, and that is the point of
 * `provider_credential_invalid` sitting in it: an upstream that refuses the
 * PLATFORM's own credential fails every identical retry until an operator
 * rotates a key, so classifying it as `provider_error` would send every client
 * into a retry loop against a request that cannot succeed.
 *
 * `provider_billing_refused` is in that group for the same reason and was found
 * the same way — an upstream declining to bill OXY (Anthropic answers 402) has
 * to be distinguishable from the customer's own balance running out, or the
 * error tells them to go and top up an account that is not the one at fault.
 */
export const INFERENCE_ERROR_CODES = [
  'invalid_request',
  'authentication_failed',
  'permission_denied',
  'insufficient_scope',
  'model_not_found',
  'unsupported_modality',
  'context_length_exceeded',
  'request_too_large',
  'output_limit_exceeded',
  'idempotency_conflict',
  'insufficient_balance',
  'spending_limit_exceeded',
  'quota_exceeded',
  'byok_credential_invalid',
  'policy_violation',
  'commercial_permission_denied',
  'no_route_available',
  'upstream_content_filtered',
  'cancelled',
  'rate_limited',
  'deployment_unavailable',
  'provider_error',
  'provider_timeout',
  'provider_overloaded',
  'provider_credential_invalid',
  'provider_billing_refused',
  'service_unavailable',
  'internal_error',
] as const;

export const inferenceErrorCodeSchema = z.enum(INFERENCE_ERROR_CODES);

/**
 * Codes for which an identical retried request cannot succeed.
 *
 * `rate_limited` and `quota_exceeded` sit on opposite sides of this line
 * deliberately: a rate limit clears on its own within the window the response
 * names, while a quota is an account-level ceiling that only a human raises.
 * `cancelled` is here because the caller already withdrew the request; a client
 * that retries it is contradicting its own cancellation.
 *
 * `byok_credential_invalid` and `provider_credential_invalid` are the same
 * failure seen from the two sides of the BYOK boundary — the customer's own
 * upstream credential and the platform's — and they are two codes rather than
 * one because only the first names an action the customer can take. Both are
 * non-retryable for the same reason: a credential an upstream has refused keeps
 * being refused until somebody replaces it.
 *
 * `quota_exceeded` and `provider_billing_refused` divide along the same line:
 * both are money, but one is the CUSTOMER's ceiling and the other is Oxy's
 * account with an upstream. Reporting the second as the first is retryability-
 * correct and diagnostically wrong, which is the worst combination — it reads
 * as actionable and the action does nothing.
 */
export const NON_RETRYABLE_INFERENCE_ERROR_CODES = [
  'invalid_request',
  'authentication_failed',
  'permission_denied',
  'insufficient_scope',
  'model_not_found',
  'unsupported_modality',
  'context_length_exceeded',
  'request_too_large',
  'output_limit_exceeded',
  'idempotency_conflict',
  'insufficient_balance',
  'spending_limit_exceeded',
  'quota_exceeded',
  'byok_credential_invalid',
  'policy_violation',
  'commercial_permission_denied',
  'no_route_available',
  'upstream_content_filtered',
  'cancelled',
  'provider_credential_invalid',
  'provider_billing_refused',
] as const;

const NON_RETRYABLE_CODE_SET: ReadonlySet<string> = new Set(NON_RETRYABLE_INFERENCE_ERROR_CODES);

/**
 * What the upstream provider said, reduced to the four fields a customer can
 * act on.
 *
 * `.strict()` is the security control here, not a tidiness preference: it means
 * a producer cannot widen this by attaching `requestHeaders`, `curl`, `body` or
 * `raw` and have it silently pass. Adding a field is a contract change with a
 * version bump and a review, which is the point.
 */
export const providerErrorPassthroughSchema = z
  .object({
    provider: inferenceProviderSlugSchema,
    /** The upstream HTTP status, when the upstream spoke HTTP. */
    status: z.number().int().min(100).max(599).optional(),
    /** The upstream's own error code, verbatim and uninterpreted. */
    code: z.string().max(128).optional(),
    /** The upstream's message, subject to the same credential refusal. */
    message: safeErrorTextSchema.optional(),
  })
  .strict();

/**
 * The error body every inference surface returns and every stream error event
 * carries.
 *
 * `requestId` is always present — an error a customer cannot correlate with a
 * log line is an error they have to reproduce to report.
 */
export const inferenceErrorSchema = z
  .object({
    /** See `version.ts`: this shape appears alone on the wire, so it is versioned. */
    schemaVersion: z.literal(1),
    code: inferenceErrorCodeSchema,
    message: safeErrorTextSchema,
    retryable: z.boolean(),
    requestId: requestIdSchema,
    /** How long to wait before retrying. Only meaningful when `retryable`. */
    retryAfterMs: z.number().int().nonnegative().safe().optional(),
    /** The request field at fault, for `invalid_request`. */
    param: z.string().max(128).optional(),
    /** Present only when an upstream provider was reached and failed. */
    upstreamCategory: upstreamErrorCategorySchema.optional(),
    providerError: providerErrorPassthroughSchema.optional(),
  })
  .superRefine((error, ctx) => {
    if (error.retryable && NON_RETRYABLE_CODE_SET.has(error.code)) {
      ctx.addIssue({
        code: 'custom',
        path: ['retryable'],
        message: `${error.code} can never succeed on an identical retry, so it cannot be retryable`,
      });
    }

    if (error.retryAfterMs !== undefined && !error.retryable) {
      ctx.addIssue({
        code: 'custom',
        path: ['retryAfterMs'],
        message: 'retryAfterMs tells a client when to retry, so it requires retryable: true',
      });
    }
  });

export type InferenceErrorCode = z.infer<typeof inferenceErrorCodeSchema>;
export type ProviderErrorPassthrough = z.infer<typeof providerErrorPassthroughSchema>;
export type InferenceError = z.infer<typeof inferenceErrorSchema>;

/* -------------------------------------------------------------------------- */
/*  Projection onto the public vocabulary (Kaana ADR 0002, decision 10)        */
/* -------------------------------------------------------------------------- */

/**
 * The internal codes that never reach a public client, and what the client is
 * told instead. Each names Kaana's own relationship with a provider (a key the
 * provider refused, an account it will not bill, a deployment that is down);
 * on `/v1` Kaana retires that key or route and moves on, and when nothing is
 * left the request is `service_unavailable`, which a later retry can pass once
 * capacity returns.
 */
export const INTERNAL_ONLY_ERROR_CODES = {
  provider_credential_invalid: 'service_unavailable',
  provider_billing_refused: 'service_unavailable',
  deployment_unavailable: 'service_unavailable',
} as const satisfies Partial<Record<InferenceErrorCode, PublicErrorCode>>;

/** The message a public client reads for a code it is never shown. */
const UNAVAILABLE_MESSAGE = 'The model is temporarily unavailable. Retry later.';

/** The public code an internal code is reported as. */
export function toPublicErrorCode(code: InferenceErrorCode): PublicErrorCode {
  return code in INTERNAL_ONLY_ERROR_CODES
    ? INTERNAL_ONLY_ERROR_CODES[code as keyof typeof INTERNAL_ONLY_ERROR_CODES]
    : (code as PublicErrorCode);
}

/**
 * An internal error as a public client may see it: the provider passthrough is
 * dropped, and an internal-only code becomes `service_unavailable` with a
 * message and category that say nothing about which provider, key or
 * deployment failed. The result is parsed, so a projection that would publish
 * an invalid body throws here rather than reaching a client.
 */
export function toPublicError(error: InferenceError): PublicError {
  if (error.code in INTERNAL_ONLY_ERROR_CODES) {
    return publicErrorSchema.parse({
      schemaVersion: 1,
      code: toPublicErrorCode(error.code),
      message: UNAVAILABLE_MESSAGE,
      retryable: true,
      requestId: error.requestId,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    });
  }
  const { providerError: _providerError, ...rest } = error;
  return publicErrorSchema.parse({ ...rest, code: toPublicErrorCode(error.code) });
}
