# Instance-fetch signing

Some ActivityPub servers run in **authorized fetch** ("secure mode"): they
answer an unsigned `GET` with 401 and serve public content only to a signer
whose key they can fetch and whose domain they have not blocked. Oxy Move reads
a user's Mastodon outbox and `following` collection to migrate them, and on such
a server it gets nothing unsigned.

Move must not hold a signing key, and it must not speak as any person. So Oxy's
**instance actor** signs the `GET` for it:

```
POST /federation/instance-fetch/sign     (service token, scope federation:instance-fetch)
{ "url": "https://mastodon.example/users/ada/outbox?page=true" }

→ { "keyId": "https://oxy.so/ap/users/instance#main-key",
    "headers": { "Host": "mastodon.example", "Date": "…", "Signature": "keyId=…" } }
```

The caller sends the three headers, unchanged, on its own `GET` of exactly that
URL. Oxy fetches nothing. A redirect is a new URL and needs a new signature.

Code: `packages/api/src/services/federation/instanceFetchSignature.ts` and the
route in `packages/api/src/routes/federation.ts`. Wire types:
`@oxy.so/contracts` (`federationInstanceFetch.ts`).

## Why the instance actor

`https://oxy.so/ap/users/instance` is Oxy's server-level `Application` actor
(`buildActor` with no username). It is the right signer for a server reading
public data on a user's behalf:

- **Oxy already signs its own reads with it** (`signedFetch` in
  `federation.service.ts`), so remote servers already know and cache its key.
- **It is WebFinger-resolvable** (`acct:instance@oxy.so`). Mastodon's key fetch
  runs a WebFinger check and refuses a signer it cannot resolve; see the
  `@oxy.so/federation` 0.16.0 changelog for the outage that caused.
- **It is not a person.** A per-user key would make Move speak as someone.
  The instance actor speaks for the server, which is the truth: Move is part
  of Oxy.
- **It follows nobody.** A signature proves only "this request comes from
  oxy.so". The remote server applies its domain blocks and serves what it
  serves any unfollowed remote server: public content. Nothing followers-only
  is reachable with it.

Mention's actors live on `mention.earth` and are signed through
`POST /federation/sign` with `federation:write`. That route is the wrong tool
here: it signs a caller-supplied string with a key on a domain the app owns, and
nothing serves a key for `move.oxy.so`.

## What bounds it

- **GET only, by construction.** The caller sends a URL, never a signing
  string. Oxy composes the string with `@oxy.so/federation`'s `signRequest`:
  `(request-target): get <path>`, `host`, `date`.
- **The instance key only.** No `keyId` is accepted.
- **Public https only.** The URL must be `https:`, carry no credentials, and
  resolve to a public address (`assertSafePublicUrl`, the rule `safeFetch`
  applies). A refusal is a 400 with `details.reason`: `invalid_url`,
  `not_https`, `credentials_in_url` or `not_public`.
- **A narrow, privileged scope.** `federation:instance-fetch` is staff-granted
  (`PRIVILEGED_APPLICATION_SCOPES`) and is the ONLY scope the route accepts:
  `federation:write` does not imply it. Every signature spends Oxy's reputation
  as a fetcher, because a remote admin who sees abuse from `instance@oxy.so`
  blocks all of Oxy. Oxy Move's seed entry and workload binding carry it.
- **A per-app rate limit** of 1200 signatures a minute
  (`rl:federation:instance-fetch:`).

## How Move uses it

Move reads unsigned first. On a 401 or 403 it asks Oxy for a signature and
retries once, and from then on signs every read of that host for the rest of
the job. A server that refuses the signed read too (it blocks oxy.so, or only
federates with an allow-list) fails the job with
`source-requires-authorized-fetch`.
