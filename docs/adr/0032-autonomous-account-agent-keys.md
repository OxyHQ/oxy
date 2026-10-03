# ADR 0032 — A bot authenticates as itself with an agent key

- Status: accepted; implementation candidate for I01 (#1520).
- Authority: [Nate's approval](../architecture/1519-approved-completion-2026-10-03/authorization.txt).
- Amends ADR 0018's autonomous-account authority and ADR 0024's authentication
  model. The personal Commons root and ADR 0030 human sign-in remain unchanged.

## Decision

A `bot` may authenticate with a registered secp256k1 runtime key. The private key
stays with an injected signer (for example a KMS/HSM); Oxy stores the public key
in `user_auth_methods` as `agent_key`, separately from `users.publicKey` and the
personal DID. A bot gets an ordinary account session, never a service token,
application scope, trusted tier or owner identity. It has its own resources,
funds, plan and obligations under the common policies.

`POST /auth/agent/challenge` returns strict versioned claims: purpose, audience
`oxy-api/agent`, account, actor, method, public key, payload digest, random
challenge and expiry. `buildAgentProofMessage` additionally binds timestamp and
proof role. The challenge lasts 60 seconds and is single use. Verification
locks the account and key, checks account closure and key liveness, then burns
and mints in one transaction. Failed post-commit sign-in audit delivery does not
undo a consumed proof; the external-transaction mint omits device-added audit
and cache writes. Governance audit is a SQL row in its mutation transaction.

## Government and operation

Current owner/admin membership with `credentials:manage`, including inherited
membership, governs enrollment, recovery and revocation. The creator has no
permanent privilege. A governor may itself be a bot, authenticated by its own
live agent key. A personal governor provides fresh action-bound root proof OR
validated ADR 0030 reauthentication (`credentials_manage`, plus TOTP when
configured); merely presenting a reauth object is insufficient. A bot governor
provides a fresh action-bound signature. Enrollment and recovery also prove
possession of the new key.

An autonomous bot has self operational permissions for its resources and funds.
That does not synthesize an owner role. Membership/government permissions and
role-based owner protections retain their real current role. Autonomous
rotation proves the old and new keys and can retire the old key atomically or
leave an overlap. A bot can retire the very key authenticating its current
session; revoking other keys requires current government. Recovery atomically
revokes old keys and related sessions/codes and enrolls the replacement. Public
keys remain unique globally after revocation; tombstones prevent key reuse.
No bot-specific quota, plan limit or owner approval is added to ordinary work.

## Provenance and delegated use

`sessions` and `auth_codes` retain both method id and method owner, which is the
principal even when the effective account is an organization. The ownership FK
is composite and uses RESTRICT. A revoked key, archived bot or closure fence
denies validation and token refresh, including warmed session-cache entries.
Account switches and OAuth issuance/exchange carry this provenance. OAuth
approval stores `auth_sessions.approvedBySessionId`, derived exclusively from
the authenticated session. `authorizedSessionId` retains its existing minted
session meaning. Deleting an approving session cascades the pending approval;
a bot missing provenance never falls back to personal legacy approval.

Standing OAuth consent must check the key under account→key locks in the same
transaction before grant/epoch/revocation-marker/code writes. This integration
belongs to I03's consent transaction; tests of final composition are required.

D4 execution authorizations derive `requesterAuthMethodId` from a live session.
Autonomous self authority requires actor = requester = owner = effective account
and a live key. Only the membership/delegation requirement is omitted in that
case: catalog, tool, resource, capability, policy and input limits still apply.
Authority is checked again for ticket issuance and live execution validation.
Other-account execution retains its grant and membership requirements.

MCP OAuth grants likewise retain the approving principal's key. Approval locks
account→key before grant/code writes. Refresh, introspection and execution
resolve live key authority. Reapproval with another key revokes the old grant
and its connection memberships and creates a new grant atomically; it never
rebinds old tokens or inherits scopes not requested by the new approval. Legacy
personal grants keep their behavior; a bot grant without key provenance fails
closed. No transport is added or duplicated.

## Contracts, API and rollout

`@oxy.so/contracts` exports `AccountAuthMethod`, strict proof/operation/inventory
schemas and canonical signing bytes. Existing actor-chain v1 wire fields are
unchanged; method provenance is server authority, not caller-supplied identity.
`@oxy.so/core/server` exports `signInAgentAccount` with an injected signer;
`oxy.auth.agent` and `oxy.accounts.agentKeys` expose typed proof transport. No
signing UI, browser key custody or React dependency is added.

Governance uses `GET /accounts/:id/agent-keys` and POST `challenge`/`execute`
under that path. Inventory contains public key and audit metadata only. All
mutation payloads are strict whitelists. Rate limiting uses hashed transient
keys; no user IP is persisted.

Migrations 0137 and 0139 are additive pre-deploy changes. 0139 follows the full
0138 billing snapshot and adds only approval/D4/MCP provenance references and
indexes. RESTRICT/tombstones preserve provenance; nullable legacy columns never
promote a bot into an unbound authorization. Publication/version coordination,
composition CI and production rollout are separate gates. Local SQL fixtures
use synthetic funds and no payment provider, credential or real transfer.

Acceptance evidence is mapped to P1–P14 in the
[implementation matrix](../auth/proposals/bot-autonomous-auth.md#4-pruebas-contra-suplantación-y-escalada).
This ADR does not assert production revocation latency or complete I03 acceptance.
