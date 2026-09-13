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

An additional Meta proof uses fresh public Instagram and Threads profile pages,
with reciprocal platform-control badges from a reviewed DOM layout. Links in
biographies, posts or navigation do not count. The provider preserves distinct
Instagram `pk` and graph-ID namespaces, Threads web `pk`, and the separately
verified Threads ActivityPub URI. Official Threads WebFinger and the normal
signed actor fetch bind that URI to the first-party account; matching numeric
suffixes never bind identities. Display-name disagreements can reject a binding,
but matching names cannot establish one.

The proof stores only bounded account identifiers, source URLs, individual
source hashes, a combined digest, parser policy version and observation times.
It expires after 24 hours. Fresh missing, unavailable or contradictory evidence
revokes that additional edge immediately; observation watermarks prevent an older
in-flight result from restoring it. The existing reciprocal immutable machine
assertion pathway remains independent.

Kilogram actors generally lack a stable Instagram identifier. Only an Instagram
source user atomically created in the current discovery may initially acquire
`instagram:pk:<pk>` from its own validated first-party profile owner. That
standalone pin stores the source URL, document hash, parser version and observation
time separately from the pair proof; it never creates a cross-network edge. It
survives unavailable Threads pages, missing badges and native actor outages, so a
later fully verified reciprocal proof can join the same source user. An existing
matching pin can renew, while contradictory owner IDs cannot replace it. Pending
owner observations record freshness without assigning ownership: an overlapping
request may preserve a newer consistent observation for the original creator,
but a newer contradictory owner blocks that delayed initialization. Already
pinned Instagram sources cannot refresh actor timestamps, claims or profile
metadata until that observation passes the registry transaction guard. A changed
owner revokes both pair proof and machine claims, returns no usable old identity
from resolution, and stops background metadata/ownership updates. If the pinned
source’s own page is unavailable, resolution also withholds its ID; a verified
Instagram owner can recover independently while Threads remains unavailable. Existing unpinned bridge users remain `pending` with reason
`legacy_source_lineage_unproven`, retaining their graph and historical ownership.
Raw preexisting numeric IDs are not silently reinterpreted as Instagram `pk`.
This limitation applies even when current badges demonstrate the web accounts'
relationship: those badges cannot establish an old bridge handle's lineage.
The reconciliation report includes these pending or refused proof outcomes;
public service responses continue to use the shared identity contract.

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


Transport convergence refuses contradictory nonempty display names for recyclable
handles. Matching names are only a conservative conflict check, not immutable
ownership proof: an upstream service recycling a handle without a profile change
remains a residual risk. Stable sources require matching immutable identity proof
before adding another transport. Legacy native DID rows are checked against their
stored DID before adopting a newly resolved bridge; an unverified legacy bridge
must first be reconciled from its own actor document. A federated username with
no source binding is refused rather than silently adopted.

## Protected operations

`.github/workflows/release-external-identity-packages.yml` releases only
`@oxy.so/contracts@1.1.0`, followed by `@oxy.so/federation@1.0.1`. Dispatch from
protected `main` with its full `expected_source_sha` and `dry_run=true` first.
The job builds and packs each package in one command, runs its tests, validates
all packed export targets, checks the existing npm credential, and records
SHA-512 integrity. A later `dry_run=false` dispatch publishes only missing
versions. An existing version must have exactly the prepared integrity;
a mismatch is a failed run, never an overwrite. Both versions are checked
before either is published, and published integrity is read back after each
write. The existing organization `NPM_TOKEN` is available only to the release
step. The artifact contains tarballs and public integrity reports, never a token.

`.github/workflows/reconcile-external-identities.yml` runs the fixed reconciler
inside ECS. Its full `expected_source_sha` must identify the immutable ECR digest
used by every healthy live API task. It does not rebuild or deploy the API.
Dispatch from `main` with `dry_run=true`, review the `task.log` and `summary.json`
artifacts, then dispatch `dry_run=false` against that same deployed source.
The optional `after` input accepts a cursor from a previous report. The workflow
retains run metadata and logs and attempts task cleanup on exit or cancellation.
The fixed container command enforces a 90-minute timeout with a 30-second kill
grace even when the deploy role cannot stop the task directly. A missing summary or refused source produces a failed run;
the report still explains what needs attention.

### Read-only cold-discovery precheck

The deployed reconciliation workflow also accepts `mode=inspect_cache`, with
`dry_run=true`, an empty `after`, and exact `actor_uri`, `canonical_acct`, and
`transport_acct` inputs. The expected source SHA must equal the protected workflow
commit and the live image digest. This fixed operation runs only parameterized
Postgres reads in a read-only transaction; it does not fetch an actor, resolve an
identity, or change cache rows.

The artifact records the inputs and deployed SHA/digest in `run.json` and an
`operation: inspect_cache` summary containing observation time and counts for
users, identity actors and identities. User counts include private, archived and
legacy users without registry entries. All three counts must be zero before
calling a candidate Oxy-cold; Mention needs its own cache precheck too. This is
an observation at that timestamp, so concurrent discovery can change the result.
An inspection report does not authorize reconciliation apply. After deployment,
run this precheck before opening the candidate's public Mention search/profile;
public Oxy profile lookup routes themselves can trigger discovery.
