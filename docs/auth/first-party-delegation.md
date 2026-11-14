# Oxy services acting for people

Decision: [ADR 0066](../adr/0066-first-party-services-act-for-people-without-permissions.md).
Oxy's own services never ask a person for permissions, tasks or consent. Each
one declares in the first-party registry what it does for people, and Oxy
checks that declaration and the accounts live on every request. Permissions
(OAuth scopes, consent, grants) are for third parties only.

## Declare it

In the service's entry in `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`
(the entry needs its exact `id`):

```ts
actsForPeople: [
  { on: platformReceiver('files'), effect: 'write', purpose: 'Keeps what you send to your gemies in your files.' },
  { on: platformReceiver('tools'), effect: 'write', purpose: 'Uses your Oxy apps when you ask a gemie to.' },
  { on: MENTION_APPLICATION_ID, effect: 'read', purpose: 'Reads your posts to import them.' },
],
```

- `on`: `oxy:<area>` for Oxy's own API (`files`, `linked-accounts`,
  `account-switch`, `chains`, `privacy`, `safety`, `product-access`,
  `app-invitations`, `tools`), or the receiving Oxy application's exact id for
  that product's API.
- `effect`: `read` or `write`; `write` includes `read`. A receiving product's
  read is `GET`/`HEAD`/`OPTIONS`.
- `purpose`: one sentence, at most 160 characters, which the person reads in
  Accounts → Security → "What Oxy apps did for you".

Merge the declaration (with its test in `seedOxyApplicationsSpecs.test.ts`)
before the code that relies on it. Nothing is seeded: the API reads the
registry at runtime. Ship the feature's off switch in the product in the same
change: every background use has one.

## Use it

Name the account; send nothing else.

```ts
import { OxyServer } from '@oxy.so/core/server';

// Oxy Files for a person (also in the background, with no session):
await oxy.assets.actingFor({ accountId: personId }).uploadUserMedia(/* … */);

// An organization or a bot account the person operates:
oxy.assets.actingFor({ accountId: organizationId, requesterAccountId: personId });

// Another Oxy product's API (its SDK takes the transport):
const transport = oxy.createServiceClient({
  baseURL: 'https://api.mention.earth',
  audience: `oxy-service:${MENTION_APPLICATION_ID}`,
  actingFor: { accountId: personId },
});

// A catalogue tool operation (Gemies):
await oxy.agency.createFirstPartyExecutionAuthorization(terms, { requesterAccountId: personId });
```

The headers are `X-Oxy-User-Id` (the account acted on) and `X-Oxy-Requester-Id`
(the person, when different). The SDK sets them and strips any a caller passes.
Never store a person's bearer to act for them later, and never mint or keep a
task, ticket chain or requester context for it.

## What Oxy checks

On every request, before the route runs:

1. the caller is a live registered workload of the declaring application, in
   its bound environment (`authority: first_party`);
2. the registry declares this receiver and effect for it;
3. the person is an active local personal account; every account is active,
   not being closed and not supervised;
4. when the account acted on is not the person's, the person holds
   `account:act_as` over it now.

Then the route's own rules run: file privacy and sharing, application-owned
files, tenancy, sensitive-operation limits, entitlements. An undeclared use is
`403` (`first_party_capability_not_declared`); a service token with no account
named acts as the service and reaches nobody's data.

A receiving product does nothing new: `OxyServer`'s `auth()` middleware asks
Oxy (`/internal/service-acting-as/verify`, with the caller's token and the
request's effect) and sets `req.userId` and
`req.serviceActingAs = { userId, authority: 'first_party', requesterId }`.

## What the person sees

Each use is counted per account, person, application, receiver, effect and day
in `first_party_delegation_activity` (nothing of the request is stored), kept
400 days, and listed by `GET /capabilities/first-party-activity`
(`oxy.apps.firstPartyActivity()`), which Accounts shows on its security screen.
Tool operations also keep their capability audit events.

## Third parties

Unchanged: OAuth scopes and consent, external delegation grants and ceilings,
MCP connection grants (`assets.withMcpMediaRequester`,
`assets.withMcpDocumentRequester`), customer API keys. An external token passing
through an Oxy backend stays external.

## Retiring

`withRequester`, `requesterToken`, tasks (`agency.createTask`,
`createTaskExecutionAuthorization`, `revokeTask`), foreground execution
authorizations, requester contexts and nested capability-ticket proofs remain
only until their last callers move to `actingFor` ([first-party tasks](first-party-tasks.md)
records them). `scripts/check-first-party-permission-vocabulary.mjs` keeps them
from spreading to a new file.
