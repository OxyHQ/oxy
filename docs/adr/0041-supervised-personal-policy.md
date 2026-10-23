# ADR 0041 — Supervision is a personal safety policy

- Status: implementation in progress; no consumer capability enabled
- Date: 2026-10-15

## Identity and consent

A supervised account remains a personal identity. Organization membership, family organization roles and account ancestry confer no guardian authority. The child invites one exact guardian with fresh reauthentication and versioned consent. The guardian accepts that expiring invitation with independent fresh reauthentication. This records consent to the product's supervision relationship; it does not assert verified legal guardianship or infer it from a birth date.

Activation atomically makes the account private, revokes previous subject/operator sessions and establishes an issuance epoch. Explicitly hidden profiles stay hidden. Contact approval requires the current active, unrestricted personal guardian. Guardian deletion, archival or restriction fails closed on live policy reads, without waiting for asynchronous erasure processing. Neither editing a birth date nor a generic privacy update can remove supervision. Independent staff review with evidence is required to transfer or end it. A transfer requires fresh consent from the child and incoming guardian. End, transfer and re-enrollment invalidate previous contacts and all unreserved purchase approvals.

## Consumer authorization

An application name or browser client ID is not proof. The decision service verifies the live application service principal and the original signed human session, including exact session binding and any application audience. It rechecks scope `safety:decide` and the action-specific reviewed capability `safety:<action>:v1`. Actions are `profile`, `messaging`, `content`, and `purchases`. Unsupported supervised operations fail closed. No global Kids enablement flag grants all application routes access.

`SafetyRequester` contains either the original `accessToken` (explicit null means anonymous) or a `connectionToken` verified through the existing MCP connection authority. Ordinary authorized operated accounts remain supported. Supervised operated sessions and delegated MCP access are unsupported. Service delivery decisions have a separate `safety:messaging-delivery:v1` capability and never substitute for original human authorization.

Messages use participant metadata, never private message bodies. One decision evaluates all participant pairs involving supervised members, up to 256 participants; splitting a group into independent chunks is invalid. Contact and delivery decisions recheck current blocks, guardian availability and approvals. Existing adult-only group behavior remains owned by the application. Profile batches support 100 subjects. Content batches support 100 immutable application resource identifiers and authoritative application moderation classifications; unrated and mature content are denied to supervised viewers. Client declarations and visibility settings are not moderation evidence.

Existing inference, service acting-as, external machine credentials and capability delegation owned by a supervised identity are denied until those domains have reviewed policy integration. Existing credentials cannot bypass a later enrollment.

## Purchases

Approval binds the authenticated child, live application, immutable operation and resource IDs, cart fingerprint, the complete canonical merchant account set, payment fingerprint, exact integer amount in minor units, currency and expiration. The application computes those facts from its durable order, never from a client's authorization claims. An immutable normalized authorization snapshot contains up to 200 complete item references, titles, variant/options text, quantities, unit amounts and authoritative line amounts, plus shipping, tax, discount and an explicit signed conversion adjustment. BigInt validation requires its exact total to match the payment instruction without rewriting a merchant ledger. The central adjustment bound is line count plus three times merchant count; merchants must also validate their own stricter actual conversion-stage bound. Summary lists omit these lines: guardians must open the authorized full approval detail before reviewing. Child erasure cascades all approval lines. Guardian approval permits a reservation of exactly those effects. The same operation can retry reservation and confirmation idempotently; changing effects or receipt conflicts. Cancellation is terminal and never recycles approval.

The merchant must use the same immutable operation as its PSP idempotency key and persist order/outbox state before charging. Oxy reservation is not a cross-database payment transaction. A reserved operation may be confirmed after a policy transition to record an already completed charge. Unreserved pending/approved requests are cancelled by policy transitions. PostgreSQL locks and immutable-effect constraints serialize approval/reservation against guardian changes.

## Media and rollout

New assets owned by supervised accounts remain private, including direct generic asset writes. Public URLs previously distributed cannot be recalled from the Internet. Protected stream authorization, including existing scoped stream tokens, rechecks current guardian/contact/block policy for child-owned private media. Child own-file upload/metadata/preview management is an explicit owner-only operation. There is no reviewed general-media classifier in this delivery, so nonowned assets remain unrated and unavailable to supervised viewers, including public avatar/logo assets; consumer interfaces use placeholders. No caption can authorize an unrelated media payload.

