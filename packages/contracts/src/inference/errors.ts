/**
 * Inference errors and retryability.
 *
 * One closed set of codes, shared by the Oxy public edge, the data plane and
 * every SDK.
 * Closed because the alternative — a free-form `code` string — makes a client's
 * error handling a guess about the producer's spelling, and makes "is this
 * worth retrying" a decision every consumer re-derives from prose.
 *
 * Retryability is carried explicitly and is CONSTRAINED by the code: a code
 * that can never succeed on a bare retry (an invalid request, a denied
 * permission, an insufficient balance) cannot claim `retryable: true`. Without
 * that constraint the field is advisory, and one producer setting it optimistically
 * turns every client into a retry storm against a request that will never pass.
 *
 * The provider passthrough exists so a customer can see what the upstream said
 * without Oxy having to interpret every provider's error vocabulary — but it is
 * the single most likely place for an upstream credential to escape, because
 * provider errors routinely echo the request that caused them. It is therefore
 * a `.strict()` object of four fields with no room for headers or a request
 * body, and its free text is refused if it looks like it contains a credential.
 *
 * Decided in: docs/adr/0010-public-api-compatibility.md.
 */

import { z } from 'zod';
import { inferenceProviderSlugSchema, requestIdSchema } from './identifiers';

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
] as const;

const NON_RETRYABLE_CODE_SET: ReadonlySet<string> = new Set(NON_RETRYABLE_INFERENCE_ERROR_CODES);

/**
 * Text that looks like it carries a credential.
 *
 * A deliberately narrow set of literal markers — the shapes upstream providers
 * actually echo — rather than an entropy heuristic, which would reject
 * legitimate error text (a request id, a base64 image fragment) and teach
 * producers to strip messages until they pass.
 */
const CREDENTIAL_LIKE_TEXT =
  /(?:bearer\s+[a-z0-9._~+/=-]{8,}|authorization\s*[:=]|api[_-]?key\s*[:=]|\bsk-[a-z0-9_-]{8,}|\bsk_(?:live|test)_[a-z0-9]{8,})/i;

/**
 * Free text that is safe to hand a customer: bounded, and refused outright if a
 * credential marker appears in it. Applied to BOTH the Oxy message and the
 * upstream one — a leak is no less a leak for having been written by a provider.
 */
export const safeErrorTextSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) => !CREDENTIAL_LIKE_TEXT.test(value),
    'error text must not contain credential-shaped material',
  );

/**
 * A coarse classification of an upstream failure (ADR 0010's `upstreamCategory`).
 *
 * Distinct from {@link providerErrorPassthroughSchema}, which carries the
 * upstream's OWN code and text: this is Oxy's reading of what kind of failure it
 * was, in a vocabulary that is the same across every provider, so a client can
 * branch on it without knowing who served the request.
 */
export const upstreamErrorCategorySchema = z.enum([
  'rate_limit',
  'quota',
  'timeout',
  'overloaded',
  'server_error',
  'content_filter',
  'invalid_request',
  'authentication',
  'unknown',
]);

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
        code: z.ZodIssueCode.custom,
        path: ['retryable'],
        message: `${error.code} can never succeed on an identical retry, so it cannot be retryable`,
      });
    }

    if (error.retryAfterMs !== undefined && !error.retryable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryAfterMs'],
        message: 'retryAfterMs tells a client when to retry, so it requires retryable: true',
      });
    }
  });

export type InferenceErrorCode = z.infer<typeof inferenceErrorCodeSchema>;
export type UpstreamErrorCategory = z.infer<typeof upstreamErrorCategorySchema>;
export type ProviderErrorPassthrough = z.infer<typeof providerErrorPassthroughSchema>;
export type InferenceError = z.infer<typeof inferenceErrorSchema>;
