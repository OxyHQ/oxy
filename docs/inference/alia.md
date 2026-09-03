# Alia as a consumer of the Oxy inference platform

Issue [#972](https://github.com/OxyHQ/oxy/issues/972) workstream 14, **the Oxy
half**. The Alia-side counterpart is
[OxyHQ/Alia#139](https://github.com/OxyHQ/Alia/issues/139) and is not described
here.

Status of the whole picture: [README.md](./README.md). **Nothing on this page has
been run against production.** It is the code and the runbook; the runs are
operational steps a person takes, in the order below.

---

## What Alia is, on this platform

An ordinary consumer, with three things that make it a first-party one:

| | |
|---|---|
| Registered as | an `internal` Oxy `Application` named `Alia` |
| Owned by | the `alia-production-chat` project account, under the platform owner |
| Authenticates with | native service tokens (`clientId + clientSecret` → 1h JWT), one credential per environment |
| Spends | the balance of its OWNER account, never a delegated end user's |
| Booked to | the `alia-production-chat` cost centre |

The declaration is `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`, held
by `packages/api/src/scripts/__tests__/seedOxyApplicationsSpecs.test.ts`.

### `internal`, not `first_party` — this is load-bearing

`resolveCatalogueViewer` (`packages/api/src/services/inferenceCatalogue.service.ts`)
grants the `internal_alia` availability scope to `internal` and `system`
applications only, and excludes `first_party` deliberately: Console and Accounts
are first-party and customer-facing, so handing that type the internal audience
would put internal-only routes in front of customers.

Registered as `first_party`, Alia is a **public catalogue viewer** — it cannot be
routed to the very deployments whose availability scope is named after it, and
the symptom is a model quietly not being offered rather than an error.

Nothing else narrows as a result. `isTrustedApplication()` accepts `internal`
exactly as it accepts `first_party`, so the credentialed CORS lane, OAuth consent
auto-approval, service-credential creation and the sign-in dialog are unchanged.

### Scopes: what Alia holds, and what it does not

Alia is a **consumer** of the inference platform, not an operator of it. That
sentence decides the whole list.

| Scope | Held | Why |
|---|---|---|
| `user:read` | yes | The baseline every official application holds. |
| `inference:invoke` | yes | Alia serves chat. This is the scope that spends the owner account's balance. |
| `inference:models:read` | yes | Alia renders a model picker and resolves a model reference before invoking one. |
| `inference:usage:read` | yes | Required by `GET /billing/accounts/:accountId/entitlements` for a service principal, and by the per-application usage reports. Both are Alia's own records. |
| `inference:routing:read` | yes | Alia has to be able to say WHICH routing profile served a request when a user reports a slow or wrong answer. |
| `inference:routing:write` | **no** | Staff-gated. Routing profiles are catalogue objects the platform serves every tenant from; holding this would let Alia repoint traffic that is not its own. Being first-party is not an argument for it — the reason the scope is privileged is that the object is *shared*, and Alia is one tenant of it. Routing policy for Alia's traffic is set by Oxy on Alia's behalf, through the staff surface, exactly as for every other consumer. |
| `inference:providers:write` | **no** | Staff-gated, and the most consequential scope in the family: it manages provider connections, BYOK credentials included. Alia neither holds nor rotates provider secrets under this integration — that is precisely the responsibility this workstream moves *off* Alia. Granting it would re-create the thing being removed. |
| `inference:providers:read` | **no** | Not privileged, and withheld anyway because Alia has no use for it. The one provider fact Alia surfaces is which provider served a request, and the edge already returns that as `X-Oxy-Provider`. A scope granted "in case" is authority nobody re-examines; this one is self-grantable and can be added the day a surface needs it, with no staff round trip. |

Nothing outside the `inference:*` family and `user:read` is granted. Alia is not
a federation peer, does not move reputation, writes no signals, sends no
notifications and touches no follow graph.

### Native product-agent identities

Sindi and Clarity are product agents hosted by Alia, not free-standing inference
clients and not public agents. Oxy's internal bootstrap reconciles these opaque
primary keys byte for byte; runtimes must not trim, normalize, discover by
display name, take the first list result or substitute a fallback.

| Product agent | Project account | Bot account | Alia agent | Bound service app | Service credential |
|---|---|---|---|---|---|
| Sindi / Homiio | `01a0646a-078f-72ea-8759-86326484a7e0` | `01a0646a-078f-7974-9645-a5e8be237f47` | `01a0646a-078f-7514-9800-9f43ceed7df8` | `6a2f851751b784a86fd0e922` | `01a0648e-ad3f-7608-aa8b-c07bfef6cf73` |
| Clarity | `01a0646a-078f-7f53-848d-a0f82d9f7fa6` | `01a0646a-078f-7120-a993-a03c180c81b0` | `01a0646a-078f-7642-95ef-439952f4f3f9` | `01a0648b-8d73-70ad-8e67-1c07ddc5eb6e` | `01a0648b-8d74-7240-adba-80707fdfdf9c` |

Each agent's `oxyAccountId` is its exact bot-account primary key, and each
service application is owned by the corresponding project account so billing
lands on that product. Sindi's capability grant is exactly `web`; Clarity's is
exactly `web`, `artifacts`, and `memory`. A client cannot create or rebind these
relationships through the public agent API.

Clarity's public sign-in application remains separate:
`01a0646a-2382-74a3-a795-788924d55722`, with only `user:read`. Its agent is bound
to the backend service application above, whose exact scopes are `user:read`
and `inference:invoke`. Sindi's bound service credential has exactly
`inference:invoke` and `acting-as:offline`. The products authenticate with those
Oxy service credentials and delegate the verified human through
`X-Oxy-User-Id`; a human bearer is never forwarded to Alia.

These Oxy application credentials identify product services. They are not
provider keys. Provider keys exist only encrypted in Kaana's PostgreSQL/KMS
custody, and Kaana's only canonical signed origin is `https://kaana.ai`.

---

## Delegated end users never pay

Alia passes the end user it is acting for as `X-Oxy-User-Id`. That identity is
**attribution only** and this holds structurally rather than by convention, so
there is nothing for this integration to configure:

- `ServiceTokenPayload` (`packages/api/src/middleware/serviceToken.ts`) carries
  `appId`, `credentialId`, `ownerAccountId`, `environment` and `scopes`. A
  delegated user is deliberately **absent from the type** — a field on that
  payload is exactly what code reaches for when it wants "who is responsible for
  this request".
- The edge reads the header in `delegatedUserId` (`packages/api/src/routes/inferenceEdge.ts`)
  into a field the billing principal cannot be confused with:
  `billingPrincipalSchema` is `.strict()` and holds one differently-branded
  field.
- `resolveViewerId` (`packages/api/src/middleware/optionalAuth.ts`) honours the
  header only for a SERVICE token. On a user bearer it is ignored, so a user
  cannot impersonate another by sending it.

ADR [0007](../adr/0007-canonical-request-attribution.md) is the rule;
[#989](https://github.com/OxyHQ/oxy/pull/989) made it structural. For Alia's
configuration specifically: the billing identity is
`applications.owner_account_id` of the `Alia` application, i.e. the
`alia-production-chat` account, resolved server-side at mint time from the
presented credential — never anything in the request body or headers.

---

## Cost centres

Registered by `packages/api/scripts/seed-internal-cost-centers.ts` from
`packages/api/src/scripts/internalCostCenterSpecs.ts`:

| Slug | Label | Booked from |
|---|---|---|
| `alia-production-chat` | Alia production chat | the `Alia` application |
| `codea` | Codea | — no application owned by it yet |
| `alia-research` | Alia research | — no application owned by it yet |
| `alia-voice` | Alia voice | — no application owned by it yet |
| `alia-evaluations` | Alia evaluations | — no application owned by it yet |

**A cost centre is an account, not a parallel hierarchy.** The schema
(`packages/api/src/db/schema/internalCostCenters.ts`) labels an existing account;
attribution is `applications.owner_account_id` walked up `user_ancestors` to the
nearest labelled account (`resolveCostCenterForAccount`). Two consequences
follow, and neither is optional:

1. Seeding a centre means minting a real `project` account under the platform
   owner. The slug IS that account's username, so the two identifiers cannot
   drift.
2. **Two workloads can only be told apart in the report if their applications
   have different owner accounts.** This is why the `Alia` application is owned
   by `alia-production-chat` rather than by the root `oxy` account every other
   official app shares — with a shared owner, `GET /billing/cost-centers/spend`
   would report one number where five are expected, and nothing would error.

The four centres with no application yet are registered ahead of the workloads
that will book to them, deliberately: a centre that only exists after a second
round trip blocks the workload rather than the reverse. Until an application is
owned by one of those accounts their spend is legitimately zero, which is a real
reading of the report rather than a gap in it.

The centres are flat siblings, not nested under an intermediate "Alia"
organization. A centre that is an *ancestor* of another absorbs the spend of
anything owned directly by it, because the nearest-ancestor walk cannot
distinguish "owned by the parent" from "owned by a child with no centre of its
own".

---

## The entitlement/billing API Alia consumes

`GET /billing/accounts/:accountId/entitlements` — built by
[#1005](https://github.com/OxyHQ/oxy/pull/1005) (workstream 7.5), served by
`resolveProductEntitlement` in `packages/api/src/services/entitlement.service.ts`.
Nothing was added for Alia; what it needed was the scope to reach it.

A SERVICE principal is authorised when **all three** hold
(`authorizeAccount`, `packages/api/src/routes/accountBilling.ts`):

1. the operation is a read — there is no write lane for a service credential on
   this surface at all;
2. the credential carries `inference:usage:read`;
3. `ownerAccountId` on the verified token equals the `accountId` in the path.

So Alia reads its OWN owner account and nothing else, and the account id in the
path is checked against a claim resolved server-side rather than against anything
the caller asserts.

The response keeps the two kinds of number apart, which is the failure #972 §7.5
names outright: `plan` + `allowances` are whole integer counts of a product
entitlement; `payAsYouGo` is exact decimal money. Nothing sums them.
`payAsYouGo: null` is a real state distinct from a zero balance — "nobody has
decided who pays for this account yet" rather than "spent everything".

---

## Runbook

Ordering matters: the application seed refuses to register `Alia` until its owner
account exists. Every step is `dry_run=true` first — read the plan, then re-run.

### 1. Mint the cost-centre accounts

Workflow **Seed internal cost centres** (`.github/workflows/seed-internal-cost-centers.yml`),
a Fargate one-shot against the live task definition.

```
ref:                main
only_cost_centers:  alia-production-chat,codea,alia-research,alia-voice,alia-evaluations
dry_run:            true      ← then false
```

The dry run reports every field it would write and a not-yet-minted account as
`(project account minted by this run)`. The real run prints
`OXY_COST_CENTER_MAPPING_JSON=` with each centre's account id.

Verify: `GET /billing/cost-centers` (staff bearer) returns five active centres.

### 2. Reconcile the Alia application

Workflow **Seed Oxy applications** (`.github/workflows/seed-oxy-applications.yml`).

```
ref:        main
only_apps:  Alia
dry_run:    true      ← then false
```

The plan should show `type: first_party → internal`, `isInternal: false → true`,
`ownerAccountId: <oxy> → <alia-production-chat account id>` and the scope union.
If it instead FAILS naming a missing account, step 1 has not run.

The seed UNIONs scopes rather than replacing them, so a scope granted
out-of-band survives. Removing one is a deliberate operation on the application
record, never a side effect of a re-run.

Verify: `OXY_APP_MAPPING_JSON=` in the output carries
`"type":"internal"` and an `ownerAccountId` equal to the account from step 1.

### 3. Mint one service credential per environment

`packages/api/scripts/create-service-credential.ts`, run as an ECS one-shot in
the same shape as the workflows above — **one run per environment**, so each run
emits exactly one secret and a secret bound for one deployment environment is
never sitting in the same output as the two that must not be.

```
APP_NAME=Alia
SCOPES=user:read,inference:invoke,inference:models:read,inference:usage:read,inference:routing:read
ENVIRONMENT=development | staging | production
OUTPUT_ENCRYPTION_KEY=<32 random bytes, hex — generated by the operator, never committed>
DRY_RUN=true      ← then false
```

The plaintext secret is never logged: it is AES-256-GCM encrypted with
`OUTPUT_ENCRYPTION_KEY` and emitted as `SERVICE_CRED_JSON=`, useless to anyone
without the key. Decrypt out of band. Re-running against an environment that
already has a usable credential REUSES it and emits no secret — the existing one
is not recoverable, only its hash is stored, so a fresh secret means a rotation.

**`service`, not `machine`.** The `oxy_sk_*` machine lane exists so external
developers can use a standard OpenAI SDK without implementing a token exchange;
it authenticates on no route today. Alia is a platform-trusted first-party
service and takes the native lane, which is the one that works.

The credential's scopes are intersected with the application's at every mint
(`intersectScopes`), so step 2 must have landed or the intersection drops them.

### 4. Hand the credentials over

Three `clientId` + `clientSecret` pairs go to the Alia deployment environments as
secrets. **Not Oxy's step** past this point: how Alia stores them is
[OxyHQ/Alia#139](https://github.com/OxyHQ/Alia/issues/139). Never commit one, and
never register a GitHub secret with a placeholder value.

---

## Remaining work

- **Production point-inference routing.** The static Oxy-to-Alia infrastructure
  proxy and its voice mounts are removed. Inbox's five point-inference features
  and its two background classifiers now use Oxy-to-Kaana. Production remains
  fail-closed until the catalogue bootstrap creates a routing profile and its
  exact primary key is configured; see
  [inbox-point-inference.md](./inbox-point-inference.md).
- **Alia voice remains an Alia product capability.** Published Alia SDK clients
  address Alia directly rather than traversing an Oxy infrastructure proxy. Moving a
  route somebody's client calls is a compatibility change that needs a
  deprecation notice addressed to named callers, and the `alia-voice` cost centre
  above is about the spend of a voice workload, not about where its HTTP surface
  is mounted.
- **Deprecating Alia-owned developer keys and provider billing.** Cross-repo, and
  the Alia side owns the decommission. Oxy's half is the registration above:
  until Alia's own key and provider accounts are retired *there*, nothing here
  can assert it.
- **The four cost centres with no application.** Codea, research, voice and
  evaluations are registered and addressable; the applications that will be owned
  by them are Alia-side surfaces whose registration belongs with whoever ships
  them. Registering four more applications now would mint four sets of
  credentials nobody has asked for.
- **Alia actually invoking Oxy inference.** There is no public inference edge and
  the model catalogue is empty (see [README.md](./README.md)). The registration,
  the scopes, the credentials, the cost centres and the entitlement interface are
  all in place ahead of a data plane to call.
