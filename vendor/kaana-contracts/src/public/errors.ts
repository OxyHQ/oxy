/**
 * Errors of the public API.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/errors.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import { requestIdSchema } from './identifiers.js';

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
 * Distinct from the upstream's OWN code and text, which only the signed
 * Oxy↔Kaana lane carries (`providerErrorPassthroughSchema` in `/internal`): this
 * is the platform's reading of what kind of failure it
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

export type UpstreamErrorCategory = z.infer<typeof upstreamErrorCategorySchema>;

/* -------------------------------------------------------------------------- */
/*  The public vocabulary (Kaana ADR 0002, decision 10)                        */
/* -------------------------------------------------------------------------- */

/**
 * The error codes a public client of `https://kaana.ai/v1` can receive.
 *
 * The internal vocabulary (`INFERENCE_ERROR_CODES` in `@kaana.ai/contracts/internal`)
 * minus the three codes that describe Kaana's OWN relationship with a provider:
 * `provider_credential_invalid`, `provider_billing_refused` and
 * `deployment_unavailable`. On `/v1` Kaana retires that key or route and moves
 * on; when nothing is left the client is told `service_unavailable` (retryable)
 * or `no_route_available`, never which provider, key or deployment failed.
 *
 * `byok_credential_invalid` stays: it is the customer's own key, and only the
 * customer can replace it. The provider-NEUTRAL upstream codes
 * (`provider_error`, `provider_timeout`, `provider_overloaded`) stay too: they
 * say what kind of failure happened, not who failed.
 */
export const PUBLIC_ERROR_CODES = [
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
  'provider_error',
  'provider_timeout',
  'provider_overloaded',
  'service_unavailable',
  'internal_error',
] as const;

export const publicErrorCodeSchema = z.enum(PUBLIC_ERROR_CODES);

/** Public codes for which an identical retried request cannot succeed. */
export const NON_RETRYABLE_PUBLIC_ERROR_CODES = [
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
] as const satisfies readonly (typeof PUBLIC_ERROR_CODES)[number][];

const NON_RETRYABLE_PUBLIC_CODE_SET: ReadonlySet<string> = new Set(
  NON_RETRYABLE_PUBLIC_ERROR_CODES,
);

/**
 * The HTTP status each public code is answered with when it is decided before
 * the first byte. After the first byte every failure is the terminal `error`
 * event of the stream, and the status that was already sent stands.
 *
 * `cancelled` is 499, nginx's spelling for a client that went away.
 */
export const PUBLIC_ERROR_HTTP_STATUS = {
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
  cancelled: 499,
  rate_limited: 429,
  provider_error: 502,
  provider_timeout: 504,
  provider_overloaded: 503,
  service_unavailable: 503,
  internal_error: 500,
} as const satisfies Readonly<Record<(typeof PUBLIC_ERROR_CODES)[number], number>>;

/**
 * The error body every `/v1` surface returns and every public stream's
 * terminal `error` event carries.
 *
 * The internal error shape without its provider passthrough: a public error
 * names what went wrong and whether to retry, never who served the request.
 * Accounts, keys and balances are managed in Oxy Console
 * (`https://console.oxy.so`), which an `authentication_failed` or balance
 * message links to.
 */
export const publicErrorSchema = z
  .object({
    /** A whole message on the wire, so it is versioned. */
    schemaVersion: z.literal(1),
    code: publicErrorCodeSchema,
    message: safeErrorTextSchema,
    retryable: z.boolean(),
    requestId: requestIdSchema,
    /** How long to wait before retrying. Only meaningful when `retryable`. */
    retryAfterMs: z.number().int().nonnegative().safe().optional(),
    /** The request field at fault, for `invalid_request`. */
    param: z.string().max(128).optional(),
    /** The kind of upstream failure, when an upstream was reached. Provider-neutral. */
    upstreamCategory: upstreamErrorCategorySchema.optional(),
  })
  .strict()
  .superRefine((error, ctx) => {
    if (error.retryable && NON_RETRYABLE_PUBLIC_CODE_SET.has(error.code)) {
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

export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;
