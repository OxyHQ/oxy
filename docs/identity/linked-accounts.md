# Linked accounts

A local Oxy user can prove they own an account on another network and have Oxy
record it. Two networks are supported:

- **ActivityPub**, through any server that speaks the Mastodon API: Mastodon,
  GoToSocial, Pleroma, Akkoma, on any instance.
- **atproto** (Bluesky), through atproto OAuth.

The link is identity, so Oxy owns it. Importing content from the linked account
is the job of Oxy Move, which reads the link through a service route.

Code: `packages/api/src/routes/linkedAccounts.ts`,
`packages/api/src/services/linkedAccounts/`, and
`packages/api/src/db/schema/userLinkedAccounts.ts`. Wire types are in
`@oxy.so/contracts` (`linkedAccounts.ts`). The SDK is `oxy.linkedAccounts`
in `@oxy.so/core` (`forUser` is on `OxyServer`).

## Oxy keeps no third-party token

OAuth is used only to prove ownership. The flow exchanges the code, asks the
network which account authorized it, and then discards the token:

- **Mastodon API.** `GET /api/v1/accounts/verify_credentials` names the account.
  The instance's own WebFinger gives the ActivityPub actor. Oxy then calls
  `POST /oauth/revoke` and drops the token.
- **atproto.** `@atproto/oauth-client-node` checks that the token's `sub` DID is
  served by the authorization server that issued it. Oxy then signs the session
  out, which revokes the token. The library's session store is an in-memory map,
  emptied before the callback returns.

No column on any linked-accounts table can hold a token, encrypted or otherwise,
and a schema test checks this. This is the same rule as
`inference_provider_connections`: secrets that belong to someone else never reach
Oxy's database.

Oxy asks for the smallest scope each network offers: `read:accounts` on the
Mastodon API and `atproto` on Bluesky. Oxy Move imports public data (outboxes,
public XRPC) and needs no token. A server in authorized-fetch mode is read with
a signature from Oxy's instance actor; see [instance-fetch.md](instance-fetch.md).

Three secrets are stored, and each is registered in `protectedColumns.ts`:

| Column | What it is | Lifetime |
|---|---|---|
| `linked_account_oauth_challenges.pkce_verifier` | PKCE verifier of a Mastodon flow | Wiped when the challenge is spent. The row lives at most 10 minutes. |
| `linked_account_oauth_challenges.provider_state` | The atproto library's per-flow state: its verifier and an ephemeral DPoP key | Same as above |
| `mastodon_app_registrations.client_secret` | Oxy's own OAuth client secret at one instance (`POST /api/v1/apps`) | Kept. It is not a user secret. |

## One live claim per external account

`user_linked_accounts` has a partial unique index on
`(network, account_key) WHERE revoked_at IS NULL`. Only one Oxy user can hold a
live claim on an external account. This matters because the claim becomes that
user's `alsoKnownAs`, and a Mastodon `Move` trusts it: if two local accounts
announced the same alias, either one could receive the other's followers.

- If a second user claims an account that is already linked,
  `POST /linked-accounts/complete` answers 409.
- If the same user links the same account again, the existing link is refreshed.
- Revoking a link (`DELETE /linked-accounts/:id`) sets `revoked_at` and frees the
  account for someone else.

`account_key` is how the network names the account:

- **Mastodon API:** `username@domain`, lower-cased. The domain is the
  instance's own host, unless its WebFinger subject names another public
  domain AND that domain's WebFinger resolves the address to the same actor
  (a split-domain server).
- **atproto:** the DID.

`actor_uri` is the ActivityPub actor id, and it must be on the instance that
authenticated the user: an instance vouches only for its own accounts, so a
hostile server cannot name someone else's actor. For atproto it is the DID
again.

**The external-identity registry is only read, never written.** In
`external_identities`, `user_id` is the FEDERATED shadow user that Oxy creates
when it discovers a remote account. A linked account's `user_id` is the local
person who proved they own it. They are different people-records on purpose.
The service route reports the shadow user as `federatedUserId`, so an importer
can adopt content Oxy already federated in. Merging the two is the job of a
verified ActivityPub `Move`.

## Flows

All routes are under `/linked-accounts`.

