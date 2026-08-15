# Attribution: who pays, and on whose behalf

Every accepted inference request resolves to one tuple. This page is the
developer-facing reading of
[ADR 0007](../adr/0007-canonical-request-attribution.md), which is the decision
record and wins on any disagreement.

```text
accountId       the Oxy account that owns the workload and is charged     REQUIRED
applicationId   the Oxy Application consuming inference                   REQUIRED
credentialId    the Oxy ApplicationCredential used for this request       REQUIRED
userId          a delegated end-user identity                             OPTIONAL
requestId       stable id for this request, from admission onward         REQUIRED
generationId    one generated output within a request                     OPTIONAL
```

## You never send the first three

`accountId`, `applicationId` and `credentialId` are **resolved by Oxy from the
credential you presented, and are never accepted from the request.** The chain
has one direction and no branches:

```text
presented credential → application_credentials row → credentialId
                     → .application_id              → applicationId
                     → applications.owner_account_id → accountId
```

A request that cannot complete that chain is rejected before anything is
forwarded. There is deliberately **no** fallback to "the signed-in user's
personal account" — that fallback is precisely how a delegated call becomes a
charge against the wrong party.

Two consequences worth knowing before you design around it:

- **A caller-supplied `accountId` is a cross-account spend primitive**, so no
  endpoint will ever accept one. If you need an organization to be billed, the
  credential must belong to an application the organization owns.
- **The owning account is read live.** Transfer an application to another
  account and the next token names the new owner. A historical charge keeps the
  account it was billed to, because that is a fact about the past, not a join.

## `applicationId` is not enough on its own

Credential-level attribution is what makes rotation, per-credential limits,
per-environment separation and "which key leaked" answerable at all. An
application-only attribution cannot distinguish a production key from a
compromised development one — which is the exact question you have at 3am.

## A delegated `userId` is attribution, never responsibility

`X-Oxy-User-Id` names the end user a first-party service is acting for. It
answers *on whose behalf*, and it never answers *who pays*.

- Reservations, settlements and refunds are keyed on `accountId`. `userId` never
  appears in a balance check or as a ledger payer.
- Rate limits and budgets may be scoped by `userId` **in addition to** the
  account/application/credential scopes, never instead of them.
- Its absence is normal. A machine credential calling on its own behalf has no
  delegated user, and nothing synthesizes one.
- It must be a real Oxy user id, and the middleware resolves it against an
  explicit acting-as grant. It is never trusted as an assertion, and it is not
  free-form tenant text.

**The rule a reviewer applies:** if removing `X-Oxy-User-Id` from a request would
change what any account is charged, the code is wrong.

### How this is enforced rather than remembered

The substitution is a **type error**, not a review question
([#989](https://github.com/OxyHQ/oxy/pull/989), workstream 2.2). The billing
principal is exposed as an object while every user-identity accessor returns a
`string`, so passing a delegated user id where a payer is expected does not
compile:

```typescript
import {
  getOxyBillingPrincipal,   // OxyBillingPrincipal | null  — who is charged
  getOxyDelegatedUserId,    // string | null               — on whose behalf
  getOxyRequestAttribution, // both, as one object
} from '@oxyhq/core/server';
```

`getOxyBillingPrincipal` reads the service-token principal and nothing else —
never `req.userId`, `req.user` or the acting-as grant. `docs/SERVICE_TOKENS.md`
is the authoritative page for all three.

## `requestId` and `generationId`

`requestId` is generated at the Oxy edge **on admission, before authentication
completes** — so a rejected request is still traceable — and travels unchanged
into the envelope, the data plane, the ledger and the customer-visible receipt.
It is the single correlation key across all four.

The data plane does not mint it. A data plane that minted the correlation key
could not correlate a request it never received, and requests rejected at the
edge are exactly the ones an operator most needs to find.

`generationId` identifies one generated output *inside* a request — an `n>1`
completion, one image of a batch, one independently settled stream segment. The
data plane allocates it, because only the data plane knows how many outputs a
request produced. Oxy stores it as an opaque string on the receipt.

## Where the tuple shows up

| Surface | Carries |
|---|---|
| Verified service-token claims | `appId`, `appName`, `credentialId`, `ownerAccountId`, `environment`, effective scopes — and deliberately **no user claim** |
| `oxy_sk_…` machine credential lane | `applicationId`, `credentialId`, `ownerAccountId`, `environment`, effective scopes, on its own request property |
| Usage telemetry (`inference_usage_events`) | account, application, credential, `requestId`, optional `generationId`, units — and **no money column at all** |
| Financial receipt (`usage_receipts`) | account, application, credential, `requestId`, optional `generationId`; `userId` only as attribution metadata |

The machine-credential lane never populates the service-token request property,
and that separation is the security-relevant choice: a service credential's gate
is that only a platform-trusted application may hold one, and everything mounted
behind the service-auth middleware is written against that gate. Populating it
from a self-serve machine key would hand every third-party app the lane the gate
exists to protect.