The existing ordinary-adult session validation contract remains available. Legacy ID-only and unsupported consumer paths explicitly deny supervised subjects and operators. Updated SDK middleware forwards the original bearer to the existing header-validation endpoint; reviewed Kids actions use the service/session decision endpoint with live consumer authority. No global authentication API migration is part of this delivery. Consumer SDK upgrades precede enabling their individual supervised action capabilities.

No production enrollment or application support grants are enabled until consumer read/write, realtime/delivery, media and payment paths have been reviewed and tested. Source package versions and database migration slots are finalized against actual main immediately before merge.


## Publication and private audiences

`publicationPolicy` authenticates the original author; `publicationPolicies` is a separate reviewed background capability for bounded author/coauthor sets. Both re-read current availability and supervision. Supervised authors require private audiences, without collaboration or federation. Schedulers and outbound federation must recheck even if a stored post was created before enrollment.

Content decisions use authoritative service-owned author, audience and application audience permission. A distinct application resource grant represents an adult's explicit current collaborator or channel membership permission; a public app audience never overrides private Oxy profiles. Supervised private content instead requires current guardian/contact consent in both directions, and blocks/unavailable subjects always deny. Applications must first reject drafts, deleted records and other non-audience lifecycle exclusions. Only an explicit `manage_own` operation for a matching authenticated author can return that author's unrated content for composing/editing; nested references remain normal reads.

## Scoped deployment ordering

The service policy scope `safety:decide` is required for ordinary adult and anonymous policy reads too; it does not grant supervised support. Provision that scope to the exact reviewed consumer workload before updating its SDK to the service-proof policy transport. Preserve unrelated workload scopes, including exact token tuples. Enable individual action capabilities only after all corresponding consumer paths are tested. Reviewed optional middleware never turns a presented bearer into anonymous access on a policy denial, invalid session or authority outage; it returns 403, 401 or temporary 503 respectively. Ordinary legacy optional routes retain their existing adult behavior unless a consumer opts into `strictOptionalBearer: true`. That option preserves absent-bearer anonymous access but rejects presented invalid/expired credentials with 401, policy denials with 403 and authority outages with 503; it does not declare a reviewed supervised action or grant support.

The additive SDK `serviceToken(apiKey?, apiSecret?, {scopes?})` and service request `serviceTokenScopes` option request a bounded exact subset. Both credential and workload mints refuse scopes outside their live effective grant; omission keeps the old contract. Scope sets are normalized in the cache key, broad tokens are never reused for narrow requests, and credential invalidation clears every scope variant. A mint response that ignores narrowing is rejected. The safety namespace requests only `safety:decide`. Clarity's existing inference/agent caller must request its unchanged `user:read,inference:invoke` tuple before its workload gains safety authority; its exact tuple assertion is not widened.

`packages/api/scripts/provision-safety-consumer.ts` prepares four explicitly named consumer plans from existing exact AWS role bindings. The default is a read-only dry-run. `SAFETY_CONSUMER` selects `clarity`, `mention`, `allo`, or `mercaria`; `SAFETY_STAGE=base` adds only the base scope, while `SAFETY_STAGE=capability` requires an explicit comma-separated `SAFETY_ACTIONS` subset and refuses to run before base authority exists. Applying requires `APPLY=1`, `EXPECTED_PLAN_SHA256`, `BOOTSTRAP_ACTOR` and `BOOTSTRAP_REASON`. The observed application/binding facts and resulting grants are hashed together. Unrelated grants are retained. Allo's initially empty binding is materialized from its current effective nonprivileged scopes before adding safety, so `user:read` is retained. No candidate action is enabled simply by being listed in the source manifest. Mention's MCP workload receives base scope for adult policy decisions; supervised delegation remains denied regardless of the application's action grants.


## Shared management UI

`useSupervision` from `@oxy.so/services/ui` is advisory state keyed by account and session. The SDK keeps the session's supervision state always current (at start, when the app returns to the foreground, and via the session socket's token-free `supervision_changed` signal, which the API emits to child and guardian on every invitation, acceptance, cancellation, transfer and end); screens read it without waiting for the network; the server keeps enforcing supervision on every content request. A failed fetch hides the retained value. The public surface entry is `useOxy().showBottomSheet?.({screen:'Supervision',props:{approvalId,childAccountId}})`; both props are optional. The same screen supports a child reading its own approval and the current guardian reviewing it with fresh reauthentication. It renders all immutable lines/options, canonical personal or organization merchant identities, exact minor-unit amounts and the visible FX adjustment. Missing merchant identity prevents approval. Account or session changes reset the surface; authority errors hide retained private evidence.

