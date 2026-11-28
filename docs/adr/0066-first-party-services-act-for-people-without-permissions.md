# ADR 0066 — Oxy's own services act for people without asking them; permissions are for third parties

- Status: accepted
- Date: 2026-11-14
- Decision: the owner. «Para todas las apps/servicios/etc de Oxy no deberían
  existir permisos. Todo lo que son permisos es para apps/servicios de terceros
  que usen nuestras APIs o OAuth de Oxy. Para nosotros no tiene sentido todo
  eso, aunque sé que muchas apps/servicios de Oxy todavía lo usan: hay que
  limpiarlo de todos lados y dejar claro eso.»
- Supersedes: [0049](0049-first-party-platform-authority.md)'s requirement
  that an own workload present a requester proof (a shared-session bearer, a
  durable task, a capability ticket or a requester context) to act on a
  person's account, and [first-party tasks](../auth/first-party-tasks.md) as
  the way background work keeps that proof. Gemies ADR 0022's "background
  goals persist only an Oxy task id" and its channel task renewal follow.
- Keeps: 0049's lanes (own workloads are `first_party`, customer keys and OAuth
  are `external`), [0056](0056-first-party-operator-authority.md) (operator
  keys), [0030](0030-email-code-password-authenticator.md)'s rule that sign-in
  never reveals whether an account exists, and every third-party contract.

## Context

ADR 0049 removed scopes and consent screens from Oxy's own apps, but kept one
per-person thing: an own service could act on a person's account only while it
held proof that the person had just asked. In the foreground that was their
session; in the background, a task minted from that session and valid up to a
year. Every product that works for a person while they are away grew the same
machinery around it: Gemies stores a task on every channel, bot link, agent
session and work item, renews it before it lapses and sends the person a
"reauthorise" notice when it does; Syra and Move store one per upload
or import; Mention, Homiio and Syra thread session bearers into
Files. A person who never opened the app again, or whose task lapsed, silently
lost a feature they had turned on, and the person was asked, in effect, to keep
granting Oxy permission to work for them in Oxy.

For a third party that is right: Oxy cannot know what an outside app will do, so
the person decides, scope by scope, and can revoke it. For Oxy's own services
Oxy already knows, because Oxy wrote them.

## Decision

1. **First-party is the code registry.** A first-party service is an application
   in `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`, with its exact
   `id`, calling as its registered workload (`authority: first_party`, ADR
   0026/0049). Branding, an origin, an owner account, an OAuth token or a
   customer key never makes a caller first-party.

2. **Each service declares what it does for people, in code.** Its registry
   entry lists `actsForPeople`: on which receiver (`oxy:<area>` for Oxy's own
   API, or another Oxy application's exact id), `read` or `write` (write
   includes read), and the purpose the person reads. The API reads this list at
   runtime; nothing is seeded, granted or clicked, and a change is reviewed in
   the diff that makes it. The areas are a closed vocabulary
   (`utils/firstPartyDelegation.ts`): `files`, `linked-accounts`,
   `account-switch`, `chains`, `privacy`, `safety`, `product-access`,
   `app-invitations` and `tools` (any internal tool of a live first-party
   capability catalogue).

