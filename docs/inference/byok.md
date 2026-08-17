# BYOK — bring your own provider credential

You register your own upstream provider credential; Oxy holds a **reference** to
it and the metadata around it, and hands the reference to the data plane at
serving time. The upstream provider bills your account directly; Oxy charges
only its platform fee.

**No deployment can accept a credential today.** Creating or rotating a
connection answers `503 provider_secret_store_unavailable`, and that refusal is
the design rather than an outage —
[ADR 0013](../adr/0013-byok-secret-custody.md) is the decision record.

Status of the whole platform: [README.md](./README.md).

---

## The refusal, and the order that makes it safe

```http
POST /inference/provider-connections/accounts/:accountId
→ 503  provider_secret_store_unavailable
```

A write runs three steps, in this order:

1. **Authorise.** A caller with no authority gets `403` or `404` — never a `503`
   that tells them what this deployment is configured with.
2. **Resolve the secret store.** With none configured, the request is refused
   HERE.
3. **Read the credential out of the body.**

Step 2 before step 3 is the whole point: in a deployment with no secret backend,
**a customer credential is never read out of a request at all**. Not parsed, not
held in a variable, not passed to a validator, not eligible to appear in a stack
trace.

### Why not store it in Postgres "for now"

That is the option that always looks reasonable and is the actual failure. A
column full of customer provider credentials is the highest-value target in the
database, the key to decrypt it has to live where the process can read it, and
"for now" outlives the person who wrote it. The alternative on offer — a runtime
secret-writing path — needs an IAM policy, a client dependency, a Dockerfile
change and a rehearsal against a real store, none of which can be validated from
this repository.

### What would wire it

Three things, together, per ADR 0013:

1. a store client (`@aws-sdk/client-secrets-manager`, or a Vault client) in
   `packages/api`'s dependencies **and** in the Dockerfile's lean workspace
   install;
2. an IAM policy on the ECS task role scoped to the partition prefix
   `oxy/inference/byok/<environment>/<accountId>/<connectionId>` — the account
   and environment are in the path precisely so that policy is expressible;
3. `INFERENCE_PROVIDER_SECRET_STORE` set to that backend's name in the task
   definition. It names a STORE, not a credential, so it is a plain environment
   variable rather than an SSM parameter.

Setting the variable alone moves the refusal from `not-configured` to
`backend-missing`; it does not remove it. The metadata side, the routes, the
audit trail and the scope enforcement are complete and tested without any of
this.

---

## What Oxy stores, and what it cannot

`providerConnectionSchema` in `@oxyhq/contracts` is `.strict()`, so a producer
that attaches `apiKey`, `secret`, `token`, `privateKey` or `headers` **fails the
parse**. Nothing is silently stripped — a stripped field is one that still
existed upstream of the parse, in a log line or an error report.

| Field | Is |
|---|---|
| `secretRef` | `<store>:<locator>` — a pointer into managed secret storage, never material |
| `keyPrefix` | the leading characters, capped at **12** — long enough to tell two keys apart, far too short to be one |
| `fingerprint` | SHA-256 of the credential, so a rotation is verifiable without the key |
| `scope` | `account`, `project` or `application` |
| `environment` | `development`, `staging` or `production` |
| `status` | `active`, `disabled` (reversible) or `revoked` (terminal) |
| `validation` | `unvalidated`, `valid`, `invalid` or `expired`, plus a closed failure code |
| `upstreamBillsCustomerDirectly` | literally `true` — stated as data so a receipt is readable without a second lookup |
| `termsAcknowledged…` | set where a provider's terms require a per-customer acknowledgement |

A credential that transits the process at all does so inside a wrapper whose
`toString`, `toJSON` and `util.inspect` all return `[redacted provider secret]`.
So a template literal, a `JSON.stringify`, a log field and a REPL dump all print
the marker; there is one greppable accessor for the bytes, called in exactly two
places.

### Scope means inheritance, not a separate id space