The personal account owner starts supervision through Manage Account or the personal-root entry in Create Account. This does not create or operate another person's identity. Sending an invitation makes the requesting account private immediately; cancellation does not make it public. Pending invitations are not active protection and confer no guardian controls. Acceptance atomically activates policy and revokes existing sessions. Both participants confirm fresh action-specific proof. Changing or ending an active guardian relationship requires independent reviewed evidence; there is no self-service escape by changing birth date or family membership.

The minimal `safety.people` selector returns only account ID, handle and display name. Prefix search excludes private accounts. A known exact shared handle may resolve a private account only when its profile remains visible, active, unrestricted and unblocked. Hidden accounts do not become searchable. Batch reads additionally resolve current supervision relationships and merchants in purchases the caller is authorized to review; no biographies, assets or contact data are returned.

Media batches build one request-local graph of unique owners and viewer, then preserve the existing file/entity/restriction checks for every asset. That graph never crosses requests. Singular streams, including previously minted scoped media tokens, re-read current policy; revoking a contact affects the next request. No trusted media rating producer exists in this delivery, so supervised consumption of other people's media remains unrated and unavailable, including profile imagery. Own-file management remains a distinct authorized operation.


## Batched conversation decisions

`messageAccessBatch` authenticates one original requester and evaluates complete participant sets per resource. `deliveryAccessBatch` uses separately reviewed service delivery authority, never a human identity substitution. Both return one decision keyed by each unique resource ID, with at most 100 resources, 4096 aggregate participant slots, 1024 participants per ordinary adult conversation and 448 KiB of input (leaving room for proof within 512 KiB). A conversation involving supervision is limited to 256 participants; never split its participant set into separately authorized chunks. Self-only groups require a live requester and, when supervised, a live guardian and reviewed messaging capability. Adult-only group membership/block semantics remain the application's existing policy.

One live database graph serves the entire batch, including guardians outside the participant sets. Consumers must apply each decision independently and re-evaluate at read, send and background delivery; there is no durable authorization lease or contact-revocation grace period. Queued notifications and socket metadata cannot reuse an earlier allowed result. Existing own-file visibility can be restricted to private by its authenticated supervised owner; public/unlisted promotion stays denied.


`messagingSessions` is a separately reviewed delivery-service operation for up to 100 unique request IDs carrying original recipient bearers, with a 448 KiB aggregate JSON limit. It verifies signatures and exact session bindings, reads active sessions/accounts and supervision live in bulk, and rechecks special actor/key authority. It returns only request ID, allowed and the verified account ID when allowed. It neither authenticates a human operation nor grants conversation access: realtime consumers must intersect each socket result with the current persisted-resource `deliveryAccessBatch` decision. Revocation, account restriction, new enrollment, expired proof, wrong application and removed consumer capability fail closed on the next delivery. No user/profile or session cache can authorize this lane.

Clarity's candidate `content` capability is limited to its audited Experience endpoint: privacy alone does not rate free-form work history. Direct reads must apply `contentAccess` with unrated classification after profile access; only verified owner management may use `manage_own`. Other supervised readers cannot consume that unrated history. No other Clarity content, inference or search route is reviewed by this grant.

### Minimal existing employer identity

The authenticated browser method `safety.organizations({query, limit?} | {ids})`
uses `POST /safety/supervision/organizations` with the original personal-session
bearer, through the same supervised admission boundary as `safety.people`.
It returns only `accountId`, `username`, `name`, and `organizationType`, inside
`{items: [{requestedAccountId, organization}], missingIds}`. Prefix search is
limited to 20 results; batch input permits at most 100 unique IDs. The canonical
indexed organization search and flattened merge references remain the sole data
source. Private, hidden, inactive, suppressed, restricted, blocked, nonorganization,
and unavailable identities are omitted; merged IDs resolve only to an available
canonical target. No verified-domain, asset, legal-name, alias or website data is
hydrated for this response. Authority outages return 503; invalid or revoked
sessions return 401.

Mention and Clarity use this method for a supervised person's own Experience
employer display and existing-company selector. Ordinary adult directory behavior
is unchanged. Neutral creation and claims remain unsupported for supervised
accounts; foreign Experience remains unrated and unavailable to child readers.