1. **`POST /:network/start`** requires a user session and takes
   `{ instance? | handle?, clientId, returnTo }`. It returns
   `{ authorizeUrl, expiresAt }`.
   - `instance` accepts `mastodon.social`, `https://mastodon.social` or
     `@user@mastodon.social`. The start is refused (400) before any request is
     sent to the server if the value is an IP literal, has a port or
     credentials, or names a server that resolves to a private address. All
     outbound requests use `safeFetch`.
   - `returnTo` and `clientId` are required. `returnTo` must exactly match a
     redirect URI registered on that application (`isAllowedRedirectUri`), and
     the application must be trusted (first-party, staff-controlled; see
     below). Only a bare `https://host/` is treated as its origin, so Oxy Move
     registers `https://move.oxy.so/linked` and `oxymove://linked` explicitly.
   - A challenge row is created: the SHA-256 of `state`, the PKCE material, the
     user, and `returnTo`. It expires after 10 minutes, and `db/expiry.ts` sweeps
     it.
   - A refusal the user can act on is a 400 whose `details.reason` names why
     (`LINKED_ACCOUNT_START_ERROR_REASONS` in contracts), so an app shows the
     right text instead of blaming the input:

     | `reason` | When | Log |
     |---|---|---|
     | `instance_invalid` | `instance` is not a server name | — |
     | `instance_unreachable` | it resolves to a private address, or no connection could be made | warn (transport) |
     | `handle_unresolvable` | the atproto handle or DID does not resolve. Oxy resolves the identity with the library's own resolver BEFORE `authorize`, so this is the only reason that means "check what you typed" | info |
     | `provider_rejected` | the other network answered and refused Oxy: an atproto `OAuthResponseError` with a 4xx (`invalid_client_metadata`…), or a Mastodon-API server refusing the app registration (often: not Mastodon-API) | warn |
     | `provider_unavailable` | the other network could not be asked: an atproto `OAuthResolverError` (PDS or authorization-server metadata), a 5xx, a timeout; a Mastodon-API 5xx or 429 | warn |

     A refusal the client caused (a bad `returnTo`, a missing field) has no
     `reason`.
2. The browser opens `authorizeUrl` and signs in at the other network.
3. **`GET /:network/callback`** needs no session: the spent challenge row
   authenticates the request. The challenge is spent in one transaction
   (unspent, unexpired, secrets wiped), so a replayed or late callback gets a
   400 page and is never redirected. The code is exchanged, the account is
   verified, and the token is revoked, but **nothing is linked yet**. The row
   becomes `verified`: it stores the verified account and the SHA-256 of a
   one-time code, and now expires in five minutes. The browser is sent to
   `returnTo?link_code=<code>`, or to `returnTo?link_error=<code>` where
   `<code>` is `access_denied`, `verification_failed` or
   `provider_unavailable`. The parameter is `link_error`, not `error`:
   `@oxy.so/services` strips `?error=` from the address bar when a web app
   starts, because that is where Oxy's own sign-in reports failures, so an
   `error` parameter would be gone before the app could read it.
4. **`POST /complete`** takes `{ code }` with a user session and returns
   `{ linkedAccount }`. The session user must be the one who started the flow.
   Anyone else gets 403 and the code is burned (`refused`), so it links nobody,
   not even its starter. The starter's completion records the link (409 if the
   account is someone else's live link). Repeating it within the five minutes
   returns the same link. An unknown, expired or burned code is 404.
5. **`GET /`** lists the user's live links. **`DELETE /:id`** revokes one.
6. **`GET /by-user/:userId`** is for first-party services. It needs a service
   token whose application holds the privileged `linked-accounts:read` scope
   (staff-granted; the Oxy Move seed carries it). It returns the live links,
   each with `federatedUserId`.
7. **`GET /atproto/client-metadata.json`** is public. Its URL is Oxy's atproto
   `client_id`. Oxy is a public client (`token_endpoint_auth_method: none`,
   DPoP-bound tokens), so there is no long-lived client key to look after. When
   `OXY_API_URL` is `http://localhost`, atproto's loopback client form is used
   instead.

Start and complete share a per-user rate limiter (`rl:linked-accounts:start:`);
the callback has its own (`rl:linked-accounts:callback:`).

### Why the app completes the link, not the callback

