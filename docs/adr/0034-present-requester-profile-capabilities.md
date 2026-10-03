# ADR 0034 — Present requester profile reads use the common capability contract

- Status: accepted implementation direction; rollout requires registered catalogue and verified caller configuration
- Date: 2026-10-03
- Scope: I04/I05, Oxy profile recommendations and viewer graph

## Decision

A registered first-party presenter sends its service bearer and the requester's
current access token separately to
`POST /capabilities/foreground-execution-authorizations`. The SDK's
`createForegroundExecutionAuthorization(input, { requesterToken })` sends the
requester proof only to its configured Oxy authority, in the body. It accepts no
free principal, subject, actor, standing grant or automation selector.

Oxy derives the principal from the live session operator and the subject from
its effective account. They can differ for a managed account. It verifies the
session, autonomous signer when applicable, membership, account closure fences,
application trust and live credential/binding scopes. App-bound sessions must
belong to the presenter and retain `user:read`; shared first-party sessions keep
the existing foreground rule. Revoking an offline grant is separate from
revoking a foreground session (ADR 0025); this lane creates no offline grant.

The authorization uses the existing ticket, catalogue, resource, audit and
invocation contracts, with `actor.type=requester`, `direct_request` and
`read_only`. It names one tool, catalogue pin, run and optional step. Its expiry
is at most 15 minutes and cannot exceed the presented bearer or session. Ticket
issuance and execution recheck live authority, including session rotation and
scope narrowing. The historical session handle has no cascading foreign key:
logout or deletion denies further calls while retaining approval/audit evidence.
Workloads use the existing inert `wl_` attribution row and binding, preserving
the existing foreign keys; they receive no substitute credential or secret.

The separate canonical Oxy profile catalogue has audience `oxy-platform-api`
and exactly `recommendProfiles` and `readViewerGraph`. Inbox remains its own
catalogue. HTTP `/_oxy/capabilities/*` and `/_oxy/mcp` use the same signed-ticket
verifier and domain handler. Recommendations derive the private profile key
from the verified presenting `Application.id`; no slug equivalence or general
ranking fallback substitutes for it. Graph reads accept no free account selector.
Existing public HTTP/session routes retain their existing contract.

Private results are released only after the final live authority check, after
all domain and audit awaits. An audit record can exist for a computed result
whose release is subsequently denied. Read replays are permitted while the
same bounded authority is current; this is not a one-use assertion. The signed
`jti` correlates audit events. No requester bearer or tool argument is persisted
or logged. ADR 0025's native-agent assertion remains a separate one-use entry
point; no additional token family is introduced here.

## Rollout boundaries

Mention needs its existing `user:read` ceiling plus `capability-tickets:issue`
and `agency:coordinate` on the verified application/presenter path. Registration
requires an existing Oxy catalogue registrar with `catalogs:write` and
`catalog:oxy`. Being an official brand or accepting a free application ID grants
none of those permissions. Readback and compare-and-set must preserve existing
scopes, capabilities and role bindings. No absent-user consent is synthesized.

The candidate SDK and backend implement the contract together. Consumers must
use a release containing the new exports and a backend containing migration
0141 and these routes. Candidate tarball checks do not prove registry adoption
or production registration. Receiver parity, caller configuration and published
SDK adoption are separate I05 acceptance evidence.
