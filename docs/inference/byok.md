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

Two principals, the same arrangement the routing policies use: a **user bearer**
through the account graph (`app:read`/`app:update`, `account:read`/`account:update`),
or a **service token** carrying `inference:providers:read` /
`inference:providers:write`, and only ever for its own application or that
application's owner account.

`inference:providers:write` is **staff-granted**, deliberately: it is the scope
whose misuse redirects other people's requests and the secrets used to serve
them. `inference:providers:read` is not.

**Another account's connection answers 404, never 403.** Distinguishing them
would make the id space an existence oracle for other tenants' BYOK setup.

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