The callback has no Oxy session: the browser arrives from the other network. If
it recorded the link, the account would be bound to whoever STARTED the flow,
not to whoever APPROVED it. An attacker could start a flow, send the
`authorizeUrl` to a victim, and — if the victim approved at their own
instance — own a link to the victim's account: the victim's actor published as
the attacker's `alsoKnownAs`, and the victim's public content importable into
the attacker's account. This is login CSRF applied to account linking.

Splitting verify from link closes it. The one-time code is delivered only to
`returnTo`, in the browser of whoever approved, and only the starter's session
can redeem it. In the attack, the victim's app completes with the victim's
session: 403, and the code is burned. The attacker never sees the code, as long
as `returnTo` is an app the attacker does not control. That is why `returnTo`
must belong to a TRUSTED application: a self-registered app could name the
attacker's own URL, receive the victim's code, and complete it as the starter.

## Aliases (`alsoKnownAs`)

There is no alias table. A user's ActivityPub `alsoKnownAs` is the `actor_uri`
of each of their live `activitypub` links, oldest first (`aliasesForUser`).
atproto links are never aliases, because atproto has no `alsoKnownAs` that a
Mastodon `Move` reads.

It is published in three places:

- **Oxy's own actor** (`/ap/users/:username`, `buildActor`). The
  `alsoKnownAs` term (`as:alsoKnownAs`, typed `@id`) is added to `@context` only
  when there is an alias.
- **`GET /profiles/username/:username`** includes `alsoKnownAs: string[]`.
- **`@oxy.so/federation`.** `createLocalActorBuilder` accepts `alsoKnownAs` and
  emits it only when it is non-empty (https URIs only, de-duplicated).
  `AP_CONTEXT` declares the term. The engine's actor route and `Update`
  rebroadcast pass `user.alsoKnownAs` through from the resolved profile. A
  relying app such as Mention only has to upgrade `@oxy.so/federation` and
  `@oxy.so/core`, because its profile lookup already calls the endpoint above.

When a link is added or revoked, Oxy calls `userCache.invalidate(userId)`. That
publishes the `profile` invalidation on `oxy:user:invalidate`. Oxy has no
outbound delivery for oxy.so actors, so remote servers see the change the next
time they fetch the actor. Pushing an `Update(Person)` for mention.earth actors
is Mention's job: it should raise its `actor.update` event when it receives that
invalidation.

## Inbound `Move`

A linked ActivityPub account can then move its followers to the Oxy account:

1. The remote user sets `alsoKnownAs` on the remote side and triggers "Move
   account" there. Their server sends `Move { actor: old, object: old, target:
   new }` to the followers' inboxes.
2. `@oxy.so/federation`'s inbound dispatcher checks the shape: `actor` and
   `object` must both be the signing actor, and `target` must be https. It
   then calls the app's `onMove({ activityId, oldActorUri, targetActorUri })`.
3. The app (Mention) relays it to **`POST /federation/move`** with the same
   three fields and a `federation:write` service token.
4. Oxy decides (`services/federationMove.service.ts`):
   - `target` must be `https://<host>/ap/users/<username>` of a LOCAL account,
     on Oxy's domain or a host the caller is registered for. Otherwise 400, or
     404 when no such account exists.
   - That account must have a live ActivityPub link whose
     `actor_uri` is the old actor. Otherwise 422 `alias_missing`.
   - A fresh fetch of the old actor (signed and SSRF-safe, never cached) must
     name the target in `movedTo`. Otherwise 422 `moved_to_mismatch`, or 502
     when the actor cannot be fetched.
5. If all three hold, one transaction:
   - writes the `federated_account_moves` audit row, unique on `activityId`, so
     a replay returns `replayed: true` and the first result;
   - copies blocks and restrictions that other users hold against the old
     account onto the target (`mergeUsers`' Move-only path);
   - creates the `canonical_user_redirects` row old → target;
   - moves local followers with `followCommand.moveAccountFollowers`. A block
     between the follower and the target, in either direction, skips that
     follower. Old edges are removed. Follow events are recorded with cause
     `migration`;
   - marks the `external_identity_claims` row `linked`.
6. After commit, Oxy invalidates the graph caches and publishes the `profile`
   invalidation for both accounts on `oxy:user:invalidate`.

The response carries `oldUserId`, `targetUserId` and the counts
(`followersMoved`, `alreadyFollowing`, `skippedBlocked`).
