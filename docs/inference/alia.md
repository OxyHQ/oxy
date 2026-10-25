# Alia as a consumer of the Oxy inference platform

Issue [#972](https://github.com/OxyHQ/oxy/issues/972) workstream 14, **the Oxy
half**. The Alia-side counterpart is
[OxyHQ/Alia#139](https://github.com/OxyHQ/Alia/issues/139) and is not described
here.

Concepts: [developer guide](./README.md). Status of the whole picture: [status.md](./status.md). This page records source
and the operating contract, not a successful production rollout. A dry-run that
reports drift is diagnostic evidence only: it provisions nothing and must not be
reported as completion. The workflow result, exact live task/image and
post-apply readback are the authority for what production has accepted.

---

## What Alia is, on this platform

An ordinary consumer, with three things that make it a first-party one:

| | |
|---|---|
| Registered as | an `internal` Oxy `Application` named `Alia` |
| Owned by | the `alia-production-chat` project account, under the platform owner |
| Authenticates with | attested workload service tokens, with an explicit registered environment and no static key fallback |
| Spends | the balance of its OWNER account, never a delegated end user's |
| Booked to | the `alia-production-chat` cost centre |

The declaration is `packages/api/src/scripts/seedOxyApplicationsSpecs.ts`, held
by `packages/api/src/scripts/__tests__/seedOxyApplicationsSpecs.test.ts`.

### Alia is internal; route availability is platform-wide

`resolveCatalogueViewer` grants the `platform_internal` availability scope to
staff-controlled `first_party`, `internal` and `system` applications. This is
the commercial boundary for reviewed routes that official Oxy products may use
without claiming public resale rights. Third-party applications and plain user
bearers see only the public scopes.

Alia remains `internal` because rollout and canary gates distinguish the agent
runtime from customer-facing official products. That classification no longer
names or owns a provider route: Kaana is the inference data plane, and Inbox or
another official product can consume the same reviewed platform route directly
through Oxy without pretending to be Alia.

### Which models Alia offers, and how it names them

**Decided, rolling out:** Alia shows its users **power levels** (`auto`,
`instant`, `medium`, `high`, `xhigh`, `pro`, `ultra`), never model names, and
sends the chosen level as the request's routing profile. The Alia application's
policy limits which levels it may use. Alia does not retry, fail over or swap
models itself; Kaana does that along the routes Oxy signed
([guide](./README.md#when-a-request-fails)). Until the levels ship, the
behaviour below is what `main` does.

**Live on `main`:**

Every model the Kaana catalogue sync has written for `platform_internal`
([catalogue.md](./catalogue.md#automatic-sync-from-kaana), ADR 0027) — no
hand-curated list. Alia reads `GET /v1/models` with its workload identity, shows the entries, and sends:

- `model`: the entry's `modelId` (`publisher/model`), never a routing profile.
  With no routing policy of its own, the `Alia` application is served under
  `platform-internal-default@1`, which ranks the model's routes by list price.
  If an operator ever gives Alia's application a policy, it must optimise for
  `price` while synced routes carry no measured scores, or every synced model
  refuses with `routing_evidence:missing-score`.
- `reasoning: { effort }` only when the entry's
  `capabilities.reasoningEfforts` lists that effort; anything else is a 400.

The seven Alia text presets (`kaana-lite`, `kaana-v1-codea`, `-cowork`,
`-browser`, `-pro`, `-thinking`, `-pro-max`) are no longer seeded. Their existing
rows are not deleted by this change; remove them once no Alia release references
them. Speech is unchanged: Alia still pins the reviewed `kaana-v1-speech`
profile (`cc2471c8-807e-46ec-b5da-b6f3b39d2db5`) over the reviewed xAI route,
because the sync does not write non-text-output models. Under Alia's
`internal_metered` pilot, speech answers to the pilot's own speech terms
(15,000 characters, that route only, USD 0.25) —
[internal-metering.md](./internal-metering.md#speech-synthesis-2026-10-15).

### Own authority and domain boundaries

Alia's own workload does not request inference scopes, application grants or
per-app enablement levels. Its verified binding identifies the product,
environment and billing owner. Requester, effective account and bot actor stay
explicit for user work, including deferred tasks and nested agents. Existing
receipt ownership, spending policy, commercial route availability and privileged
operator checks still apply; scope-less identity does not remove them.

Provider credentials remain in Kaana. External customer credentials and OAuth
connections retain their explicit scopes and revocable grants. See
[ADR 0049](../adr/0049-first-party-platform-authority.md).

### Native product-agent identities

Sindi and Clarity are product agents hosted by Alia, not free-standing inference
clients and not public agents. Oxy's internal bootstrap reconciles these opaque
primary keys byte for byte; runtimes must not trim, normalize, discover by
display name, take the first list result or substitute a fallback.

| Product agent | Project account | Bot account | Alia agent | Bound service app | Backend workload (ADR 0026) | Retired service credential |
|---|---|---|---|---|---|---|
| Sindi / Homiio | `6a50444ce8026582b949089d` | `01a0646a-078f-7974-9645-a5e8be237f47` | `01a0646a-078f-7514-9800-9f43ceed7df8` | `6a2f851751b784a86fd0e922` | `oxy-homiio-task` | `01a0648e-ad3f-7608-aa8b-c07bfef6cf73` |
| Clarity | `01a0646a-078f-7f53-848d-a0f82d9f7fa6` | `01a0646a-078f-7120-a993-a03c180c81b0` | `01a0646a-078f-7642-95ef-439952f4f3f9` | `01a0648b-8d73-70ad-8e67-1c07ddc5eb6e` | `oxy-clarity-task` | `01a0648b-8d74-7240-adba-80707fdfdf9c` |

Each agent's `oxyAccountId` is its exact bot-account primary key, and each
service application is owned by the corresponding project account so billing
lands on that product. A client cannot create or rebind these relationships
through the public agent API.

`aliaNativeAgentBootstrapManifest()` also publishes each agent's
`capabilityGrants` — Alia's own vocabulary, carried here because a capability
grant is an authority and this manifest is the hashed channel both repositories
review. Sindi's grant is exactly `web`, `artifacts`, `memory`, in that order;
Clarity's is empty, which DENIES everything rather than meaning unset. Neither
carries anything that acts in the world (shell, browser, files, messaging,
automation, delegation) and neither carries a connector: Oxy app access is not
expressible in that vocabulary at all, and own Oxy operations use the shared task/execution authority with live
account and resource checks. External connections retain their separate grants.

Homiio's project row predates this bootstrap and is adopted by its exact
primary key. Bootstrap verifies its username, account kind, hierarchy, status
and privacy fields byte for byte; it never renames or replaces the existing
project to resolve an identity collision.

Clarity's public sign-in application remains separate:
`01a0646a-2382-74a3-a795-788924d55722`. Its agent is bound to the backend
service application above. Each backend authenticates through its registered
workload identity and environment; legacy scope lists are not own authority.
The retired service credentials above are not a fallback. A signed-in person
reaches a product agent through the shared requester transport, preserving the
original requester and effective account; a workload alone cannot invent one.

These Oxy application identities identify product services. They are not
provider keys. Provider keys exist only encrypted in Kaana's PostgreSQL/KMS
custody, and Kaana's only canonical signed origin is `https://kaana.ai`.

---

## Delegated end users never pay

Alia passes the end user it is acting for as `X-Oxy-User-Id`. That identity is
**attribution only** and this holds structurally rather than by convention, so
there is nothing for this integration to configure:

- `ServiceTokenPayload` (`packages/api/src/middleware/serviceToken.ts`) carries
  `appId`, `credentialId`, `ownerAccountId`, `environment` and an explicit
  authority lane. Only external authority carries scopes. A
  delegated user is deliberately **absent from the type** — a field on that
  payload is exactly what code reaches for when it wants "who is responsible for
  this request".
- The edge reads the header in `delegatedUserId` (`packages/api/src/routes/inferenceEdge.ts`)
  into a field the billing principal cannot be confused with:
  `billingPrincipalSchema` is `.strict()` and holds one differently-branded
  field.
- This inference attribution does not authorize access to the named person's
  Files or other resources. Those operations require shared requester proof
  and live account/resource authorization; a raw user-id header is insufficient.

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
Own Alia workloads use their verified platform authority; external credentials
retain the endpoint's scope requirement.

A SERVICE principal is authorised when **all three** hold
(`authorizeAccount`, `packages/api/src/routes/accountBilling.ts`):

1. the operation is a read — there is no write lane for a service credential on
   this surface at all;
2. the principal is a verified own workload, or its external credential carries
   `inference:usage:read`;
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
ref:           main
only_app_ids:  6a2f851751b784a86fd0e934
dry_run:       true      ← then false
```

Review the exact application and billing owner against the current registry
before applying. Application credential ceilings can still serve external
customers under that application; they are not own workload permissions and
must not be erased as part of this migration.

### 3. Verify workload identity and recipient readiness

Use the registered backend task role, active binding and explicit environment.
Alia and its integrations process have separate workload identities. The shared
AWS provider also accepts temporary local/SSO credentials where the registered
identity permits them; no static API-key fallback is part of the own contract.

Follow the [migration ledger](../architecture/first-party-integration-migration.md)
for receiver-before-producer deployment, live source/image receipts and bounded
credential retirement. Stage A alone does not satisfy every event receiver;
verify the actual caller-to-recipient edge before cutting over its producer.

The former instructions here to mint three environment secrets and union an
Alia scope list are retired. Do not recreate those keys. Existing external
customer credentials remain external and follow their independent lifecycle.

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
- **Alia switching from presets to model ids.** Alia must stop sending the
  retired preset profile IDs and send `model` (+ `reasoning.effort`) from the
  synced catalogue, on `@oxy.so/core` 1.8.0 / `@oxy.so/contracts` 1.4.0. Until
  then the preset rows that already exist keep serving.
- **Alia actually invoking Oxy inference.** The edge, Kaana runtime and reviewed
  bootstrap exist in merged source, but bootstrap application, live
  audience gates, canonical Kaana configuration and a real signed canary still require production
  evidence (see [status.md](./status.md)). The
  registration, scopes, credentials, cost centres and entitlement interface do
  not prove that Alia has made that production call.
