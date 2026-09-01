/**
 * Canonical contract for the "Sign in with Oxy" approval handoff.
 *
 * SINGLE SOURCE OF TRUTH for the closed set of reasons an approver may attach
 * when it DENIES a pending request via
 * `POST /auth/session/deny/:authorizeCode`.
 *
 * That endpoint is UNAUTHENTICATED — the public `authorizeCode` is the only
 * credential — so a free-form string from it is never stored: it would be an
 * unauthenticated write of arbitrary text onto a record other surfaces read.
 * The set is therefore deliberately tiny, and closed:
 *
 *  - `'declined'` the approver rejected a request they recognised ("Not now").
 *  - `'not_me'`   the approver did not start the request ("This wasn't me").
 *                 The ONE value that records the denial as suspicious rather
 *                 than an ordinary cancel, so a UI may only offer it where the
 *                 user genuinely said so.
 *
 * Why this lives in `@oxyhq/contracts` rather than in either consumer: the same
 * closed set is enforced in three places — the request schema of the API route,
 * the `enum` of the persisted `AuthSession.deniedReason` field, and the client
 * SDK's `denyCommonsSignIn` parameter. Two hand-maintained copies of a wire
 * contract drift the moment a value is added on one side only, and the failure
 * lands at runtime, in an auth path, as a generic validation error. One
 * declaration makes that impossible.
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';

/**
 * The closed set, as a value — consumed directly where a runtime list is
 * required (e.g. the Mongoose `enum` of `AuthSession.deniedReason`, which is
 * the storage-level guarantee that an unauthenticated caller can never write
 * free-form text into the field).
 */
export const COMMONS_DENY_REASONS = ['declined', 'not_me'] as const;

/**
 * The same set as a zod enum — the edge validator. Anything outside it
 * (including free-form text) is rejected with 400 before any handler runs.
 */
export const commonsDenyReasonSchema = z.enum(COMMONS_DENY_REASONS);

/** Why the approver denied a "Sign in with Oxy" request. */
export type CommonsDenyReason = z.infer<typeof commonsDenyReasonSchema>;