In the unified account graph a project IS an account, so:

- an **account** connection is inherited by every descendant project and
  application;
- a **project** connection applies to that project account alone;
- an **application** connection applies to one application.

Recording which you chose is what makes "why did this app use that key"
answerable later.

---

## The endpoints

Mounted at `/inference/provider-connections`.

| Endpoint | Today |
|---|---|
| `GET /accounts/:accountId`, `GET /applications/:applicationId`, `GET /:connectionId` | work — they return metadata, and there is none until a create succeeds |
| `POST /accounts/:accountId`, `POST /applications/:applicationId` | **503** — they would read a credential |
| `POST /:connectionId/rotate` | **503** — same |
| `POST /:connectionId/disable`, `/enable`, `/revoke` | work — no credential is read |
| `POST /:connectionId/validation` | works — it RECORDS a verdict, it does not perform one |
| `GET /:connectionId/audit` | works |

---

## BYOK management is a high-privilege operation, and here is where that is enforced

Five independent things hold it, on both lanes. None of them is the whole answer;
listing them together is the point, because each one alone has a way around it.

### 1. The scope is staff-granted, not self-grantable

`inference:providers:write` is in `PRIVILEGED_APPLICATION_SCOPES`
(`packages/api/src/utils/applicationScopes.ts`): it is the one scope whose misuse
redirects other people's requests **and** the secrets used to serve them.
`inference:providers:read` is deliberately not — describing where a request would
go is not deciding it.

`authorizeRequestedScopes` in `packages/api/src/routes/applications.ts` enforces
that on application create and `PATCH /:appId`, and it is SYMMETRIC: a non-staff
caller can neither add a privileged scope nor silently drop one, because revoking
a privileged scope is a staff mutation too and an omission is treated as "leave it
alone".

### 2. A member may not put a privileged scope on a new credential

The filter runs on `POST /applications/:appId/credentials`. Without it, an
application legitimately holding a staff-granted scope was a scope any member with
`credentials:create` could mint themselves a credential for — and the `developer`
role holds `credentials:create` while holding no BYOK write at all.

It used to run on `POST /accounts/:id/credentials` too. That route is **gone**:
`account_credentials` was retired by #972 workstream 2.3
(`packages/api/drizzle/0048_retire_account_credentials.sql`) because nothing ever
authenticated against it. `POST /applications/:appId/credentials` is now the only
place a customer credential is minted, which is the point of ADR 0005
invariant 3 — one filter, because there is one lifecycle to filter.

### 3. A credential's scopes can never exceed its application's

Checked as a subset at create, and intersected again at every service-token mint
(`intersectScopes`). So a credential is bounded by the application, and the
application is bounded by staff.

### 4. A service credential may not write here AT ALL

This is the load-bearing one, and it is the same answer
`packages/api/src/routes/accountBilling.ts` gives on the financially equivalent
surface. Registering, rotating or destroying a provider credential is a decision a
person makes; a machine credential that could make it would put an account's
provider configuration behind a key that lives in a deployment environment.

It has to be a refusal of the LANE rather than a stronger check at mint time,
because the first three are not sufficient on their own:
`POST /applications/:appId/credentials/:credId/rotate` copies the previous
credential's scopes forward verbatim and returns a fresh secret exactly once, and
`credentials:rotate` is a `developer` permission. So one staff-granted credential
was enough for a member without `inference:providers:write` to obtain a working
token that carried it. Requiring the *minting* member to hold the permission would
not have closed it either — a credential outlives the membership.

The reads are untouched: the same credential still lists connections, resolves the
one in force for its application, and reads the audit trail.

### 5. On the user lane, BYOK is its own permission

`inference:providers:read` / `inference:providers:write` on the account lane and
`inference:byok:read` / `inference:byok:write` on the application lane
(`packages/api/src/utils/accountRoles.ts`). These replaced
`account:read`/`account:update` and `app:read`/`app:update`, and the change is a
narrowing on purpose:

| Role | Before | Now |
|---|---|---|
| `owner`, `admin` | read + write | read + write |
| `editor` | read + **write** (via `app:update`) | read only |
| `developer` | read | read |
| `billing` | read (via `account:read`) | neither |
| `viewer` | read (via `account:read`) | neither |

`app:update` used to confer "publish an OTA update", "change the webhook URL" AND
"rotate the provider secret" as one string, so an account that wanted an editor
who could edit an application but not touch its BYOK had no way to say so. And
BYOK read was inherited from `account:read`, which **every** role holds — no
credential material is ever returned, but the provider, the key prefix, the
fingerprint and the validation failures are, which is security configuration
rather than an app description.

Every one of those withdrawals is restorable for an individual member through
`permission_grants`. That is the point of naming the power rather than borrowing
somebody else's.

### The one thing this forecloses

`POST /:connectionId/validation` is inside the refusal, so **the data plane
cannot report a verdict today**. That is deliberate rather than overlooked: an
`invalid` verdict also disables the connection, so leaving the lane open for it
would have left a disable-equivalent open to exactly the credential the refusal
exists to stop. Nothing calls the route today, and no connection can exist at all
while create and rotate are hard-`503`. When the data plane does need to report
one it needs a principal designed for it — an internal lane, not a
customer-mintable service token.

---

**Another account's connection answers 404, never 403.** Distinguishing them
would make the id space an existence oracle for other tenants' BYOK setup. The
service-lane write refusal is a 403 for every id alike, existing or not, so it
adds no oracle of its own.

### Validation is recorded here, never performed here

`POST /:connectionId/validation` takes a verdict from a closed vocabulary — no
free-form message, so a verdict can never carry credential material — and writes
it. Oxy cannot check a credential it does not hold, and the interface to the
secret store is deliberately **write-and-destroy with no read**: an interface
that offered a `get` would make "just re-validate it here" a one-line change.
Whoever holds the secret at use time validates it; Oxy records the answer.

An `invalid` or `expired` verdict also disables the connection.

### The audit trail

`created`, `validated`, `rotated`, `used`, `disabled`, `enabled`, `revoked`,
kept for **two years** and append-only in the database rather than by convention
(a migration installs the immutability trigger). A `used` event never carries an
actor user id — nobody was present.

---

## Limits, and the things BYOK does not change

- **BYOK does not move the billing relationship.** Your provider bills your own
  upstream account. Oxy settles its platform fee, and the receipt says so:
  `platformFeeOnly: true`, so `billedAmount` reads as a fee rather than the cost
  of the tokens. No BYOK request has produced a receipt, because no request
  reaches a provider at all.
- **BYOK does not override provider terms**, and registering a connection is not
  a licence to share credentials. Where a provider requires a per-customer
  acknowledgement, the connection records that you gave one.
- **A routing policy may prefer or require BYOK** (`byokPreference`), and that
  preference IS applied to the candidate routes: a policy requiring BYOK will not
  be served by a route that is not one, and a request no route satisfies is
  refused with `policy_violation` rather than served on Oxy's own account. See
  [routing.md](./routing.md#what-is-enforced-today).
- **`oxyHostedOnly` and `byokPreference: 'require'` cannot both be set.** A BYOK
  route runs on your upstream account, which is by definition not Oxy's hosting;
  the combination is refused at write time rather than resolved by whichever
  field an executor reads first.
- **Revocation is terminal, and it never refuses.** `disabled` is the reversible
  state; a revoked connection can no longer be validated, enabled or rotated.
  Unlike create and rotate, revoke treats the secret store as OPTIONAL — a
  deployment whose backend has since been unconfigured must still be able to
  retire a connection, often because the key leaked. The response and the audit
  row both state whether the secret was actually destroyed
  (`secretDestroyed`), which is the true statement; refusing the revoke would
  leave the connection resolvable. The row is not deleted — it is the audit link
  between a rotated credential and the one it replaced.
