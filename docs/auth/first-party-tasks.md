# Requester context for Oxy services and background tasks

Oxy-owned workloads authenticate through their registered infrastructure identity.
Their v2 service principal has `authority: "first_party"` and no `scopes` field.
Application keys and app-bound OAuth sessions remain external, even when their
application is official. Changing registry branding cannot promote an existing
external session, key, execution authorization or ticket.

A workload identifies the calling service. A requester proof identifies the
account involved in the operation. Neither an application owner nor an
`X-Oxy-User-Id` header substitutes for that proof.

## Foreground requests

Use the shared SDK and a current Oxy shared-session bearer as the transient
`requesterToken`. `OxyServer.createServiceClient` accepts
`requester: { accountId, token }`; Files accepts
`oxy.assets.withRequester({ requesterToken })`.

Oxy verifies the session, its current subject and operator, managed-account
membership and any autonomous account signer. An app-bound OAuth bearer cannot
create own task authority. The receiving service verifies the caller's registered
audience (`oxy-service:<applicationId>`) and requests live account verification.
Own verification responses omit scopes and are never positively cached.

For a tool call, use `oxy.agency.createForegroundExecutionAuthorization` with
`authority: "first_party"`, the requester proof, actor, exact resource, live
catalogue registration/version/digest, run identity and expiry. Direct executions
require `runId` and reject `automationId`. The API derives operation policy from
the task and tool effect; there is no application grant, ceiling or autonomy
selector. Existing limits on sensitive operations and account policy still apply.

## Durable work

Create a root with `oxy.agency.createTask(input, { requesterToken })` when the
requester starts a goal or schedule. The result is the task object with `id`.
Persist that identifier in the job/session; never persist the bearer.

The root stores the original requester, effective account, coordinator application
and exact workload attribution identity, actor, originating operation, expiry and
revocation. It stores no per-application permission list. An immediate `request`
root lasts at most 15 minutes and remains bound to its live session. A `goal` or
`automation` may last up to 366 days and survives signout; account, signer,
workload and task revocation remain live checks. A background continuation is a
durable goal, not an immediate request root with an extended lifetime.

Use `createTaskExecutionAuthorization(taskId, input)` for each tool operation.
Child bots preserve the original root requester and effective account. A bot's
self tools can select only the root's exact actor account, and only while the
original requester holds live `account:act_as` authority over that bot. A public
agent cannot infer its owner's authority. Schedules bind their original
`automationId`; direct run inputs and schedule inputs cannot be mixed.

Use `oxy.assets.withRequester({ taskId })` for files belonging to the root's
effective account. For that root actor's own files, pass
`withRequester({ taskId, accountId: rootBotId })`; Oxy checks the exact root bot
and the original requester's current membership before selecting it. The file
owner must still match. A file ID or owner header never selects the account.
`serviceRequest({ taskId })` and
`createServiceClient({ requester: { accountId, taskId }, ... })` carry the same
proof through the shared transport. A different workload cannot reuse the task
identifier: the coordinator attribution must match. Cross-service execution uses
the existing signed tool ticket and receiver introspection, not a copied raw task
ID.

`oxy.agency.revokeTask(taskId)` cancels the root. The next derivation, ticket
introspection, file operation or account verification refuses it. Account-switch
operations additionally check the original task target and live membership.
The shared hourly expiry sweep removes roots thirty days after expiry or
revocation, whichever comes first, in bounded batches. Their derived execution
authorizations are deleted with them. Capability audit events, idempotency
receipts and the originating product's goals, sessions and history remain.
Expiry and revocation deny access immediately, independently of housekeeping.

Legacy jobs without verifiable provenance need a new authorized start; they
cannot fall back to a bot owner or application owner.

## Files and external callers

Own requester context removes inter-application consent for the same account.
It does not bypass file privacy, sharing, application ownership, references or
entitlements. A personal file read still uses the verified account's access check.
A service-only file ID cannot determine its own requester. User-media writes must
name the verified effective account.

External calls retain live OAuth grants, scope intersections and existing
execution grants/ceilings. External introspection always projects external tier
and authority, even for historical tokens branded internal. Internal service
hops must preserve external request authority instead of relabelling it as own.

## Deployment order

The workload environment binding is provisioned metadata, never inferred from a
role name or supplied by the client. Before starting an API that requires bound
identities (including Inbox), deploy the nullable environment schema and run the
reviewed cohort preflight at `packages/api/scripts/provision-workload-environments.ts`.
The script defaults to dry-run; its explicit apply mode validates all recorded
binding IDs, applications, provider subjects, expiry, app liveness and trust in
one locked transaction, then changes only null environments by compare-and-set.
Do not deploy the final API between that DDL step and completed provisioning.

During fleet migration only the exact recorded legacy cohort may request v1.
New SDKs request `protocolVersion: 2`. After all consumers and receivers are
verified and v1 usage reaches zero, remove cohort compatibility, workload scope
columns/CLI support and scope seeding for internal workloads as the final cutover.
External OAuth and API-key scope provisioning remains. Generated migration
numbers must be regenerated against the final integrated upstream journal.
