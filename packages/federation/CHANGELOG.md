# Changelog: `@oxyhq/federation`

## 0.16.0

### Fixed: the instance actor was served but was not WebFinger-resolvable

`GET /.well-known/webfinger?resource=acct:instance@<domain>` returned **404**
while `GET /ap/users/instance` returned a full `Application` actor. The actor
router had an `instance` branch; the WebFinger router had none, so the lookup
fell through to `resolveUser('instance')`, which asks Oxy for a user that does
not exist, and 404'd.

The server actor is not an Oxy user. It has no profile and no fediverse-sharing
consent record, so it must be answered ahead of both the resolve and the consent
gate — exactly as the actor route already answers ahead of them.

**Why this was a silent, total outage of signed fetches.** Mastodon's
`FetchRemoteKeyService#find_actor` calls `ActivityPub::FetchRemoteActorService`
*without* `only_key:`, and that service runs `check_webfinger!` unconditionally.
Our 404 raised `Webfinger::Error`, produced a nil account, and every
secure-mode instance answered **401 to every signed GET we made** — outbox sync,
remote actor fetch, quoted/boosted note import, and the repair scripts built on
them. Signature verifiability was 0%, not per-host.

Inbound delivery and outbound POST were unaffected, because both use a USER key
whose WebFinger does loop back. That is why federation looked healthy while every
signed read failed.

The WebFinger `self` href and the actor `id` are now built from the SAME
`urls.actor(INSTANCE_ACTOR_USERNAME)` call, because Mastodon compares
`webfinger.self_link_href` against the actor uri and rejects a mismatch — a
trailing slash is enough to break it. A test asserts the two REAL router
responses are equal rather than re-deriving either string.

The instance JRD is deliberately not routed through the app's JRD cache: the
document is static, so there is no I/O to amortize, and one stale or evicted
entry could otherwise make the server actor undiscoverable for a full hour —
which is the outage the branch exists to prevent.

### Added

- `INSTANCE_ACTOR_USERNAME`, the reserved `instance` local-part, exported from
  the package root. Both routers now derive the server actor's username from it
  instead of each spelling the literal, so the two cannot drift. The value is a
  wire contract with peers that have already cached `acct:instance@<domain>`.

## 0.15.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxyhq/federation` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.14.1` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

`@oxyhq/federation` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.14.1` does not accept `0.15.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
