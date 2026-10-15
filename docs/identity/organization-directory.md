# Organization directory: SDK and UI integration

See [ADR 0039](../adr/0039-canonical-organization-directory.md). Every ID below is the actual Oxy account ID. Types and runtime schemas are exported from `@oxy.so/contracts` (`Organization`, `CreateOrganization`, `OrganizationType`, `ORGANIZATION_TYPES`, `createOrganizationSchema`, `organizationSchema`).

## Public discovery

`oxy.organizations.search({query,organizationType?,limit?,cursor?})` returns `{items,nextCursor}`; search matches case-insensitive prefixes of the canonical public name, handle, legal name and aliases through an indexed derived projection. Limit is 1–50. Cursors are bound to query and classification.

`get(accountId)` returns an organization or typed `not_found` (404). `batch({ids})` accepts 1–100 IDs and returns `{items:[{requestedAccountId,organization}],missingIds}`; each organization carries its canonical `accountId`. These methods support anonymous callers, validate responses and do not cache privacy/lifecycle decisions. A nullable `username` supports profile links. An avatar is an Oxy file reference, not an arbitrary external URL.

Use query-cache keys scoped under `['oxy','organizations']`; invalidate the directory prefix after create/update/curation/claim review. There is no SDK-owned React hook or second organization cache. Render `claimStatus:'unclaimed'` visibly. Never use it as permission to edit.

## Existing shared account UI

`oxy.accounts.create({kind:'organization',username,name:{displayName},organizationType:'business',...})` creates a genuinely managed account under the existing permission rules. `oxy.accounts.update(accountId,{organizationType})` changes classification through existing `account:update` authority. Other account kinds reject organizationType. Account-node responses retain their existing identity shape; fetch `organizations.get(accountId)` to show the subtype rather than adding a second subtype column.

CreateAccountScreen should search/select an existing organization before offering a new managed account. Choosing an unclaimed existing result starts a claim; it never creates a duplicate or assigns ownership by name. A separate directory-add action calls `organizations.create({name,organizationType,...})`, which creates an unclaimed entry and grants no capabilities. Existing organization managers use `organizations.update(accountId,changes)` for the canonical legal/name/alias/website fields.

## Claim and staff review UI

- `claim(accountId,{evidenceReference})` creates or returns the caller's pending request. It changes no permissions.
- `myClaims({status?,limit?,cursor?})` and `myClaim(claimId)` expose only the authenticated personal user's requests.
- Staff use `reviewClaims(...)` and `reviewClaimDetail(claimId)` to read the private evidence queue.
- `reviewClaim(claimId,{decision:'approved'|'rejected',evidenceReference})` requires fresh staff authority and independent review. Approval grants owner membership on the existing account ID atomically.
- `curate(accountId,{changes?,status?:'active'|'inactive'|'suppressed',evidenceReference})` lets staff correct neutral facts or moderate visibility. It does not claim the account. Claimed factual edits remain with its managers.
- `merge(sourceId,{targetAccountId,evidenceReference})` is staff-only and rejects a source with ownership/operating history or pending claims.

Evidence references must point to the private reviewed case or immutable source archive. They are absent from public organization responses. User-facing errors use the shared closed lower-snake-code schema. A missing entity is indistinguishable from a suppressed/private entity to public clients.

## Service ingestion and migration

`OxyServer.organizations.importBatch({namespace,items:[{externalId,organization,evidenceReference,avatarFileId?}]})` requires service auth, the privileged `organizations:import` scope and exact application capability `organizations:import:<namespace>`. The SDK uses its canonical service lane. Result: `{items:[{externalId,accountId,created}]}`. Maximum 100 items/512 KiB; repeated external IDs in one batch are rejected. The transaction is all-or-nothing, and retries reuse mappings without changing existing identity fields. Attach a source image only after verifying it is a public Oxy asset owned by the importing app's owner account.

Only staff can call `importExternal({namespace,externalId,accountId?,organization,evidenceReference,avatarFileId?})` to link a reviewed pre-existing account, or `resolveExternal({namespace,externalId})` for a read-only migration probe. An existing external mapping cannot be reassigned to a conflicting canonical account. Never infer a merge from matching names or automatically turn imported domains into verified domains.

## Deployment handoff

Homiio's `organizationImport` manifest binds namespace `homiio` to its existing application and exact attested ECS worker role (`oxy-homiio-worker-task`). `bootstrap-native-product-agents.ts` includes the application scope, exact namespace capability and worker workload-binding scope in its observed/desired plan hash. It preserves existing grants and refuses a missing, expired or differently bound workload. Review a fresh dry-run before applying; a stale plan hash fails. The API role retains its exact Sindi token scopes; ingestion and backfill run on the worker role. No service secret is created. This provisioning must precede enabling Homiio ingestion/backfill.

The Clarity backend application manifest at `packages/api/src/config/nativeProductAgents.ts` declares `https://api.clarity.surf/webhooks/oxy/account-events`. Its canonical bootstrap dry-runs registration, refuses any different existing webhook, and applies only the reviewed plan. Deploy the receiving signed-SET handler before registering the endpoint. Do not run a generic application seed to change this identity.

Kids settings will be a separate supervised-personal policy namespace. UI must not infer guardianship from account membership or family organizer status; central enrollment/approval contracts are required before exposing supervision controls.

## Sensitive personal profile detail

`oxy.safety.profileAccess({subjectAccountId},{accessToken})` is the central access decision for cross-product profile detail such as Clarity Experience. An `OxyServer` caller must explicitly pass the original incoming user bearer, or `null` for an anonymous visitor. The SDK never substitutes a backend service identity, refreshes this explicit credential into another account, or accepts a viewer ID. A browser client can omit options to use its current user context.

Response: `{allowed,reason,policyVersion:'1'}`. Reasons are `public`, `owner`, `private`, `blocked`, `unavailable`. Private or profile-hidden details are owner-only; current Oxy follows are unilateral and do not grant consent. Either direction of a block denies access. Missing, archived and restricted accounts deny access. Errors must fail closed; response caching is disabled. The API exposes neither date of birth nor guardian IDs. This primitive does not enable supervised mode by itself.
