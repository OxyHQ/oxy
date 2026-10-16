# ADR 0044 — An Oxy application may confine its own agent to its own surfaces

- Status: accepted
- Date: 2026-10-16
- Amends: ADR 0042 (agent requester ceilings)
- Companion: Alia ADR 0021
- Scope: Oxy's application registry, the application of a person's session, and Alia's reach rule

## Context

Alia ADR 0020 made every agent an ordinary Alia agent and retired the
application-bound lane, in which a product agent was reachable only through its
product's backend (`agents.application_id`, ADR 0025 assertions, product-paid
inference).

One requirement that lane met is still real: Clarity's assistant must be usable
by everybody, but only inside Clarity. Two answers are wrong:

- **A setting in Alia's agent editor.** Confinement to an app is a platform
  decision about Oxy's own applications. It is not something any person may do
  with an agent they made.
- **Bringing back the lane.** A product backend proxying chat with a service
  token is the second chat, second payer and pinned manifest that ADR 0020
  removed.

## Decision

### The registry says which agents are an application's, and where they open

Oxy stores `application_agents(application_id, agent_account_id, availability)`:

- `agent_account_id` is the agent's bot account, which must be a child of an
  account the application's owner operates.
- `availability` is `anywhere` or `own_application`.

It is written only by Oxy staff, through the application administration lane
that already governs application scopes and capabilities. No agent owner,
person or app can write it through any other route. An agent with no row is
available anywhere.

### A session says which application it belongs to

Every Oxy session has a client (`azp`, an `application_credentials.public_key`).
Oxy resolves that client to its **application** live (the public key rotates;
the application does not), and the session validation answer carries
`applicationId`. That value is signed by Oxy's own session, never taken from a
caller's body or header.

### Alia asks, and enforces

`GET /capabilities/agent-availability/:agentAccountId` (coordinator service
lane, `capabilities:read`) answers `{ anywhere: true }` or
`{ anywhere: false, applicationIds: [...] }`. Alia caches it briefly and
enforces it in its one reach rule (Alia ADR 0021). An agent confined to
`own_application` is unreachable from any session whose `applicationId` is not
listed: it cannot be opened there, consulted from there or found there.

Nothing else changes. The person pays with their own credits, the conversation
runs through the SDK under the person's own session, and the agent's authority
over app data is its ceiling (ADR 0042).

## Alternatives rejected

- **An agent-editor setting:** it makes a platform rule a user feature.
- **An application binding on Alia's agent row:** a second copy of an Oxy fact,
  written by a bootstrap. That is the lane being retired.
- **A client-declared surface:** anything a client says about where it is can
  be forged.

## Consequences

- Clarity's assistant is `public`, confined to Clarity, and reached like any
  agent. Sindi has no row and is available anywhere.
- Migration `application_agents` (`pre`). The session validation answer gains
  `applicationId`. Contracts and core gain the availability schema and client
  method.

## Enforcement

- DB tests: only the staff lane writes rows; a bot that is not under the
  application owner is refused; the availability answer for confined,
  unconfined and unknown agents.
- Session tests: `applicationId` is resolved from the session's client, and it
  follows a rotated public key.
