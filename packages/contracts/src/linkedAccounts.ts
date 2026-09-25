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
 * - `returnTo` + `clientId`: where the browser lands afterwards. `returnTo` must
 *   exactly match a redirect URI registered on the application `clientId`
 *   names; omitted, the callback renders a minimal "account linked" page.
 */
export const startLinkedAccountRequestSchema = z
  .object({
    instance: z.string().trim().min(1).max(320).optional(),
    handle: z.string().trim().min(1).max(320).optional(),
    clientId: z.string().trim().min(1).max(256).optional(),
    returnTo: z.string().trim().min(1).max(2048).optional(),
  })
  .strict()
  .refine((value) => value.returnTo === undefined || value.clientId !== undefined, {
    message: 'returnTo requires clientId',
    path: ['clientId'],
  });

export type StartLinkedAccountRequest = z.infer<typeof startLinkedAccountRequestSchema>;

export const startLinkedAccountResponseSchema = z
  .object({
    authorizeUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type StartLinkedAccountResponse = z.infer<typeof startLinkedAccountResponseSchema>;

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
    useAsAlias: z.boolean(),
    verifiedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type LinkedAccount = z.infer<typeof linkedAccountSchema>;

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

/** Error codes the callback appends as `?error=<code>` to `returnTo`. */
export const LINKED_ACCOUNT_CALLBACK_ERRORS = [
  'access_denied',
  'already_linked',
  'verification_failed',
  'provider_unavailable',
] as const;

export type LinkedAccountCallbackError = (typeof LINKED_ACCOUNT_CALLBACK_ERRORS)[number];
