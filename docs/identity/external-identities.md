# External identities

Oxy owns external account identity and profiles for every Oxy app. Connectors
discover actor references and content; they do not derive canonical handles,
normalize profile biographies, or decide person equivalence.

`POST /federation/identities/resolve` requires a service token with
`federation:write` and exactly one `actorUri` or `handle`. A handle can be a
supported network profile URL. Oxy fetches the source with its signed,
DNS-pinned HTTPS client and applies the reviewed policy in
`packages/api/src/config/federationBridgePolicy.ts`. Native atproto identities
are verified against the DID returned by the Bluesky appview. Caller-provided
name, biography, avatar, and canonical handle claims are never persisted.

The response includes the public `user`, the actor-specific `externalIdentity`,
all currently verified `externalIdentities`, and `redirectedUserIds` for older
references. `sourceUserId` stays anchored to the source account; `userId` is the
current canonical person. Public profile resolution and legacy
`PUT /users/resolve` use the same authority. `POST /federation/identities/lookup`
accepts up to 100 IDs, account handles, or actor URIs without remote discovery.
The shared request/response schemas live in `@oxy.so/contracts`.

`external_identities` owns canonical network accounts; `external_identity_actors`
retains every transport URI and protocol. Physical redirects retain old user
rows and graph references when duplicate transports converge. Cross-network
equivalence uses revocable, reciprocal source claims pinned to both stable
upstream identities. Its deterministic canonical person is selected by stable
user ID. Removing a claim or letting evidence expire immediately separates
the source identities; graph checks expand the currently valid group instead
of permanently copying cross-network ownership. There is no equal-username
shortcut.

The reviewed kilogram.makeup actor documents currently expose an Instagram
handle, but no stable upstream Instagram identifier. Consequently an
Instagram/Threads pair such as `zuck` remains pending despite matching handles
or reciprocal handle links. Oxy does not invent a Meta identifier to enable a
merge. Native Threads numeric actor URIs supply a stable Threads identity;
Instagram still needs equivalent source evidence.

The reviewed dotmakeup policy opts into an exact repair for the observed
`https://https://twitter.com/jordievole` Official-link serialization defect.
The shared parser removes one duplicated HTTPS prefix and then applies the
ordinary accepted-host, credentials, and profile-path checks. Conflicting
Official profile assertions fail closed. Operator accounts without upstream
evidence retain their transport identity.

## Existing data

Deploy migrations 0083 and 0084 before switching application consumers. The
registry migration preserves existing actor references and marks their source
verification timestamp as epoch. A public request for an unverified legacy
bridge actor awaits Oxy source verification before returning its profile.

Run the Oxy reconciliation from the API package using the deployment's ordinary
database and signing configuration:

```sh
bun run reconcile:external-identities
bun run reconcile:external-identities --apply
```

The default is a read-only report. The applying pass refetches each reviewed
source through the same identity authority, preserves Oxy IDs when possible,
and reports canonicalization, retained transport identities, and refusals.
`--after=<actor-uri>` resumes after a reported cursor. Repeating a successful
pass is idempotent. It covers Oxy-only actors as well as actors discovered by
Mention. Retain reports and resolve refused actors before deleting application
identity tables.

Mention must reconcile content by source actor URI, retain source provenance,
and migrate only references confirmed by Oxy. Do not rewrite every historical
row by a former group ID: that prevents safe revocation. Legacy user-id-only
actor deletion/archival is refused for identities with multiple source actors,
so one dead transport cannot remove another network's person or graph.
