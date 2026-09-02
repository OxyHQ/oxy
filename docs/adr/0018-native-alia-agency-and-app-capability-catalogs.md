# ADR 0018 — Alia is native authority, agents are separate actors, and each app owns one capability catalog

- Status: accepted
- Date: 2026-09-02
- Scope: Oxy authority, Alia coordination, app execution, and external MCP access

## Context

Oxy has two kinds of automated work that look similar at the tool boundary but
have different authority:

1. Alia is an Oxy product acting for the person currently using it.
2. A user-created agent is an independent digital person with its own Oxy bot
   account and only the access explicitly delegated to that account.

Treating both as a long-lived user session would erase that distinction. It
would also make revocation depend on token expiry, let background work outlive
the authority that created it, and make a public action appear to have been
performed by whichever bearer happened to reach the app.

The previous integration shape also encouraged each tool to be described more
than once: once inside Alia, again in an app's MCP server, and sometimes a third
time in permission UI code. Those copies inevitably drift in names, schemas and
authorization. A skill prompt cannot repair that drift and cannot be an access
control: prompts are guidance, not credentials.

Finally, Oxy-internal execution and an external MCP client are not the same
trust plane. Requiring Alia to OAuth back into its own platform would add a
second authority for an access Oxy already owns. Letting an external MCP client
use the internal service lane would remove consent, resource binding and client
revocation.

## Decision

### Actors and resources are explicit

`ActorRef` distinguishes native Alia from an Oxy account of type `bot`.
`ResourceRef` names the app, effective account, resource type and resource id.
The effective account is the public identity used by the domain action; the
actor remains the executor recorded by audit.

Alia is a native Oxy capability. For a direct request it may use every Oxy app
and account the requester can operate at execution time. That base access is not
an OAuth grant and is not a user-disableable integration. Alia's settings govern
autonomy, recurring instructions, limits, coordination and notification, not
whether Alia is part of Oxy.

Every created agent is a real, separate Oxy bot account. It starts with no
delegations and never receives a copy of a person's session. Sharing an account
or resource delegates that resource; it does not impersonate the owner or expose
the owner's other accounts.

Skills may influence planning and tool use. They grant no permission, secret,
connection or autonomy.

### Oxy is the authority for delegation

`DelegationGrant` is stored centrally in Oxy and binds an actor to resources,
semantic capability packages, tool exceptions, limits, expiry, maximum
autonomy and optional redelegation. Apps execute the decision but do not keep a
second grant database.

Effective permission is always the intersection of:

```text
requester's current authority
∩ effective-account policy
∩ delegation to the actor
∩ automation limits
∩ the app's current authorization
```

A capability package expresses meaning such as read, create, communicate,
administer, finance, security or delegate. A tool exception may narrow that
package. A newly deployed tool inherits a grant only when it belongs to a
capability already granted; adding a new sensitive capability never expands an
existing grant.

Redelegation is denied unless the actor has `access.delegate` for the exact
resource. Possession of some other capability or an autonomous policy does not
imply it.

### Autonomy is ordered and fail-closed

The four levels, from least to most authority, are:

- `read_only`: read, search and summarize;
- `draft`: prepare an effect and require approval before execution;
- `execute_on_request`: execute an effect only for a direct user request;
- `autonomous`: execute from a stored event or schedule within its limits.

Global, actor, resource and automation policies are intersected; the most
restrictive result wins. Alia defaults to `execute_on_request`. Access alone
never creates recurring work.

Money, security and other critical effects are not subject to an unrelated
hard-coded confirmation rule. They may be autonomous only when the grant names
the sensitive capability and supplies the required bounded limits, such as
amount, account, recipient and frequency.

A recurring natural-language request is persisted as an
`AutomationDefinition`, not retained as a prompt. Its receipt exposes trigger,
eligible actors, resources, actions, data destinations, limits and rollback or
stop controls.

### Each app owns one canonical catalog

Every app owns one `AppCapabilityCatalog` next to its domain handlers. A tool
entry declares its stable name and version, JSON/Zod input and output schemas,
required capabilities, resource types, effect, idempotency, rollback support,
limits and exposure (`internal`, `mcp`, or both). The same catalog also declares
the normalized events the app can publish.

That catalog is the only tool definition. It feeds:

1. Alia's internal tool discovery;
2. the app's external MCP server;
3. delegation and autonomy UI;
4. generated documentation and tests;
5. audit interpretation.

Alia contains no per-app copy of a tool schema. Adding an app requires a
catalog and handlers in that app, plus catalog registration during deployment;
it does not require an Alia adapter.

An app registers the catalog version, canonical digest and deployment identity
with Oxy only after the matching handlers are healthy. Discovery uses that
registry, replacing manual seeds. Catalog parity tests compare the definitions
derived for internal and MCP exposure.

### Internal execution uses short capability tickets

For each internal subaction, Oxy issues a short-lived signed
`CapabilityTicket`. Its claims bind requester/owner, actor, effective account,
app, audience, resource, exact capabilities, tool, limits, autonomy, `jti` and
`runId`.

