# 0021 — A relying service reads file bytes only where the file's OWNER linked it

- Status: accepted
- Scope: `packages/api` asset surface, `@oxy.so/core` asset client, the
  application scope vocabulary
- Asked by: Mercaria #1015 (digital commerce), which needs a buyer to download a
  file Oxy stores and Mercaria sold

## Context

Every file in the ecosystem lives in Oxy's file manager, and every relying app
was expected to reach one of two ways: through the CDN, for a `public` file, or
through a route that resolves a URL **for the current user** —
`GET /assets/:id/url`, `POST /assets/batch-access`, and in the SDK
`getFileDownloadUrlAsync` / `getBatchFileAccess`. Both ask the same question:
*may this VIEWER read this file?*, answered by `canUserAccessFile` against Oxy's
own ACL.

Mercaria's digital commerce cannot ask that question. The file is a private
deliverable — a mesh, a source archive — uploaded by a seller, and the person
downloading it is a BUYER who has no relationship to it in Oxy at all. Oxy's ACL
is right to refuse them. The fact that authorizes the download is a row in
Mercaria's own database (`asset_rights`), and Oxy neither holds it nor should.

So the answer belongs to Mercaria, and Mercaria needs the bytes. Three routes
out were available and each was measured before being rejected:

1. **A user-scoped URL on the buyer's behalf.** It requires a buyer session, and
   a relying service holding a service token has none. `acting-as:offline` names
   a user but never makes that user the authority the ACL reads.
2. **A media token** (`signMediaToken`, `?mt=`). Measured and refused on a fact,
   not a preference: `verifyMediaToken` returns a `uid`, and the stream route
   re-runs `canUserAccessFile` with it. A media token names a VIEWER. A buyer is
   not one, so the token would be minted and then refused.
3. **Mercaria keeps its own bucket.** It answers the question completely and
   costs the thing the platform exists for: two storage systems, two dedup
   domains, two deletion stories, and every other app that later sells a file
   arriving at the same fork.

## Decision

**Oxy serves bytes to a service when, and only when, the FILE'S OWN OWNER
attached that file to that application.**

One route, `POST /assets/service/linked-url`, gated by one new scope,
`files:linked:read`, returning a short-lived presigned download URL per id.

### The predicate, and why it is the narrow one

`file_links` records `created_by`; `files` records `owner_user_id`. A file is
admitted only when some link for the calling app satisfies
`created_by = owner_user_id`.

The weaker spelling — "a link for my app exists" — was considered and is an
**escalation**, not a simplification. `assetService.linkFile` performs no
ownership check: any authenticated user may link any file id they can name into
any app. Under a bare link test, an attacker with any account turns this route
into *read any file whose id you can guess*. The conjunction is not
attacker-supplied: `created_by` is always `req.user._id` at the one route that
writes a link, so satisfying it requires the owner's own credentials.

System-owned files (the federation namespaces, `owner_user_id is null`) can never
satisfy it, because `created_by` is `NOT NULL`. That is the right answer rather
than an edge case: nobody consented to a federation cache entry leaving the
platform, and there is no owner who could.

### The scope is NOT a widening of `files:read`

`files:read` is metadata-only — its route's own documentation says so in those
words, and it returns a content hash, mime, size and status, never bytes and
never a URL. Spelling byte access as a flavour of it would have handed that
authority to every application already holding the smaller one, silently. The two
are independent; an app needing both asks for both.

### It is not privileged, and not consent-required

Not privileged, because the authority is bounded to the subject user's own
content under that user's own explicit act — `podcasts:write`'s shape exactly,
not a cross-tenant one.

Not consent-required, and this is the one absence worth arguing. That set has
teeth only on the OAuth authorize lane, which this scope never meets: the route
reads it off a service token, with no user in the request. And a screen naming it
could only ask *"may this app read files you link to it?"* — one standing answer
covering every file, forever. The decision already being taken is per FILE, and
revocable one at a time by unlinking. A blanket screen would be strictly coarser
than the control the user already has.

### Consequences taken deliberately

- **A refused id is OMITTED, never distinguished.** The route answers identically
  for "no such file" and "not yours", so it leaks nothing about files the caller
  has no business knowing exist. The cost is real and lands on the caller: a
  relying service must decide what to tell its user from its OWN entitlement
  record, never from this response. The SDK says so, and throws rather than
  returning a short list when a request fails — reading a 429 as absence tells a
  buyer who paid that their file is gone.
- **The URL is bearer authority with no further check.** Hence 300 seconds, a
  dedicated rate limiter at a fifth of the metadata lookups' ceiling, a batch cap
  of 25 rather than 100, and no logging of the URL or the storage key. The
  deadline bounds when a transfer may START; a resumed range request after it
  fails, which is why the relying app's own grant is redeemable more than once
  instead of this window being wide.
- **Oxy learns nothing about why.** It does not store, and must not be given, the
  entitlement that motivated the call. The division is the point: Oxy answers
  *did this file's owner attach it here*, the relying app answers *may this
  person have it*, and neither can be derived from the other.

## Related

- `packages/api/src/routes/assets.ts` — the route and `isOwnerLinkedToApp`
- `packages/api/src/utils/applicationScopes.ts` — the scope and its two
  classifications
- `packages/api/src/routes/__tests__/assetsServiceLinkedUrl.test.ts` — every
  weaker predicate refused by its own case, each paired with an authorized id
- Mercaria ADR 0010 (digital commerce) — the entitlement half of this split
