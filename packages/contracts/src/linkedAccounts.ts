/**
 * Wire contract for Oxy linked accounts — external accounts (any Mastodon-API
 * server, Bluesky) a LOCAL Oxy user has proven they own by completing an OAuth
 * authorization there.
 *
 * Every response schema is `.strict()` and carries no field a third-party token
 * could occupy: Oxy uses the OAuth flow only to learn which account authorized
 * it, then discards the token. See `docs/identity/linked-accounts.md`.
 *
 * Platform-agnostic — zod only, no react/react-native/expo.
 */

import { z } from 'zod';

export const LINKED_ACCOUNT_NETWORKS = ['activitypub', 'atproto'] as const;

export type LinkedAccountNetwork = (typeof LINKED_ACCOUNT_NETWORKS)[number];

export const linkedAccountNetworkSchema = z.enum(LINKED_ACCOUNT_NETWORKS);

/**
 * `POST /linked-accounts/:network/start`.
 *
 * - `instance` (activitypub): `mastodon.social`, `https://mastodon.social` or
 *   `@user@mastodon.social`.
 * - `handle` (atproto): a handle (`alice.bsky.social`) or a DID.
 * - `returnTo` + `clientId`: where the browser lands afterwards, with
 *   `?link_code=` or `?link_error=`. `returnTo` must exactly match a redirect
 *   URI registered on the TRUSTED (first-party) application `clientId` names.
 */
export const startLinkedAccountRequestSchema = z
  .object({
    instance: z.string().trim().min(1).max(320).optional(),
    handle: z.string().trim().min(1).max(320).optional(),
    clientId: z.string().trim().min(1).max(256),
    returnTo: z.string().trim().min(1).max(2048),
  })
  .strict();

export type StartLinkedAccountRequest = z.infer<typeof startLinkedAccountRequestSchema>;

export const startLinkedAccountResponseSchema = z
  .object({
    authorizeUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type StartLinkedAccountResponse = z.infer<typeof startLinkedAccountResponseSchema>;

/**
 * `POST /linked-accounts/complete`, with the session of the user who STARTED
 * the flow: `code` is the one-time `link_code` the callback appended to
 * `returnTo`. It expires five minutes after the callback. Presented by any
 * other user it is refused (403) and burned.
 */
export const completeLinkedAccountRequestSchema = z
  .object({ code: z.string().trim().min(1).max(256) })
  .strict();

export type CompleteLinkedAccountRequest = z.infer<typeof completeLinkedAccountRequestSchema>;

/** One live linked account, as its owner sees it. */
export const linkedAccountSchema = z
  .object({
    id: z.string().min(1),
    network: linkedAccountNetworkSchema,
    /** `username@domain` for ActivityPub; the DID for atproto. */
    accountKey: z.string().min(1),
    /** ActivityPub actor id, or the DID for atproto. */
    actorUri: z.string().min(1),
    handle: z.string().min(1),
    host: z.string().min(1),
    proofMethod: z.literal('oauth'),
    verifiedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type LinkedAccount = z.infer<typeof linkedAccountSchema>;

export const completeLinkedAccountResponseSchema = z
  .object({ linkedAccount: linkedAccountSchema })
  .strict();

export type CompleteLinkedAccountResponse = z.infer<typeof completeLinkedAccountResponseSchema>;

export const linkedAccountListResponseSchema = z
  .object({ linkedAccounts: z.array(linkedAccountSchema) })
  .strict();

export type LinkedAccountListResponse = z.infer<typeof linkedAccountListResponseSchema>;

/**
 * `GET /linked-accounts/by-user/:userId` (service token with the privileged
 * `linked-accounts:read`). Adds `federatedUserId`: the FEDERATED shadow user Oxy
 * already holds for that external account, if any — the anchor for adopting
 * content Oxy federated in before the account was linked.
 */
export const serviceLinkedAccountSchema = linkedAccountSchema
  .extend({ federatedUserId: z.string().min(1).nullable() })
  .strict();

export type ServiceLinkedAccount = z.infer<typeof serviceLinkedAccountSchema>;

export const serviceLinkedAccountListResponseSchema = z
  .object({ userId: z.string().min(1), linkedAccounts: z.array(serviceLinkedAccountSchema) })
  .strict();

export type ServiceLinkedAccountListResponse = z.infer<typeof serviceLinkedAccountListResponseSchema>;

/**
 * Error codes the callback appends as `?link_error=<code>` to `returnTo`. An
 * account already linked to someone else is reported by `/complete` (409).
 */
export const LINKED_ACCOUNT_CALLBACK_ERRORS = [
  'access_denied',
  'verification_failed',
  'provider_unavailable',
] as const;

export type LinkedAccountCallbackError = (typeof LINKED_ACCOUNT_CALLBACK_ERRORS)[number];

/**
 * Why `POST /linked-accounts/:network/start` refused, as `details.reason` on
 * its 400 (`{ error: 'BAD_REQUEST', message, details: { reason } }`). The
 * message is for logs; show the user a text chosen from the reason.
 *
 * - `instance_invalid`: the ActivityPub `instance` is not a server name.
 * - `instance_unreachable`: the server does not resolve to a public address, or
 *   could not be connected to.
 * - `handle_unresolvable`: the atproto handle or DID does not resolve to an
 *   account. The only reason that means "check what you typed".
 * - `provider_rejected`: the other network answered and refused Oxy's
 *   request — for atproto an authorization-server error such as
 *   `invalid_client_metadata`; for a Mastodon-API server a refused app
 *   registration (often: not a Mastodon-compatible server). Nothing the user
 *   typed is wrong.
 * - `provider_unavailable`: the other network could not be asked right now
 *   (its OAuth metadata did not load, a 5xx, a timeout). Try again later.
 *
 * A refusal with no `details.reason` (a bad `returnTo`, a missing field) is a
 * client bug, not something to show.
 */
export const LINKED_ACCOUNT_START_ERROR_REASONS = [
  'instance_invalid',
  'instance_unreachable',
  'handle_unresolvable',
  'provider_rejected',
  'provider_unavailable',
] as const;

export type LinkedAccountStartErrorReason = (typeof LINKED_ACCOUNT_START_ERROR_REASONS)[number];

export const linkedAccountStartErrorReasonSchema = z.enum(LINKED_ACCOUNT_START_ERROR_REASONS);

/** The `details` of a start refusal. */
export const linkedAccountStartErrorDetailsSchema = z
  .object({ reason: linkedAccountStartErrorReasonSchema })
  .strict();

export type LinkedAccountStartErrorDetails = z.infer<typeof linkedAccountStartErrorDetailsSchema>;

