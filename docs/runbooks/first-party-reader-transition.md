# First-party reader transition

This is a finite deployment sequence for ADR 0049. It does not introduce an
application permission switch. Complete the workload environment preflight and
review workloads outside its recorded inventory before deploying this API.

## Protocol sequence

The preparatory SDK keeps manual `OxyServer.serviceToken()` and
`serviceTokenFor()` workload exchanges on the existing v1 request (no
`protocolVersion` field). External credential pairs remain external regardless
of the host's infrastructure identity. `serviceRequest()` to Oxy, resource and
service introspection, and `createServiceClient()` use v2 workload authority.
Every internal SDK-to-Oxy call also uses v2, including requester verification,
anonymous service reads, the revocation feed and ecosystem activity. The
activity publisher accepts an optional temporary `workloadCredentials` provider;
legacy API-key environment variables no longer select its identity. Explicit
legacy credential callbacks remain subject to the API receiver policy.
Workload caches and in-flight exchanges are separated by audience AND protocol.
The public low-level `requestWorkloadServiceToken()` also remains v2. There is no
public protocol option.

Shared transport cancellation covers identity preparation as well as the product
request. Cancelling one consumer does not cancel another consumer's shared mint;
the exchange has its own 15-second deadline, including temporary credential
resolution. Authority requests reject redirects and omit ambient cookies.

The API's `legacyResourceWorkload.service.ts` projects a v1 workload as own only
after signature verification for exact `oxy-api`, a live binding with explicit
matching environment, active own application and owner, matching token identity,
and the complete id/application/provider/subject tuple in
`legacyWorkloadTransition.ts` (27 recorded bindings). A new binding, a matching
brand, a workload-looking credential id or an API key cannot qualify on its own.
Every request rechecks live identity; the projection is not cached.

An authenticated v2 receiver gets `authority: first_party` without scopes. The
old canonical Clarity workload receiver, itself proved against the same finite
inventory, gets its previous `tier: internal` and scope-array shape until it is
upgraded. This scope array is compatibility serialization for that old reader,
not an internal grant. Customer keys remain external for either reader.

The shared service middleware can ask Oxy to resolve a signed legacy workload
for a registered product audience. It checks the returned application,
credential, owner, environment, exact original audience and expiry against the
verified JWT before accepting own authority. Failure to obtain the live verdict
fails closed. External authority always produces an external tier, even if an
old signed token contains internal branding.

## Resource identities

Product receivers use `OxyServer.introspectResourceToken()` and the shared
`ResourcePrincipal` union. `kind: service` has the workload/credential tuple and
recipient; `kind: key` is always external and has an expiry only when the key is
bounded; `kind: session` has the actual requester and effective account. Shared
Oxy sessions have `applicationId: null` and no scopes; external OAuth sessions
keep their registered application and the live intersection of token, session,
client, application and grant scopes. A session is never fabricated into a
workload. Effective account permissions survive the typed SDK response.

Keep `introspectServiceToken()` for strict service middleware. It deliberately
does not accept a human or a raw API key as a service principal. Both methods
perform uncached authority reads. Domain ownership verification also requires
the canonical Clarity workload's live own identity.

## Cutover and removal

1. Deploy the dual issuer after the environment backfill. Publish and pin the
   preparatory SDK/contracts through the repository's release workflow.
2. Upgrade receivers before producers. Test old callers against each upgraded
   receiver, including external keys/OAuth and managed human sessions.
3. Migrate own producers to product SDK factories backed by
   `createServiceClient()` and their canonical audience. Confirm every inventory
   workload and every newly observed workload has migrated.
4. Remove the v1 issuer path, exact-cohort projection, old Clarity serialization,
   and the middleware's legacy candidate branch together. Remove
   `requestLegacyWorkloadServiceToken`, make manual workload minting v2, and
   collapse the now-unnecessary protocol dimension in the private cache. Remove
   the finite inventory and nullable-environment fallback only after no live
   reader or issuer relies on them. Update this runbook and deployment evidence.

Do not deploy regenerated combined migrations over an unmigrated preflight.
Preserve the upstream preflight journal/snapshot and regenerate subsequent
first-party DDL from it; never rewrite an already applied migration.
