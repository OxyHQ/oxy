# I05 foreground profile invocation: proposed common-contract extension

Source basis: `19676aa5d6069a117e0ab5fcd8f1e925fc6106f9`. Root authorized this
bounded upstream implementation after reviewing Mention's real foreground
callers. Migration0141 is reserved with the integration owner. This is a design
for review before schema changes; it asserts no publication or deployment.

## Gap and authority to preserve

Mention currently needs both its own private recommendation profile and the
present viewer. `profiles.ts:835` grants private `clientId` only to the matching
service app or a user who operates its owner. A normal viewer bearer therefore
cannot preserve Mention's private ranking weights. Service `actAs` carries an
unproved viewer and cannot replace present-requester authority under strict I03.
The shared requester assertion in ADR0025 is bound to native product agents; it
is not a profile endpoint credential. Agency's current actor union and SQL CHECK
admit only Alia or a bot agent. Naming Mention as Alia would misattribute execution.

Extend the existing Capability ticket and InvocationContext; add no bearer
family or free-form delegated-user header. The new executing actor is
`{type:'requester',accountId}`: the authenticated human or bot principal. The
effective account remains a distinct resource subject. A human A acting as
organization B therefore remains actor A / subject B. A bot needs its real live
key/session; an account ID alone is never autonomous authority.

## Smallest source/schema change

Keep the existing standing/delegation actor union limited to Alia and bot agents.
Add the requester discriminator only to execution requests and signed ticket
claims, with strict refinements: direct_request, read_only, no grantId,
no automationId, actor.accountId=requesterAccountId. Persist two nullable fields
on capability_execution_authorizations: requesterSessionId (historical session handle, with no FK or delete cascade) and requesterSessionBindingDigest (64 hex).
A CHECK requires both only for requester actors; the actor CHECK accepts their
non-null actorAccountId and exact requester equality. Other actors retain their
existing NULL fields and behavior. No new ledger/table is needed.

The issuing API derives session ID and digest from the already validated bearer,
never request fields. The digest covers only normalized non-secret session
binding: sessionId, userId, operatedByUserId, authMethodId/owner,
applicationId/publicClientId, deviceContextId, tokenRotatedAt and ordinal-sorted
scopes. No bearer, refresh token, prompt or arguments are persisted. A rotation,
context/subject replacement or scope-binding change invalidates this short
foreground approval and requires a new request. Expiry and status are re-read,
not frozen as authority in a hash. Request owner and effective account must equal
the live session subject; actor must equal its current verified principal.

Issue and introspection must use fresh session/managed-membership/agent-key
validation plus live account fences. App-bound sessions must belong to the
presenter's application, with their own credential/scopes still usable; shared
first-party sessions require a currently trusted registered presenter. The
existing live coordinator resolver checks current app, owner, closure fence,
credential/workload and scope ceilings. Require the normal capability issuance
scope and coordination capability, plus the exact read capability. No offline
scope or user grant is synthesized. Snapshot or API errors deny.

## Concrete HTTP and SDK transport

Add `agency.createForegroundExecutionAuthorization(input, { requesterToken })`
to the existing service SDK namespace. Its one Oxy authority request is
`POST /capabilities/foreground-execution-authorizations`:

```http
Authorization: Bearer <coordinator service token>
Content-Type: application/json

{
  "subjectToken": "<requester's current access bearer>",
  "tool": "recommendProfiles",
  "expectedCatalog": { "registrationId": "...", "version": "...", "digest": "..." },
  "runId": "...",
  "stepId": "...",
  "expiresAt": "..."
}
```

This follows the already shipped `agency.mintRequesterAssertion` transport in
`packages/core/src/server/namespaces.ts`: the service bearer authenticates the
presenter; `subjectToken` goes only in the body to Oxy's configured authority.
The request has no free coordinator, actor, owner, subject or app ID. The API
uses `serviceAuthMiddleware` and the live service principal resolver, then
verifies the independent requester bearer. The tool selects only the closed
foreground read catalogue; the resource is constructed from the live session's
subject. No new token family or delegated-user header is added. The request is
not retried automatically; errors never fall back to app-only execution.

After signature/expiry validation, the API reloads the session with
`validateSessionById(sessionId, true, { useCache:false })` and compares the
original bearer claims to that fresh row using the existing session binding
checker. The original principal and current effective subject stay separate.
App-bound sessions must match the authenticated presenter and retain the exact
read scope under current app/credential/consent ceilings; shared sessions need a
currently registered trusted first-party presenter. Consent checks use the
existing OAuth rules; this lane neither creates a standing grant nor invents
`acting-as:offline`. Ticket issuance and every live introspection repeat the
session binding, membership/key, presenter and scope checks.

`requesterSessionId` is an opaque historical reference, not a foreign key.
`SessionService.deactivateSession` updates `isActive`, while the normal expiry
sweep may delete the row. A missing/inactive/expired row denies new tickets and
introspection. Deleting a session therefore does not cascade away the
execution approval. `capability_audit_events` stores its authorization reference
inside the bounded event JSON; `capability_idempotency_keys` stores ticketJti and
resource keys. Neither table has an FK to the execution authorization or the
session. Keeping the historical handle avoids changing logout or sweep order,
and prevents this extension from deleting receipt/audit provenance. The schema
census will classify the handle explicitly with this lifecycle rationale; it
will not create a blanket exemption for new session references.

## One Oxy catalogue and existing domain handlers

Add recommendProfiles and readViewerGraph as read-only operations to Oxy's
canonical catalogue, alongside its existing Inbox entries. The same catalogue
feeds shared internal MCP registration. Use exact registered id/version/digest,
audience and account-root resource. Recommendations derive private clientId from
the verified coordinator application; supplied clientId never selects another
app. Viewer derives from the verified effective account, never arguments or
X-Oxy-User-Id. Reuse buildRecommendations and getViewerGraph, including privacy,
blocked/restricted accounts, domain filters and cache keys; no second ranking
implementation. Existing bearer/service routes and external OAuth remain until
parity is established. Requester tickets cannot call Inbox effects.

The receiver verifies the common signature/issuer/audience/TTL and catalogue,
then performs live introspection before each read. A signed coordinator claim
must exactly match its persisted authorization and current live credential.
The short bearer capability is not a new proof-of-possession protocol: stealing
it has the existing bounded ticket risk, never extra service authority. Random
signed jti, run and step are retained end to end. Replaying the same authorized
read within its short lifetime is allowed only after the same fresh checks;
replay cannot select another actor/subject/app/tool or become a write. This does
not claim one-shot consumption absent from the existing Capability contract.

## Acceptance and compatibility

Use real HTTP, shared SDK client/receiver and disposable PostgreSQL. Positive
human, bot and humanA/subjectB cases must preserve Mention's private clientId,
viewer personalization, filters, boosts and output. Compare canonical legacy
service ranking (under its previously valid authority) against the new pinned
foreground request; never call general ranking private parity. Refuse expired or
revoked/rotated session, switched subject, missing managed membership, revoked
bot key, wrong presenter/credential, changed app owner, closed/fenced account,
missing scope, wrong audience/tool/resource/catalogue and standing/automation
requester actors before reading private signals. Replays remain read-only and
observe revocation between calls. Backend/domain permissions and Mention's own
Postgres effect receipts remain independent for the Alia→Mention pilot.

The new discriminator changes a closed decoder and must be included in the final
SDK release version/range review, not slipped into already published contracts.
Registration/deployment order must upgrade receiver+shared decoder before opting
in callers. Current candidate packs are explicit SHA-pinned test artifacts;
registry publication, actual registration and pilot rollout remain separate.
