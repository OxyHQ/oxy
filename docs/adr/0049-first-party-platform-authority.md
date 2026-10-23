# ADR 0049 — Own Oxy applications share platform authority; scopes belong to external connections

- Status: accepted; implementation and rollout tracked separately.
- Date: 2026-10-23.
- Decision: the owner requested removal of internal scopes, consent prompts and
  per-app agent access levels across the Oxy ecosystem, including direct product
  API/SDK calls. A product developed by Oxy is first-party even when its users
  are external customers.
- Amends: ADR 0031 (own-app consent), 0026 (workload scope lists), 0042
  (per-app agent ceilings), 0043 (own-app scope/consent gates for files), and
  preceding decisions wherever they require an Oxy application to obtain a
  permission grant from another Oxy application. Other resource and identity
  invariants in those decisions remain in force.

## Decision

**A person signs in to Oxy, not to a collection of permission grants.** Own
applications use the shared Oxy session, with no scope request or consent
screen. An older own client sending OAuth scopes receives a scope-less sign-in;
no `app_grants` row is created or refreshed, and no external revocation is
cleared. External OAuth retains explicit scopes, registered ceilings, PKCE,
isolated sessions and revocable grants.

**An own backend proves its workload identity.** The service authority contract
is `authority: 'first_party' | 'external'`. `first_party` requires a verified,
active workload binding, an active registered own application and the binding's
explicit environment. A customer API key remains external even if someone
created it under an official application. Neither a public client ID nor an app
name, asserted origin, owner account or forwarded header proves an own service.
Own service calls carry no OAuth scope lists; product recipients use their exact
`oxy-service:<applicationId>` audience, and Kaana retains `kaana.ai`.

**Own applications work across the ecosystem on the correct account's data.**
The target service still authenticates the person, service or bot and checks
resource ownership, membership, account policy and the operation's domain rules.
Reading a person's invoice from their Inbox is an ordinary own-app operation;
reading somebody else's mailbox is not. Passing an external OAuth token through
an own backend never widens that token into platform authority.

**Alia and own agents have no per-app enablement or Nada/Ver/Ver y actuar levels.**
Their own-app tools come from the live catalogue. The requester and effective
account remain explicit throughout a turn, nested agent call and scheduled
work. A public agent never obtains its owner's data for another requester;
`self_*` acts only on the bot's own account. Internal operation tickets retain
subject, resource, recipient and operation binding without asking for an app
connection grant. Existing domain constraints and sensitive-operation rules
remain enforced; this change adds no approval prompt.

External products connecting an Oxy account, third-party MCP clients and OAuth
connections from Alia to external providers remain external integrations.
Public anonymous reads remain public reads; their caches must not start mixing
private viewer data merely because both products are owned by Oxy.

## Compatibility and delivery

Update the authority producer, shared SDK and each receiver before removing
legacy fields. Do not emulate this decision by granting every scope, renaming
scope lists to capabilities, or adding a local `isOfficial` bypass to every app.
Authorization codes and pending OAuth requests record their lane at issuance.
An external code stays isolated after a registry classification change; a
first-party code loses validity if its application loses trust. Isolated OAuth
sessions cannot approve a new connection or shared sign-in. Legacy pending
requests/codes without provenance restart instead of inferring trust. The additive provenance migration adds nullable columns before the new API;
existing sessions stay live.
Historical grants are not new authority. Existing external connections and
revocations must survive the transition. Tests and deployed digests, not a
merged branch, establish rollout completion.

Canonical integration rules: [first-party platform access](../auth/first-party-platform-access.md).
Work inventory: [migration tracker](../architecture/first-party-integration-migration.md).