3. **A declared service names the account and nothing else.** It sends the
   account it acts on (`X-Oxy-User-Id`) and, when the person operates that
   account rather than owning it (an organization, a gemie's bot account), the
   person (`X-Oxy-Requester-Id`). SDK: `createServiceClient({ actingFor })`,
   `oxy.actingFor(...)`, `oxy.assets.actingFor(...)`,
   `oxy.linkedAccounts.actingFor(...)` and
   `oxy.agency.createFirstPartyExecutionAuthorization(...)`. There is no session,
   task, ticket chain or requester context behind it, and nothing to renew: it
   works the same in the foreground and in the background, today and next year.

4. **Oxy checks it live, every time.** The workload and its application are
   live; the registry declares this receiver and effect; the person is an
   active local personal account; every account involved is active, not being
   closed and not supervised; and when the account acted on is not the person's,
   the person holds `account:act_as` over it now. A receiving product asks Oxy
   (`/internal/service-acting-as/verify`, through `OxyServer`'s middleware) and
   gets `authority: first_party` with the person. Then the receiver's own rules
   run as before: ownership, privacy, sharing, tenancy, sensitive-operation
   limits, product entitlements. Anything undeclared is refused
   (`first_party_capability_not_declared`). A service token naming no account
   acts as the service, which reaches nobody's data.

5. **Everything a service does for a person is recorded where they see it.**
   Each use increments `first_party_delegation_activity` (account, person,
   application, receiver, effect, day: count, first, last; nothing of the
   request itself), kept 400 days. The person reads it in Accounts → Security,
   "What Oxy apps did for you" (`GET /capabilities/first-party-activity`, also
   for an account they operate). Tool operations keep their per-operation
   capability audit events as before.

6. **The person can always turn a feature off, in the product.** Every
   background use hangs off a feature with a product setting: Gemies' email
   alerts switch, a channel the person disconnects, a reminder they delete.
   That is a product preference, not an Oxy permission, and it is where "stop"
   lives. A product shipping a new background use ships its off switch with it.

7. **Third parties are unchanged.** OAuth scopes, consent, PKCE, isolated
   sessions, revocable grants, external delegation grants and ceilings, MCP
   connection grants (including Mention's media and Homiio's document
   facades), customer API keys and their scope ceilings stay exactly as they
   are. An external token passing through an own backend is still external. An
   own service that does work an external MCP client asked for acts on the
   account the connection verified, with its own declared authority (Syra
   storing an MCP-generated episode as the person's file).

8. **Retired.** For own services: requester tokens, durable tasks
   (`/capabilities/tasks*`), foreground execution authorizations, requester
   contexts and nested capability-ticket proofs, task renewal and every
   "reauthorise" flow, and per-product task columns. They remain only until
   their last callers migrate, then are deleted with their tables (tracked in
   [first-party migration](../architecture/first-party-integration-migration.md)).
   Nobody adds a new one; `scripts/check-first-party-permission-vocabulary.mjs`
   fails CI when retired vocabulary reappears outside its allow-list.

## What keeps this safe

"No permissions for first-party" is not "any Oxy service may do anything to
anyone":

- **Declared, narrow blast radius.** A service reaches only the receivers and
  effects its entry declares. Gemies declares Files and tools; it cannot read
  linked accounts, mint account sessions or change privacy because it does not
  declare them. The test `seedOxyApplicationsSpecs.test.ts` pins the full list.
- **Unforgeable identity.** The caller is an attested workload binding (AWS
  role, exact environment), checked live; nothing a request carries can claim
  another service's declarations.
- **Live accounts and membership.** Acting on an organization or a bot needs
  the person's current `account:act_as`; removing a member ends it at once.
- **Receivers still decide.** A declaration opens the door to a person's
  account, not to every object in it: file privacy, sharing, application
  ownership and domain limits run after it.
- **Visible to the person**, per application and day, and stoppable in the
  product.

The trust boundary is the same one ADR 0049 already relied on: an own service
holding a person's bearer or task could act within it for up to a year. What
changes is that the boundary is now written down per service and enforced, and
the person no longer pays for it with prompts, renewals and features that stop.

## Out of scope

- Background `product-access` reads for Gemies (product-credit funding): an
  economics change that depends on Kaana's native admission cutover. Gemies
  declares no `oxy:product-access`.
- Kaana's financial authority for inference (ADR 0065).

## Delivery

1. Oxy API and `@oxy.so/core` accept the declared lane beside the old proofs
   (this ADR's first change). Migration 0260 adds the activity table and lets a
   first-party execution authorization exist without a session or task.
2. Consumers move to `actingFor` and declare in the registry: Gemies first
   (files, tools; channel media, Inbox from Telegram, reminders, email alerts),
   then Syra, Move, Mention, Homiio and the product SDKs' requester
   unions.
3. Oxy deletes the old proofs, `first_party_tasks` and their routes, with
   pre/post migrations, once no caller remains.
