# ADR 0042 — An agent acts for a present requester under its owner's published ceiling; present-requester assertions are retired

- Status: proposed
- Date: 2026-10-16
- Amends: ADR 0018 (adds the addendum "an agent acts for a present non-owner requester")
- Supersedes: ADR 0025 (present-requester assertions for native product agents)
- Scope: Oxy authority for Alia agents used by people other than their owner; retirement of the native-product-agent lane
- Companion: Alia ADR 0020 ("Every agent is the same agent")

## Context

The owner decided on 2026-10-16 that there is one agent model. Homiio's Sindi and Clarity's assistant become ordinary Alia agents. Their owner publishes them, a person reaches them under that person's own Oxy session and credits, and Alia may consult them from any app.

ADR 0018 gives an agent two kinds of authority:

- **A `DelegationGrant` from its owner.** This covers the owner's data, through the per-app levels.
- **Its own account** (the 2026-10-06 addendum).

Neither covers the case that a public agent exists for: a person who does **not** own the agent asks it to work on **their own** data. Sindi is public, and a tenant asks it to save a home to *their* Homiio list.

Today that case has two answers, and both are wrong:

- **For ordinary agents, the case is refused.** Alia builds `oxy_<app>__*` tools only when the owner is present (Alia ADR 0015: "Somebody using a shared or public agent never gets its owner's data"). The rule is right, but it also leaves the agent with no way to reach the *requester's* data.
- **For native product agents, ADR 0025 built a parallel lane.**
  - The product backend trades the person's session for a one-use `OXY-REQUESTER+JWT`.
  - Alia verifies the JWT, and the agent is pinned to one application by a manifest mirrored in two repositories.
  - The product application pays for the turn.
  - Because that lane exists, Sindi cannot be reached outside Homiio and cannot be consulted by Alia, and a second chat had to be maintained inside Homiio.

A per-requester `DelegationGrant` would also work, but it has two problems:

- Every first use becomes a consent step.
- It stores long-lived authority for a request the person is making right now, which is the "second authority for access Oxy already owns" that ADR 0018 rejects.

## Decision

### An owner publishes a ceiling per app

An `AgentRequesterCeiling` is stored centrally in Oxy:

```text
AgentRequesterCeiling {
  id, agentAccountId,            // the agent's bot account
  appId,                         // the catalogue it bounds
  capabilityPackages[],          // never finance, security or delegate
  toolOverrides[],               // optional narrowing, same shape as a grant's
  limits[],                      // same shape as a grant's
  maximumAutonomy: 'read_only' | 'execute_on_request',
  writes: 'review' | 'on_request',
  version, createdBy, updatedAt, revokedAt
}
```

Who may write a ceiling, and how:

- **Writer:** only a human who currently holds `account:act_as` over the bot, with that person's own bearer. This is the same operator test the 2026-10-06 addendum uses.
- **Routes:** `PUT | GET | DELETE /capabilities/agent-ceilings/:agentAccountId/:appId`.
- **Unrecognised packages:** a package the catalogue does not declare is refused.
- **Audit:** every write is audited.

A ceiling is a statement about **what the agent may do for whoever uses it**. It grants nothing on the owner's data and nothing on the agent's own account, and it does nothing by itself: only a present requester activates it.

### A present requester activates it with a direct request

Alia asks for an execution authorization in this shape:

```text
kind: 'direct_request'
actor: { type: 'agent', accountId: <bot> }
requester = effectiveAccount = ownerAccountId (claim) = the person in the turn
ceilingId: <the ceiling for (bot, app)>
grantId: absent
```

It is authenticated the same way as the owner-present lane: with the requester's own bearer, so Oxy itself proves the person is present. `ceilingId` and `grantId` are mutually exclusive in the claims schema. A ceiling authorization is never `automation` and never `autonomous`.

`evaluateCapabilityAuthority` evaluates it in this order:

1. The coordinator is a live agency coordinator. (Unchanged.)
2. The requester currently operates the effective account (`requesterCanOperate`). In other words, the requester is acting on their own account or one they operate.
3. The actor is a live `bot` that is not archived. (Unchanged.)
4. The ceiling is active, its `agentAccountId` is the actor and its `appId` is the resource app. It must allow the tool by the same rule a grant does (`grantAllowsTool` over packages and overrides).
5. The tool's declared `actors` admit `agent`, where the catalogue declares `actors`.
6. The effective account's policy does not deny the tool's capabilities. (Unchanged.)
7. Limits are merged from the authorization and the ceiling. (The same merge as grant limits.)
8. Autonomy is `mostRestrictiveAutonomy([authorization, ceiling, accountPolicy])`, capped at `execute_on_request`.

