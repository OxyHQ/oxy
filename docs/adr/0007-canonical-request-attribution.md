# ADR 0007 — Every inference request carries account, application and credential; the delegated user is never the payer

- Status: accepted
- Date: 2026-08-15
- Issue: #972

## Context

Three attribution facts already exist in the repo, and they do not agree on who
a request belongs to.

- **The service token** carries `appId`, `appName`, `credentialId`, `scopes` and
  `environment` (`packages/api/src/routes/auth.ts:3663-3673`). It does **not**
  carry the owning account. A verifier holding only the token cannot name the
  financially responsible principal without a database lookup.
- **The delegation header** `X-Oxy-User-Id` is set by
  `makeServiceRequest` (`packages/core/src/mixins/OxyServices.auth.ts:734`) and
  read by the shared middleware (`packages/core/src/mixins/OxyServices.utility.ts:514`).
  It names an end user on whose behalf a service is acting.
- **The usage event** `api_key_usage_events` has `user_id` (`NOT NULL`,
  `packages/api/src/db/schema/apiKeyUsageEvents.ts:83`) and a nullable
  `application_id` (`:87`), and no account column at all. Its own comment calls
  `user_id` "the user the request is billed to".

So today the billed principal is a *user*, the authorization principal is an
*application*, and the account — the thing that actually owns applications
(`applications.owner_account_id`) and holds the balance — appears in neither.
Under delegation the two collapse in the worst possible direction: an Alia
request carrying `X-Oxy-User-Id` would attribute cost to the end user rather
than to Alia's own account.

## Decision

**Every accepted inference request resolves, at the Oxy edge and before anything
is forwarded, to exactly this tuple:**

```text
accountId       Oxy account that owns the workload and is financially responsible   REQUIRED
applicationId   Oxy Application consuming inference                                 REQUIRED
credentialId    Oxy ApplicationCredential used for this request                     REQUIRED
userId          delegated end-user identity                                         OPTIONAL
requestId       stable id for this request                                          REQUIRED
generationId    id for one generated output within a request                        OPTIONAL
```

### Required at edge admission

`accountId`, `applicationId` and `credentialId` are **resolved by Oxy, never
accepted from the request**. The resolution chain is fixed and has one direction:

```text
presented credential  →  application_credentials row   →  credentialId
                      →  .application_id               →  applicationId
                      →  applications.owner_account_id →  accountId
```

A request that cannot complete that chain is rejected at the edge with an
authentication error and is never forwarded. There is no fallback to "the
signed-in user's personal account", because that fallback is precisely how a
delegated call becomes a charge against the wrong party.

`requestId` is generated at the edge, on admission, before authorization — so a
rejected request is still traceable — and travels unchanged into the envelope,
into Relay, into the ledger and into the customer-visible receipt. It is the
correlation key named in workstream 16's observability requirements.

### Relay-generated

`generationId` identifies one generated output inside a request (an n>1
completion, one image in a batch, one segment of a stream that is settled
independently). Relay allocates it, because Relay is what knows how many outputs
a request produced. Oxy stores it as an opaque string on the receipt and exposes
it through `GET /v1/generations/:id`.

Relay does **not** allocate `requestId`. A data plane that mints the correlation
key cannot correlate a request it never received, and rejected-at-the-edge
requests are exactly the ones an operator most needs to find.

### A delegated `userId` is never the billing identity

`userId` is *attribution*, not *responsibility*. It answers "on whose behalf",
never "who pays". Concretely:

- The reservation, settlement and refund of ADR 0009 are keyed on `accountId`;
  `userId` never appears in a balance check or a ledger entry as the payer.
- Rate limits and budgets may be scoped by `userId` **in addition to** the
  account/application/credential scopes, never instead of them.
- `userId` is optional, and its absence is normal. A machine credential calling
  the API on its own behalf has no delegated user, and nothing may synthesize one.
- A present `userId` must be a real Oxy user id; it is not free-form tenant text.
  It is verified the same way `X-Oxy-User-Id` is verified today — the middleware
  resolves it, it is never trusted as an assertion.

Restated as the rule a reviewer applies: **if removing `userId` from a request
would change what any account is charged, the code is wrong.**

### Where the tuple must appear

- **The internal envelope** to Relay (ADR 0010) carries all six fields.
- **Telemetry** (`api_key_usage_events`, workstream 8) gains `account_id`,
  attributes to `application_credential_id` rather than the obsolete
  `api_key_id`, and records `request_id` and optional `generation_id`.
- **The financial receipt** (ADR 0009) carries `accountId`, `applicationId`,
  `credentialId`, `requestId` and, when applicable, `generationId`. It carries
  `userId` only as attribution metadata.
- **The service-token claim set** gains the owning account and the credential's
  effective scopes, or an equivalent locally resolvable envelope, so a verifier
  can name the responsible account without a lookup (workstream 2.2). The claim
  name `appId` is **not** renamed — `@oxyhq/core`'s service-token verification
  reads it.

## Alternatives rejected

**Attribute to the user and derive the account later.** This is the current
shape (`api_key_usage_events.user_id`). It is the cheapest change and it is
wrong at exactly the moment it matters: an organization-owned application called
by a member, or a first-party service acting for an end user, both resolve to a
person who never agreed to pay.

**Let the caller pass `accountId` for organization-scoped calls.** A caller-
supplied billing principal is a cross-account spend primitive. The credential
already determines the account; anything else is a request to charge someone
else.

**Skip `credentialId` and attribute only to the application.** Credential-level
attribution is what makes rotation, per-credential limits, per-environment
separation and "which key leaked" answerable. An application-only attribution
cannot distinguish a production key from a compromised development one.

## Consequences

- The account column is a schema change to telemetry and a required field on
  every new financial table; it is not a computed view, because the owning
  account of an application can change and a historical charge must keep the
  account it was billed to.
- Backfilling `account_id` onto existing `api_key_usage_events` rows is possible
  only through the application's *current* owner, which is not necessarily the
  owner at the time of the request. Rows that cannot be attributed truthfully are
  reported, not guessed.
- `requestId` must be generated before authentication completes, which means it
  cannot be derived from any authenticated identity.
- Tests must cover the negative direction, not only the positive: a delegated
  `userId` must not change which account is charged, and a request for an
  application the caller cannot access must fail before any reservation is taken.
