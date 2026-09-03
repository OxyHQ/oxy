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

/* -------------------------------------------------------------------------- */
/*  Credential-shaped text                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A run of characters long enough and opaque enough to BE a credential.
 *
 * The alphabet every bearer token, API key and base64/base64url secret is
 * written in. The LENGTH floors below are what keep this from being an entropy
 * heuristic: nothing here fires on a short word, so `authorization: none` and
 * `api_key=***` read as what they are.
 */
const OPAQUE_ALPHABET = '[A-Za-z0-9][A-Za-z0-9._~+/=-]';

/**
 * Words a producer substitutes FOR a credential.
 *
 * Excluded at the value position so a message whose secret has already been
 * replaced is accepted. That acceptance is deliberate and is half the fix for
 * issue #1027: the previous pattern refused `Authorization: [redacted]` — a
 * correctly redacted string — which is precisely what pushed a producer into
 * redacting the MARKER instead, and a marker-redacted string carries the secret
 * and passes.
 */
const PLACEHOLDER_WORDS =
  'redacted|removed|hidden|masked|scrubbed|elided|omitted|filtered|sanitized|sanitised|none|null|undefined|empty';

/** A value position whose contents are a placeholder rather than a secret. */
const NOT_A_PLACEHOLDER = `(?!(?:${PLACEHOLDER_WORDS})\\b)`;

/**
 * Header and parameter names that carry a credential, as any provider spells
 * them.
 *
 * The prefix group is the whole point of the rewrite: `authorization` and
 * `api_key` were matched literally, so `x-api-key`, `anthropic-api-key`,
 * `x-goog-api-key` and `proxy-authorization` — the spellings an upstream
 * actually echoes — went unrecognised.
 */
const CREDENTIAL_NAME =
  '(?:[a-z0-9]{1,20}[-_]){0,3}(?:api[-_]?(?:key|token|secret)|authorization|auth[-_]?(?:token|key)?|access[-_]?token|id[-_]?token|refresh[-_]?token|bearer[-_]?token|secret[-_]?key|private[-_]?key|client[-_]?secret|session[-_]?(?:id|key|token)|passwords?|passwd|cookie|credentials?|tokens?|secrets?)';

/** An auth scheme sitting between the marker and the value. */
const AUTH_SCHEME = '(?:(?:bearer|basic|token|apikey|digest)\\s+)?';

/**
 * The four ways a credential is recognisable in free text.
 *
 * Each is checked independently, so removing one signal does not clear the
 * string — which is the failure #1027 reported. All four are load-bearing:
 * `inference.errors.test.ts` has a case that only one of them catches, and
 * deleting any one entry turns a test red.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // 1. A credential-bearing name ASSIGNED a value that is long enough to be a
  //    credential. The value is anchored to the separator so a placeholder at
  //    that position ends the match rather than being skipped over.
  new RegExp(
    `(?:^|[^a-z0-9])${CREDENTIAL_NAME}["']?\\s*[:=]\\s*["']?${AUTH_SCHEME}${NOT_A_PLACEHOLDER}${OPAQUE_ALPHABET}{7,}`,
    'i',
  ),

  // 2. A bearer token with no marker in front of it, which is how an upstream
  //    quotes the header value alone.
  new RegExp(`\\bbearer\\s+${NOT_A_PLACEHOLDER}${OPAQUE_ALPHABET}{7,}`, 'i'),

  // 3. Token grammars that ARE credentials wherever they appear, marker or not.
  //    This is the layer that survives a producer stripping the marker, and it
  //    is a closed list of issued shapes rather than an entropy score, so a
  //    request id or a base64 image fragment is unaffected.
  //
  //    Case-SENSITIVE on purpose: `AKIA`, `AIza` and `gh[pousr]_` are issued in
  //    exactly that case, and matching them case-insensitively would start
  //    firing on ordinary words.
  /\b(?:sk-[A-Za-z0-9_-]{8,}|[sprk]k_(?:live|test)_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,})/,

  // 4. A redaction placeholder standing NEXT TO a surviving opaque value — the
  //    exact residue of the span redaction in #1027 (`{x-[redacted] <key>}`).
  //    A correct redaction puts the placeholder WHERE the value was, so the two
  //    never appear side by side; a marker-span redaction leaves them adjacent.
  //    Both signals are required, which is what keeps an ordinary redacted
  //    message from being refused.
  new RegExp(
    `(?:[[<({]\\s*(?:${PLACEHOLDER_WORDS})[^\\])}>]{0,16}[\\])}>]|\\*{3,})[^A-Za-z0-9]{0,4}${OPAQUE_ALPHABET}{11,}`,
    'i',
  ),
];

/**
 * Free text that is safe to hand a customer: bounded, and refused if it still
 * looks like it carries a credential. Applied to BOTH the Oxy message and the
 * upstream one — a leak is no less a leak for having been written by a provider.
 *
 * ## This is a last-resort REFUSAL, not protection
 *
 * A pattern over the OUTPUT cannot be the control that keeps a credential out of
 * an error, and a producer that treats it as one has the hole #1027 reported.
 * The only reliable control is redacting the KNOWN SECRET VALUE at the point
 * where the producer still holds the bytes it sent — which is an adapter's job
 * and is available to nobody else. This refinement exists to catch what that
 * control missed, and nothing here is a licence to skip it.
 *
 * Two rules follow, and they are the whole reason this text is longer than the
 * pattern it describes:
 *
 *  - **Never redact by replacing the span this pattern matched.** The span is
 *    the MARKER; the secret is what follows it. OxyHQ/Kaana#3 measured the
 *    result: `{x-api-key: <key>}` is refused, `{x-[redacted] <key>}` was
 *    accepted, and both carry the key. Redaction made the leak worse by
 *    converting "this string is dangerous" into "this string is fine".
 *  - **This package deliberately ships no redaction helper.** One keyed on these
 *    patterns would rebuild the same defect one layer up, and one that took the
 *    secret as an argument would only restate what the producer already has.
 *
 * What it still cannot see, stated so nobody relies on it: a credential with no
 * marker, no issued-token prefix and no placeholder beside it is bytes that look
 * like a request id, and refusing those means refusing request ids.
 */
export const safeErrorTextSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) => !CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)),
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