The effective permission is therefore:

```text
requester's current authority over their own account
∩ effective-account policy
∩ the owner's published ceiling for the agent and app
∩ autonomy of a direct request
∩ the app's current authorization
```

This is ADR 0018's intersection, with the ceiling in the place a delegation takes. The ticket carries `ceilingId`. `reauthorizeCapabilityTicket` re-reads the ceiling's `revokedAt` and `version`, so narrowing or revoking a ceiling takes effect on the next call. The audit records `ceilingId` beside requester, coordinator, actor and effective account.

### Writes ask unless both sides allow them

The approval itself belongs to Alia (Alia ADR 0020 §3). Oxy records the facts that approval reads:

- **`writes: 'review'`:** Alia must show an approval card before every effect.
- **`writes: 'on_request'`:** the requester's account policy for that app decides whether a direct request without a card is acceptable.

Payments and irreversible deletes always show a card, whichever value is set.

### Present-requester assertions are retired

ADR 0025 is superseded. Once Alia ADR 0020's contract step has shipped, the following are removed:

- `POST /internal/native-agents/requester-assertions` and its `/introspect`;
- `services/nativeRequesterAssertion.service.ts` and `.runtime.ts`;
- `config/nativeProductAgents.ts`. Clarity's backend application id moves first to `config/firstPartyApplications.ts`, because `routes/resourceIntrospection.ts` still reads it;
- the native-agent bootstrap script, plan types, workflow and runbook;
- the `agency.mintRequesterAssertion` / `introspectRequesterAssertion` client methods. They are deprecated in `@oxy.so/core` 4.x and removed in the next major.

The product workloads lose `inference:invoke` and `acting-as:offline` when nothing they run still uses them. Each loss is proved by a token read-back, as the 2026-10-11 amendment did. `acting-as:offline` stays the lane for absent-user work, for any product that still has some.

ADR 0034's foreground `requester` actor is unrelated and unchanged: it is for a present person's own read-only profile tools.

## Alternatives rejected

- **Per-requester delegation grants.** These need a consent step on every first use and store standing authority that outlives the request.
- **Keeping ADR 0025 alongside the ceiling.** That would leave two lanes for the same situation, two payers, and a manifest pinned across repositories.
- **Letting a public agent act as Alia.** That gives the wrong attribution, and the agent would get Alia's full reach instead of the owner's published bound.
- **Writing the ceiling into Alia only.** Oxy is the authority for delegation (ADR 0018). A ceiling that only Alia knows could not be re-checked by the receiving app's ticket verification.

## Consequences

- Any person can use a public agent on their own data within what its owner published, with no consent screen and no standing grant. Leaving the conversation ends it.
- Sindi and Clarity become ordinary agents. Their owners set ceilings in Alia's agent editor, and Homiio and Clarity stop calling Alia from their backends.
- Contracts gain:
  - `agentRequesterCeilingSchema`;
  - an optional `ceilingId` on ticket claims, refined as exclusive with `grantId`;
  - an optional catalogue `features[]` (`{ key, description, checkTool, consumeTool? }`, where `checkTool` is an internal `read` and `consumeTool` is an internal write with `idempotency: 'required'`). Alia ADR 0020 uses it for feature gates;
  - an optional `internalTransport: 'mcp' | 'http'`, defaulting to `http`. Alia reads it instead of a pilot environment variable.

  The catalogue schema is strict. Oxy and Alia must therefore run the release that knows these fields **before** any app registers a catalogue that uses them.
- Migration `agent_requester_ceilings` is a `pre` migration. The lane is additive. ADR 0025's code is removed only after Alia and the products no longer call it.

## Enforcement

- **Authority matrix tests** in `capabilityAuthority`, covering every combination of:
  - owner or non-owner requester;
  - ceiling present, absent, revoked or narrowed;
  - account policy allowing or denying;
  - read or write;
  - each autonomy level.

  A ceiling can never yield `autonomous`, can never reach an account the requester cannot operate, and can never reach the owner's account.
- **Revocation:** `reauthorizeCapabilityTicket` refuses within one call after a ceiling is revoked or its version changes.
- **Claims:** a schema test proves `ceilingId` and `grantId` are exclusive.
- **Ceiling writes:** a ceiling write by someone who does not operate the bot is refused. A ceiling listing `finance`, `security` or `delegate` is refused.
- **Contract step:** a CI grep gate fails on `nativeRequesterAssertion`, `NATIVE_PRODUCT_AGENT` or `requester-assertions`.