The receiving app verifies signature, issuer, audience, resource, actor,
effective account and tool. It then performs live introspection before the
effect so current account authority, grant revocation, automation state and app
authorization are re-evaluated. A ticket is not a general Oxy session and is
not reusable against another app or account.

Background jobs never retain or forward a user's bearer token. Agents and
automations never receive a connection secret. Revoking authority between
planning and execution denies the pending step.

Alia does not call public Oxy MCP servers and does not run an OAuth flow against
Oxy for this lane.

### External MCP uses central OAuth and exact resource binding

Every app keeps an independent MCP protected resource. Existing public names,
including `mcp.mention.earth`, remain stable; the default for new Oxy apps is
`mcp.<app>.oxy.so`. Oxy is the central authorization server.

External clients use authorization code with PKCE S256, dynamic client
registration, explicit account selection, refresh, and revocation. Consent
shows the app, selected account, capabilities and write effects. An access token
is bound to one exact MCP resource, audience and effective account; it is
rejected by every other app and account. Multiple accounts are connected in
separate grants.

An installed third-party MCP used by Alia remains an external connection. It is
assigned independently to Alia or an agent and does not become native Oxy
authority.

The internal capability-ticket lane and external OAuth lane may share catalog
metadata and domain handlers. They do not share bearer formats, session state or
consent semantics.

There is no cross-Oxy aggregate MCP endpoint. App boundaries remain visible to
authorization, deployment and revocation.

### Coordination sees capability maps, not private content

For a general request, the coordinator decomposes the objective, filters actors
that lack effective permission, and deterministically ranks eligible actors by
direct resource access, relevant skills, permitted autonomy and availability.
It creates a graph of subactions and discloses to each actor only the minimum
input needed for that step.

Naming an agent assigns responsibility to that agent. A general request lets
Alia select among eligible actors.

A direct request from the owner may authorize a run-scoped data flow between
agents. A recurring automation must persist its sources and destinations
explicitly. Coordinating an agent does not grant Alia read access to content only
that agent can access.

App events carry `eventId`, app, effective account, resource, type, timestamp
and minimum data. They are authenticated with an Oxy service identity. Delivery
and every effect use stable idempotency keys, so duplicate events cannot produce
duplicate emails, messages, publications or payments.

### Audit attribution is end to end

Every policy decision and effect records the requester, coordinator, executing
actor, effective account, resource, tool, capability decision, result, rollback
status, `runId`, step id, ticket `jti` and idempotency correlation.

The public object is authored by the effective account. Audit still identifies
the agent that executed it and the person or automation that requested it.

## Alternatives rejected

**Store OAuth tokens or user JWTs on agents.** This creates broad impersonation,
lets a session outlive the grant that justified it, and makes revocation depend
on token rotation instead of current policy.

**Make skills the permission system.** A prompt is editable guidance with no
cryptographic audience, resource binding, expiry or revocation. It cannot
authorize an effect.

**Define tools once in Alia and once in MCP.** Two definitions have no durable
way to remain equal. Schema, capability and audit drift become release-order
bugs.

**Route native Alia through public MCP OAuth.** This turns Oxy's own current
authority into a second user-managed integration, weakens per-subaction
attribution and encourages persistent refresh credentials in background jobs.

**Let external MCP clients use internal service identity.** This bypasses
account selection, consent, resource/audience binding and per-client revocation.

**Give Alia all content visible to coordinated agents.** Coordination requires a
capability map and minimum data transfer, not transitive read authority.

**Build one MCP server for all Oxy apps.** It collapses app audiences and
resource ownership into one blast radius and makes independent revocation and
deployment ambiguous.

## Consequences

- `@oxyhq/contracts` owns the shared actor, resource, grant, automation, ticket,
  event, audit and catalog contracts.
- `@oxyhq/core/server` owns policy resolution plus capability-ticket signing and
  verification.
- `@oxyhq/mcp` owns catalog adaptation, protected-resource metadata and external
  token validation. It does not own app domain logic.
- Oxy stores normalized delegations and the catalog registry. Alia stores
  automation definitions, runs and steps.
- Existing broad or JSON grants are migrated without widening access. Existing
  non-provider integration credentials remain in their current stores; migration
  moves references and authority, not secrets. Provider credentials, including
  BYOK, follow ADR 0019 and live only as KMS ciphertext in Kaana PostgreSQL.
- `handlesAutonomousEvents` is migrated to explicit automation rules and then
  removed.
- Rollout is per app and cohort, with observation mode before effects. Inbox,
  Mention and Noted are the acceptance pilots; finance-bearing apps follow only
  after the same policy, idempotency, audit and revocation tests pass.
- A partial rollout must be described as partial. A catalog adapter without a
  live external OAuth resource is not a deployed MCP server; an event publisher
  without a durable delivery path is not durable automation.

The acceptance invariant is one traceable chain for every effect:

```text
requester → coordinator → executing actor → effective account → resource → result
```

No component may replace that chain with a general user session or an inferred
identity.
